import { Test, TestingModule } from "@nestjs/testing";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { TokenService } from "../token.service";
import { AUTH_CONSTANTS } from "../auth.constants";

describe("TokenService", () => {
  let service: TokenService;
  const testWallet = "GTEST_WALLET_ADDRESS_123";

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
        }),
        JwtModule.register({ secret: "test-secret" }),
      ],
      providers: [
        TokenService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal?: string) => {
              const map: Record<string, string> = {
                JWT_ACCESS_SECRET: "test-access-secret",
                JWT_REFRESH_SECRET: "test-refresh-secret",
                JWT_ISSUER: "test-platform",
              };
              return map[key] ?? defaultVal;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(TokenService);
  });

  describe("generateTokenPair", () => {
    it("should generate access and refresh tokens", () => {
      const result = service.generateTokenPair(testWallet);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.walletAddress).toBe(testWallet);
      expect(result.tokenType).toBe("Bearer");
      expect(result.expiresIn).toBe(900);
    });

    it("should generate different tokens on each call", () => {
      const r1 = service.generateTokenPair(testWallet);
      const r2 = service.generateTokenPair(testWallet);

      expect(r1.accessToken).not.toBe(r2.accessToken);
    });

    it("should derive expiresIn from the access token expiry constant", () => {
      const originalExpiry = AUTH_CONSTANTS.JWT_ACCESS_EXPIRY;
      AUTH_CONSTANTS.JWT_ACCESS_EXPIRY = "2h";

      try {
        expect(service.generateTokenPair(testWallet).expiresIn).toBe(2 * 60 * 60);
      } finally {
        AUTH_CONSTANTS.JWT_ACCESS_EXPIRY = originalExpiry;
      }
    });
  });

  describe("verifyAccessToken", () => {
    it("should verify a valid access token", () => {
      const { accessToken } = service.generateTokenPair(testWallet);
      const payload = service.verifyAccessToken(accessToken);

      expect(payload.walletAddress).toBe(testWallet);
      expect(payload.type).toBe("access");
    });

    it("should throw for an invalid token", () => {
      expect(() => service.verifyAccessToken("invalid-token")).toThrow(
        UnauthorizedException
      );
    });

    it("should throw when using refresh token as access token", () => {
      const { refreshToken } = service.generateTokenPair(testWallet);
      expect(() => service.verifyAccessToken(refreshToken)).toThrow(
        UnauthorizedException
      );
    });

    it("should throw for revoked token", () => {
      const { accessToken } = service.generateTokenPair(testWallet);
      const payload = service.verifyAccessToken(accessToken);

      service.revokeToken(payload.jti!);

      expect(() => service.verifyAccessToken(accessToken)).toThrow(
        UnauthorizedException
      );
    });
  });

  describe("verifyRefreshToken", () => {
    it("should verify a valid refresh token", () => {
      const { refreshToken } = service.generateTokenPair(testWallet);
      const payload = service.verifyRefreshToken(refreshToken);

      expect(payload.walletAddress).toBe(testWallet);
      expect(payload.type).toBe("refresh");
    });

    it("should throw when using access token as refresh token", () => {
      const { accessToken } = service.generateTokenPair(testWallet);
      expect(() => service.verifyRefreshToken(accessToken)).toThrow(
        UnauthorizedException
      );
    });
  });

  describe("revokeToken", () => {
    it("should mark token as revoked", () => {
      const jti = "test-jti-123";
      expect(service.isRevoked(jti)).toBe(false);
      service.revokeToken(jti);
      expect(service.isRevoked(jti)).toBe(true);
    });
  });
});
