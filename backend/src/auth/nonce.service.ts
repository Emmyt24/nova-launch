import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { AUTH_CONSTANTS } from "./auth.constants";
import { NonceResponseDto } from "./auth.dto";

const NONCE_TTL_SECONDS = Math.ceil(AUTH_CONSTANTS.NONCE_EXPIRY_MS / 1000); // 300s
const NONCE_KEY_PREFIX = "nonce:";

/**
 * Lua script for atomic check-and-consume of a nonce.
 *
 * Return codes:
 *   1  – success (nonce consumed)
 *  -1  – nonce not found (expired or never issued)
 *  -2  – nonce already used
 *  -3  – public key mismatch
 */
const CONSUME_NONCE_SCRIPT = `
local val = redis.call('GET', KEYS[1])
if not val then return -1 end
local entry = cjson.decode(val)
if entry.used then return -2 end
if entry.publicKey ~= ARGV[1] then return -3 end
entry.used = true
redis.call('SET', KEYS[1], cjson.encode(entry), 'KEEPTTL')
return 1
`;

interface NonceEntry {
  publicKey: string;
  expiresAt: number;
  used: boolean;
}

@Injectable()
export class NonceService implements OnModuleDestroy {
  private readonly logger = new Logger(NonceService.name);
  private readonly redis: Redis;
  private cleanupInterval: NodeJS.Timeout;

  constructor(redisClient?: Redis) {
    this.redis =
      redisClient ??
      new Redis({
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD,
        lazyConnect: true,
      });

    // Safety-net cleanup: scan for any nonce keys whose TTL has already fired
    // but whose entries were somehow not evicted (e.g., Redis maxmemory policy
    // set to noeviction). In normal operation Redis TTL handles eviction.
    this.cleanupInterval = setInterval(() => this.cleanupUsedNonces(), 60_000);
  }

  /**
   * Generates a one-time nonce for the given public key and stores it in
   * Redis with a TTL equal to NONCE_EXPIRY_MS.  The key format is
   * `nonce:<uuid>` and the value is a JSON-encoded NonceEntry.
   *
   * Throws on Redis write failure to prevent dead-on-arrival nonces.
   */
  async generateNonce(publicKey: string): Promise<NonceResponseDto> {
    const nonce = uuidv4();
    const expiresAt = Date.now() + AUTH_CONSTANTS.NONCE_EXPIRY_MS;
    const entry: NonceEntry = { publicKey, expiresAt, used: false };

    try {
      await this.redis.set(
        `${NONCE_KEY_PREFIX}${nonce}`,
        JSON.stringify(entry),
        "EX",
        NONCE_TTL_SECONDS
      );
    } catch (err) {
      this.logger.error(
        `Failed to store nonce in Redis: ${(err as Error).message}`
      );
      throw new Error("Failed to generate nonce: Redis write failed");
    }

    const message = `${AUTH_CONSTANTS.STELLAR_MESSAGE_PREFIX}${nonce}`;
    return { nonce, expiresAt, message };
  }

  /**
   * Atomically validates and consumes a nonce (one-time use).
   *
   * Uses a Lua script so the check-mark-used sequence is atomic and safe
   * under concurrent requests.
   *
   * Returns false if the nonce is not found, already used, or belongs to a
   * different public key.
   */
  async consumeNonce(nonce: string, publicKey: string): Promise<boolean> {
    const key = `${NONCE_KEY_PREFIX}${nonce}`;
    let result: number;

    try {
      result = (await this.redis.eval(
        CONSUME_NONCE_SCRIPT,
        1,
        key,
        publicKey
      )) as number;
    } catch (err) {
      this.logger.error(
        `Redis error while consuming nonce ${nonce}: ${(err as Error).message}`
      );
      return false;
    }

    switch (result) {
      case 1:
        return true;
      case -1:
        this.logger.warn(`Nonce not found or expired: ${nonce}`);
        return false;
      case -2:
        this.logger.warn(`Nonce already used (replay attempt): ${nonce}`);
        return false;
      case -3:
        this.logger.warn(`Nonce public key mismatch for: ${nonce}`);
        return false;
      default:
        this.logger.error(
          `Unexpected Lua return code ${result} for nonce: ${nonce}`
        );
        return false;
    }
  }

  /**
   * Safety-net: delete any `nonce:*` keys that are marked `used`.
   * Normally Redis TTL handles cleanup; this catches edge cases.
   */
  private async cleanupUsedNonces(): Promise<void> {
    try {
      let cursor = "0";
      let cleaned = 0;
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          `${NONCE_KEY_PREFIX}*`,
          "COUNT",
          100
        );
        cursor = nextCursor;

        for (const key of keys) {
          const raw = await this.redis.get(key);
          if (!raw) continue;
          const entry: NonceEntry = JSON.parse(raw);
          if (entry.used) {
            await this.redis.del(key);
            cleaned++;
          }
        }
      } while (cursor !== "0");

      if (cleaned > 0) {
        this.logger.debug(`Cleanup removed ${cleaned} used nonce key(s)`);
      }
    } catch (err) {
      this.logger.error(`Nonce cleanup error: ${(err as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupInterval);
    this.redis.disconnect();
  }
}
