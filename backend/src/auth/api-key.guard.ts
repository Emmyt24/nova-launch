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

    try {
      const config = JSON.parse(raw) as ApiKeyConfig[];
      config.forEach((cfg) => {
        if (cfg.key) {
          const digest = this.hashKey(cfg.key);
          this.apiKeys.set(digest, cfg);
        }
      });
    } catch (e) {
      this.logger.warn("Failed to parse API_KEYS_CONFIG, using legacy mode");
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
