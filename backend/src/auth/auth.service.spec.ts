import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { StellarSignatureService } from "./stellar-signature.service";
import { NonceService } from "./nonce.service";
import { TokenService } from "./token.service";

const mockTokenPair = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresIn: 900,
  tokenType: "Bearer",
  walletAddress: "GTEST",
};

describe("AuthService", () => {
  let service: AuthService;
  let stellarSig: {
    isValidPublicKey: ReturnType<typeof vi.fn>;
    verifySignature: ReturnType<typeof vi.fn>;
  };
  let nonceService: {
    generateNonce: ReturnType<typeof vi.fn>;
    consumeNonce: ReturnType<typeof vi.fn>;
  };
  let tokenService: {
    generateTokenPair: ReturnType<typeof vi.fn>;
    verifyRefreshToken: ReturnType<typeof vi.fn>;
    revokeToken: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    stellarSig = {
      isValidPublicKey: vi.fn(),
      verifySignature: vi.fn(),
    };
    nonceService = {
      generateNonce: vi.fn(),
      consumeNonce: vi.fn(),
    };
    tokenService = {
      generateTokenPair: vi.fn(),
      verifyRefreshToken: vi.fn(),
      revokeToken: vi.fn(),
    };
    service = new AuthService(
      stellarSig as unknown as StellarSignatureService,
      nonceService as unknown as NonceService,
      tokenService as unknown as TokenService
    );
  });

  describe("requestNonce", () => {
    it("should return a nonce for valid public key", () => {
      const mockNonce = {
        nonce: "abc",
        expiresAt: Date.now() + 5000,
        message: "Sign...",
      };
      stellarSig.isValidPublicKey.mockReturnValue(true);
      nonceService.generateNonce.mockReturnValue(mockNonce);

      const result = service.requestNonce("GTEST");

      expect(stellarSig.isValidPublicKey).toHaveBeenCalledWith("GTEST");
      expect(nonceService.generateNonce).toHaveBeenCalledWith("GTEST");
      expect(result).toBe(mockNonce);
    });

    it("should throw BadRequestException for invalid public key", () => {
      stellarSig.isValidPublicKey.mockReturnValue(false);

      expect(() => service.requestNonce("invalid")).toThrow(
        BadRequestException
      );
      expect(nonceService.generateNonce).not.toHaveBeenCalled();
    });
  });

  describe("authenticateWithWallet", () => {
    const validDto = {
      publicKey: "GTEST",
      signature: "valid-sig",
      nonce: "valid-nonce",
    };

    it("should return token pair on valid authentication", async () => {
      stellarSig.isValidPublicKey.mockReturnValue(true);
      nonceService.consumeNonce.mockResolvedValue(true);
      stellarSig.verifySignature.mockReturnValue({
        valid: true,
        publicKey: "GTEST",
      });
      tokenService.generateTokenPair.mockReturnValue(mockTokenPair);

      const result = await service.authenticateWithWallet(validDto);

      expect(nonceService.consumeNonce).toHaveBeenCalledWith(
        "valid-nonce",
        "GTEST"
      );
      expect(stellarSig.verifySignature).toHaveBeenCalledWith(
        "GTEST",
        "valid-sig",
        "valid-nonce"
      );
      expect(result).toBe(mockTokenPair);
    });

    it("should throw UnauthorizedException for invalid nonce", async () => {
      stellarSig.isValidPublicKey.mockReturnValue(true);
      nonceService.consumeNonce.mockResolvedValue(false);

      await expect(service.authenticateWithWallet(validDto)).rejects.toThrow(
        UnauthorizedException
      );
      expect(stellarSig.verifySignature).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException for invalid signature", async () => {
      stellarSig.isValidPublicKey.mockReturnValue(true);
      nonceService.consumeNonce.mockResolvedValue(true);
      stellarSig.verifySignature.mockReturnValue({
        valid: false,
        publicKey: "GTEST",
        error: "bad sig",
      });

      await expect(service.authenticateWithWallet(validDto)).rejects.toThrow(
        UnauthorizedException
      );
    });

    it("should throw BadRequestException for invalid public key", async () => {
      stellarSig.isValidPublicKey.mockReturnValue(false);

      await expect(service.authenticateWithWallet(validDto)).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe("refreshTokens", () => {
    it("should generate new token pair and revoke old refresh token", async () => {
      const refreshPayload = {
        sub: "GTEST",
        walletAddress: "GTEST",
        type: "refresh" as const,
        jti: "old-jti",
      };
      tokenService.verifyRefreshToken.mockReturnValue(refreshPayload);
      tokenService.generateTokenPair.mockReturnValue(mockTokenPair);

      const result = await service.refreshTokens({ refreshToken: "old-token" });

      expect(tokenService.revokeToken).toHaveBeenCalledWith("old-jti");
      expect(tokenService.generateTokenPair).toHaveBeenCalledWith("GTEST");
      expect(result).toBe(mockTokenPair);
    });
  });

  describe("logout", () => {
    it("should revoke the token", () => {
      service.logout("some-jti");
      expect(tokenService.revokeToken).toHaveBeenCalledWith("some-jti");
    });
  });
});
