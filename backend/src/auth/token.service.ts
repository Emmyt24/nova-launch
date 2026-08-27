import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import { AUTH_CONSTANTS } from "../auth.constants";
import { AuthResponseDto, JwtPayloadDto } from "./dto/auth.dto";

function parseExpiryToSeconds(expiry: string): number {
  const match = expiry.match(/^(\d+(?:\.\d+)?)([smhdwy])$/);
  if (!match) {
    throw new Error(`Unsupported JWT expiry format: ${expiry}`);
  }

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
    y: 365 * 24 * 60 * 60,
  };

  return Number(match[1]) * multipliers[match[2]];
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  // In production store revoked JTIs in Redis with TTL
  private readonly revokedTokens = new Set<string>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService
  ) {}

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
      expiresIn: parseExpiryToSeconds(AUTH_CONSTANTS.JWT_ACCESS_EXPIRY),
      tokenType: "Bearer",
      walletAddress,
    };
  }

  verifyAccessToken(token: string): JwtPayloadDto {
    try {
      const payload = this.jwtService.verify<JwtPayloadDto>(token, {
        secret: this.configService.get<string>("JWT_ACCESS_SECRET"),
      });

      if (payload.type !== "access") {
        throw new UnauthorizedException("Invalid token type");
      }

      if (payload.jti && this.revokedTokens.has(payload.jti)) {
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

  verifyRefreshToken(token: string): JwtPayloadDto {
    try {
      const payload = this.jwtService.verify<JwtPayloadDto>(token, {
        secret: this.configService.get<string>("JWT_REFRESH_SECRET"),
      });

      if (payload.type !== "refresh") {
        throw new UnauthorizedException("Invalid token type");
      }

      if (payload.jti && this.revokedTokens.has(payload.jti)) {
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

  revokeToken(jti: string): void {
    this.revokedTokens.add(jti);
    this.logger.log(`Token revoked: ${jti}`);
  }

  isRevoked(jti: string): boolean {
    return this.revokedTokens.has(jti);
  }
}
