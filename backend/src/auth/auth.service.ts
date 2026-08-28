import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { StellarSignatureService } from "./stellar-signature.service";
import { NonceService } from "./nonce.service";
import { TokenService } from "./token.service";
import {
  WalletAuthDto,
  AuthResponseDto,
  NonceResponseDto,
  RefreshTokenDto,
} from "./dto/auth.dto";
import {
  createTokenFamily,
  rotateTokenFamily,
  TokenFamilyError,
} from "./refresh-token-family.service";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly stellarSig: StellarSignatureService,
    private readonly nonceService: NonceService,
    private readonly tokenService: TokenService
  ) {}

  /**
   * Step 1: Client requests a nonce to sign.
   */
  async requestNonce(publicKey: string): Promise<NonceResponseDto> {
    if (!this.stellarSig.isValidPublicKey(publicKey)) {
      throw new BadRequestException("Invalid Stellar public key");
    }
    return this.nonceService.generateNonce(publicKey);
  }

  /**
   * Step 2: Client signs the nonce and submits here.
   * Returns JWT token pair on success and creates the initial token family.
   */
  async authenticateWithWallet(dto: WalletAuthDto): Promise<AuthResponseDto> {
    const { publicKey, signature, nonce } = dto;

    if (!this.stellarSig.isValidPublicKey(publicKey)) {
      throw new BadRequestException("Invalid Stellar public key");
    }

    const nonceValid = await this.nonceService.consumeNonce(nonce, publicKey);
    if (!nonceValid) {
      throw new UnauthorizedException("Invalid or expired nonce");
    }

    const result = this.stellarSig.verifySignature(publicKey, signature, nonce);
    if (!result.valid) {
      this.logger.warn(
        `Failed signature verification for wallet ${publicKey}: ${result.error}`
      );
      throw new UnauthorizedException("Invalid wallet signature");
    }

    this.logger.log(`Wallet authenticated: ${publicKey}`);
    const tokenPair = this.tokenService.generateTokenPair(publicKey);

    // Create initial token family entry (non-fatal if DB is unavailable)
    const refreshTtlMs = 7 * 24 * 60 * 60 * 1000;
    await createTokenFamily(
      tokenPair.refreshToken,
      new Date(Date.now() + refreshTtlMs)
    ).catch((err) =>
      this.logger.warn(`Failed to create token family: ${err.message}`)
    );

    return tokenPair;
  }

  /**
   * Step 3: Refresh access token using refresh token.
   * Implements family rotation with reuse-detection.
   */
  async refreshTokens(dto: RefreshTokenDto): Promise<AuthResponseDto> {
    const payload = await this.tokenService.verifyRefreshToken(
      dto.refreshToken
    );

    // Generate the next pair before rotating so we have the new token string
    const nextPair = this.tokenService.generateTokenPair(payload.walletAddress);
    const refreshTtlMs = 7 * 24 * 60 * 60 * 1000;

    try {
      await rotateTokenFamily(
        dto.refreshToken,
        nextPair.refreshToken,
        new Date(Date.now() + refreshTtlMs)
      );
    } catch (err) {
      if (err instanceof TokenFamilyError && err.code === "REUSE_DETECTED") {
        this.logger.warn(
          `Refresh token reuse detected for wallet ${payload.walletAddress} — family invalidated`
        );
        throw new UnauthorizedException(
          "Refresh token reuse detected. All sessions invalidated for security."
        );
      }
      if (err instanceof TokenFamilyError && err.code === "INVALID_TOKEN") {
        // Token not in family store — allow legacy rotation (backward compat)
        this.logger.warn(
          `Refresh token not found in family store — allowing legacy rotation for ${payload.walletAddress}`
        );
      }
    }

    // Revoke old JTI (backward-compat with legacy tokens)
    if (payload.jti) {
      await this.tokenService.revokeToken(payload.jti);
    }

    return nextPair;
  }

  /**
   * Revoke a specific token by JTI (e.g., on logout).
   */
  async logout(jti: string): Promise<void> {
    await this.tokenService.revokeToken(jti);
    this.logger.log(`Token revoked on logout: ${jti}`);
  }
}
