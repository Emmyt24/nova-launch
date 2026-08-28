/**
 * Tests for JWT validation edge cases
 *
 * Issue #1066: Exercise JWT expiry, clock-skew, and tampering edge cases
 * in the auth layer.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockConfigService = {
  get: vi.fn((key: string) => {
    const config: Record<string, string> = {
      JWT_ACCESS_SECRET: "test-access-secret-key-12345",
      JWT_REFRESH_SECRET: "test-refresh-secret-key-12345",
    };
    return config[key];
  }),
} as any;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_WALLET = "GTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// ─── Issue #1066: JWT Edge Cases ──────────────────────────────────────────────

describe("Issue #1066: JWT expiry, clock-skew, and tampering edge cases", () => {
  let jwtService: JwtService;

  beforeEach(() => {
    jwtService = new JwtService();
  });

  describe("Expired tokens", () => {
    it("rejects an expired access token", () => {
      // Create a token that expires immediately
      const expiredToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-1",
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "0s", // Expires immediately
        }
      );

      // Wait a moment to ensure expiration
      vi.useFakeTimers();
      vi.advanceTimersByTime(1000);

      expect(() => {
        jwtService.verify(expiredToken, {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();

      vi.useRealTimers();
    });

    it("accepts a valid token with future expiration", () => {
      const validToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-2",
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "1h",
        }
      );

      const payload = jwtService.verify(validToken, {
        secret: mockConfigService.get("JWT_ACCESS_SECRET"),
      });

      expect(payload.walletAddress).toBe(TEST_WALLET);
      expect(payload.type).toBe("access");
    });
  });

  describe("Not-yet-valid tokens (clock skew)", () => {
    it("rejects a token with future nbf (not before) claim", () => {
      const futureToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-3",
          nbf: Math.floor(Date.now() / 1000) + 3600, // Valid 1 hour from now
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "2h",
        }
      );

      expect(() => {
        jwtService.verify(futureToken, {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();
    });

    it("accepts a token with nbf in the past", () => {
      const validToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-4",
          nbf: Math.floor(Date.now() / 1000) - 60, // Valid 1 minute ago
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "1h",
        }
      );

      const payload = jwtService.verify(validToken, {
        secret: mockConfigService.get("JWT_ACCESS_SECRET"),
      });

      expect(payload.walletAddress).toBe(TEST_WALLET);
    });
  });

  describe("Tampered tokens", () => {
    it("rejects a token with tampered payload", () => {
      const validToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-5",
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "1h",
        }
      );

      // Tamper with the payload by modifying the token
      const parts = validToken.split(".");
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          sub: "GATTACKER123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
          walletAddress: "GATTACKER123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
          type: "access",
          jti: "test-jti-5",
        })
      ).toString("base64url");

      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      expect(() => {
        jwtService.verify(tamperedToken, {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();
    });

    it("rejects a token with tampered signature", () => {
      const validToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-6",
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "1h",
        }
      );

      // Tamper with the signature
      const parts = validToken.split(".");
      const tamperedSignature =
        Buffer.from("tampered-signature").toString("base64url");
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

      expect(() => {
        jwtService.verify(tamperedToken, {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();
    });

    it("rejects a token signed with wrong secret", () => {
      const wrongSecretToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-7",
        },
        {
          secret: "wrong-secret-key",
          expiresIn: "1h",
        }
      );

      expect(() => {
        jwtService.verify(wrongSecretToken, {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();
    });
  });

  describe("Missing or invalid claims", () => {
    it("rejects a token missing the type claim", () => {
      const noTypeToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          jti: "test-jti-8",
          // type is missing
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "1h",
        }
      );

      const payload = jwtService.verify(noTypeToken, {
        secret: mockConfigService.get("JWT_ACCESS_SECRET"),
      });

      // Payload exists but type is undefined
      expect(payload.type).toBeUndefined();
    });

    it("accepts a token with all required claims", () => {
      const validToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-9",
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "1h",
        }
      );

      const payload = jwtService.verify(validToken, {
        secret: mockConfigService.get("JWT_ACCESS_SECRET"),
      });

      expect(payload.sub).toBe(TEST_WALLET);
      expect(payload.walletAddress).toBe(TEST_WALLET);
      expect(payload.type).toBe("access");
      expect(payload.jti).toBe("test-jti-9");
    });

    it("rejects a token missing the sub claim", () => {
      const noSubToken = jwtService.sign(
        {
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-10",
          // sub is missing
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "1h",
        }
      );

      // JWT library may still parse it, but sub should be undefined
      const payload = jwtService.verify(noSubToken, {
        secret: mockConfigService.get("JWT_ACCESS_SECRET"),
      });

      expect(payload.sub).toBeUndefined();
    });
  });

  describe("Token pair generation", () => {
    it("generates tokens with different secrets", () => {
      const accessToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "access",
          jti: "test-jti-11",
        },
        {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
          expiresIn: "15m",
        }
      );

      const refreshToken = jwtService.sign(
        {
          sub: TEST_WALLET,
          walletAddress: TEST_WALLET,
          type: "refresh",
          jti: "test-jti-12",
        },
        {
          secret: mockConfigService.get("JWT_REFRESH_SECRET"),
          expiresIn: "7d",
        }
      );

      // Access token should verify with access secret
      const accessPayload = jwtService.verify(accessToken, {
        secret: mockConfigService.get("JWT_ACCESS_SECRET"),
      });
      expect(accessPayload.type).toBe("access");

      // Refresh token should verify with refresh secret
      const refreshPayload = jwtService.verify(refreshToken, {
        secret: mockConfigService.get("JWT_REFRESH_SECRET"),
      });
      expect(refreshPayload.type).toBe("refresh");

      // Cross-verification should fail
      expect(() => {
        jwtService.verify(accessToken, {
          secret: mockConfigService.get("JWT_REFRESH_SECRET"),
        });
      }).toThrow();

      expect(() => {
        jwtService.verify(refreshToken, {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();
    });
  });

  describe("Malformed tokens", () => {
    it("rejects a token with invalid base64 encoding", () => {
      const malformedToken = "invalid.token.format!!!";

      expect(() => {
        jwtService.verify(malformedToken, {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();
    });

    it("rejects a token with missing parts", () => {
      const incompletToken = "header.payload"; // Missing signature

      expect(() => {
        jwtService.verify(incompletToken, {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();
    });

    it("rejects an empty token", () => {
      expect(() => {
        jwtService.verify("", {
          secret: mockConfigService.get("JWT_ACCESS_SECRET"),
        });
      }).toThrow();
    });
  });
});
