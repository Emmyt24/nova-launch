import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { AUTH_CONSTANTS } from "../auth.constants";
import { AuthResponseDto, JwtPayloadDto } from "./dto/auth.dto";

const REVOKED_JTI_PREFIX = "revoked_jti:";

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly redis: Redis;
  // Fallback in-memory store for local/test environments when Redis is unavailable
  private readonly revokedTokensLocal = new Set<string>();
  private readonly useRedis: boolean;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    redisClient?: Redis
  ) {
    this.redis =
      redisClient ??
      new Redis({
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD,
        lazyConnect: true,
      });
    // Use Redis if REDIS_URL is configured (indicates production)
    this.useRedis = Boolean(process.env.REDIS_URL);
  }

  generateTokenPair(walletAddress: string): AuthResponseDto {
    const jti = uuidv4();

    const accessPayload: JwtPayloadDto = {
      sub: walletAddress,
      walletAddress,
      type: "access",
      jti,
    };

    const refreshPayload: JwtPayloadDto = {
      sub: walletAddress,
      walletAddress,
      type: "refresh",
      jti: uuidv4(),
    };

    const accessToken = this.jwtService.sign(accessPayload, {
      expiresIn: AUTH_CONSTANTS.JWT_ACCESS_EXPIRY,
      secret: this.configService.get<string>("JWT_ACCESS_SECRET"),
    });

    const refreshToken = this.jwtService.sign(refreshPayload, {
      expiresIn: AUTH_CONSTANTS.JWT_REFRESH_EXPIRY,
      secret: this.configService.get<string>("JWT_REFRESH_SECRET"),
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 15 * 60, // 15 minutes in seconds
      tokenType: "Bearer",
      walletAddress,
    };
  }

  async verifyAccessToken(token: string): Promise<JwtPayloadDto> {
    try {
      const payload = this.jwtService.verify<JwtPayloadDto>(token, {
        secret: this.configService.get<string>("JWT_ACCESS_SECRET"),
      });

      if (payload.type !== "access") {
        throw new UnauthorizedException("Invalid token type");
      }

      if (payload.jti && (await this.isRevoked(payload.jti))) {
        throw new UnauthorizedException("Token has been revoked");
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException(
        `Token verification failed: ${error.message}`
      );
    }
  }

  async verifyRefreshToken(token: string): Promise<JwtPayloadDto> {
    try {
      const payload = this.jwtService.verify<JwtPayloadDto>(token, {
        secret: this.configService.get<string>("JWT_REFRESH_SECRET"),
      });

      if (payload.type !== "refresh") {
        throw new UnauthorizedException("Invalid token type");
      }

      if (payload.jti && (await this.isRevoked(payload.jti))) {
        throw new UnauthorizedException("Refresh token has been revoked");
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException(
        `Refresh token verification failed: ${error.message}`
      );
    }
  }

  async revokeToken(jti: string): Promise<void> {
    try {
      if (this.useRedis) {
        // Store in Redis with TTL matching the max token lifetime (15 min for access, 7d for refresh)
        // Use a conservative TTL of 7 days for refresh tokens
        const ttlSeconds = 7 * 24 * 60 * 60;
        await this.redis.set(
          `${REVOKED_JTI_PREFIX}${jti}`,
          "1",
          "EX",
          ttlSeconds
        );
      } else {
        // Fallback to local store for testing/development
        this.revokedTokensLocal.add(jti);
      }
      this.logger.log(`Token revoked: ${jti}`);
    } catch (err) {
      this.logger.error(
        `Failed to revoke token ${jti} in Redis: ${(err as Error).message} — falling back to local store`
      );
      // Fallback: still record locally so this instance honors the revocation
      this.revokedTokensLocal.add(jti);
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    try {
      if (this.useRedis) {
        const exists = await this.redis.exists(`${REVOKED_JTI_PREFIX}${jti}`);
        return exists === 1;
      } else {
        return this.revokedTokensLocal.has(jti);
      }
    } catch (err) {
      this.logger.error(
        `Failed to check revocation status for ${jti} in Redis: ${(err as Error).message}`
      );
      // Fail-safe: assume revoked if Redis is down (safer than allowing potentially compromised tokens)
      return true;
    }
  }
}
