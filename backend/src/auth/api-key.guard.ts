import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import * as crypto from "crypto";

/**
 * Request guard for deployment-configured API keys and route scopes.
 *
 * This guard intentionally does not delegate to `ApiKeyManager` in `apiKey.ts`: it validates the
 * static `API_KEYS_CONFIG`/legacy `API_KEYS` credentials used at the HTTP boundary, while the
 * manager owns lifecycle operations for dynamically issued `nlk_` keys. The kebab-case filename
 * follows Nest's `*.guard.ts` convention; the older manager keeps its camelCase public filename.
 */

export const REQUIRED_SCOPES = "required_scopes";

export interface ApiKeyConfig {
  key: string;
  scopes: string[];
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly apiKeys: Map<string, ApiKeyConfig> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector
  ) {
    this.loadApiKeys();
  }

  private loadApiKeys(): void {
    const raw = this.configService.get<string>("API_KEYS_CONFIG", "");
    if (!raw) return;

    // Guard against malformed/corrupt API_KEYS_CONFIG: a JSON.parse failure must never
    // bubble up as an unhandled error. On failure we log a sanitized warning (never the
    // raw value, which may contain secrets) and fall back to legacy API_KEYS parsing.
    try {
      const config = JSON.parse(raw) as ApiKeyConfig[];
      config.forEach((cfg) => {
        if (cfg.key) {
          const digest = this.hashKey(cfg.key);
          this.apiKeys.set(digest, cfg);
        }
      });
    } catch {
      this.logger.warn(
        "Failed to parse API_KEYS_CONFIG (invalid JSON); falling back to legacy API_KEYS"
      );
      const legacyRaw = this.configService.get<string>("API_KEYS", "");
      legacyRaw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .forEach((key) => {
          const digest = this.hashKey(key);
          this.apiKeys.set(digest, { key, scopes: [] });
        });
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers["x-api-key"] || request.query["api_key"];

    if (!apiKey) {
      throw new UnauthorizedException("API key is required");
    }

    const keyConfig = this.findKeyConfig(apiKey as string);
    if (!keyConfig) {
      this.logger.warn(`Invalid API key attempt from ${request.ip}`);
      throw new UnauthorizedException("Invalid API key");
    }

    const requiredScopes = this.reflector.get<string[]>(
      REQUIRED_SCOPES,
      context.getHandler()
    );

    if (requiredScopes && requiredScopes.length > 0) {
      const hasRequiredScope = requiredScopes.some((scope) =>
        keyConfig.scopes.includes(scope)
      );

      if (!hasRequiredScope) {
        this.logger.warn(
          `API key lacks required scope(s) ${requiredScopes.join(",")} from ${request.ip}`
        );
        throw new ForbiddenException(
          `API key lacks required scope(s): ${requiredScopes.join(",")}`
        );
      }
    }

    request.apiKey = apiKey;
    request.apiKeyScopes = keyConfig.scopes;
    return true;
  }

  private findKeyConfig(apiKey: string): ApiKeyConfig | null {
    const digest = this.hashKey(apiKey);
    return this.apiKeys.get(digest) || null;
  }

  private hashKey(apiKey: string): string {
    return crypto.createHash("sha256").update(apiKey).digest("hex");
  }
}

export function RequireScopes(...scopes: string[]) {
  return SetMetadata(REQUIRED_SCOPES, scopes);
}
