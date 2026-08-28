import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  Delete,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
} from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import {
  WalletAuthDto,
  RefreshTokenDto,
  AuthResponseDto,
  NonceResponseDto,
} from "./dto/auth.dto";
import { Public, CurrentUser, Protected } from "./decorators/auth.decorators";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { JwtPayloadDto } from "./dto/auth.dto";

@ApiTags("Authentication")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/challenge (mapped from GET /auth/nonce)
   * Request a cryptographic challenge (nonce) for wallet authentication.
   */
  @Public()
  @Get("nonce")
  @ApiOperation({
    summary: "Request a nonce / challenge to sign with your Stellar wallet",
    description:
      "Returns a one-time nonce that the client must sign with their Stellar private key. " +
      "The nonce expires after a short TTL. This endpoint maps to POST /auth/challenge in the OpenAPI spec.",
    operationId: "authChallenge",
  })
  @ApiQuery({
    name: "publicKey",
    description: "Stellar wallet public key (G-address, 56 characters)",
    example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: "Nonce issued successfully",
    type: NonceResponseDto,
    content: {
      "application/json": {
        example: {
          nonce: "3f7e1b2a-9c4d-4e8f-a1b2-c3d4e5f60718",
          expiresAt: 1719100800,
          message:
            "Sign this message to authenticate: 3f7e1b2a-9c4d-4e8f-a1b2-c3d4e5f60718",
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "Missing or invalid publicKey query parameter",
    content: {
      "application/json": {
        example: {
          statusCode: 400,
          message: "publicKey is required",
          error: "Bad Request",
        },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: "Too many nonce requests — rate limit exceeded",
  })
  async getNonce(
    @Query("publicKey") publicKey: string
  ): Promise<NonceResponseDto> {
    return this.authService.requestNonce(publicKey);
  }

  /**
   * POST /auth/verify (mapped from POST /auth/login)
   * Verify a signed nonce and issue JWT tokens.
   */
  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Authenticate with Stellar wallet signature (verify challenge)",
    description:
      "Verifies the Ed25519 signature over the nonce obtained from GET /auth/nonce. " +
      "On success, returns a short-lived access token and a longer-lived refresh token. " +
      "This endpoint maps to POST /auth/verify in the OpenAPI spec.",
    operationId: "authVerify",
  })
  @ApiBody({
    type: WalletAuthDto,
    description: "Signed nonce payload",
    examples: {
      typical: {
        summary: "Standard wallet login",
        value: {
          publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          signature:
            "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789+/aBcDeFgHiJkLmNoPqRsTuVwXyZ012=",
          nonce: "3f7e1b2a-9c4d-4e8f-a1b2-c3d4e5f60718",
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "Authentication successful — tokens issued",
    type: AuthResponseDto,
    content: {
      "application/json": {
        example: {
          accessToken:
            "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQUFaST...",
          refreshToken:
            "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQUFaST...",
          expiresIn: 900,
          tokenType: "Bearer",
          walletAddress:
            "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "Malformed request body — missing or invalid fields",
    content: {
      "application/json": {
        example: {
          statusCode: 400,
          message: [
            "publicKey should not be empty",
            "signature should not be empty",
          ],
          error: "Bad Request",
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: "Invalid or expired signature / nonce",
    content: {
      "application/json": {
        example: {
          statusCode: 401,
          message: "Invalid signature or nonce",
          error: "Unauthorized",
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: "Account suspended or wallet blocked",
    content: {
      "application/json": {
        example: {
          statusCode: 403,
          message: "Account is not authorised to authenticate",
          error: "Forbidden",
        },
      },
    },
  })
  async login(@Body() dto: WalletAuthDto): Promise<AuthResponseDto> {
    return this.authService.authenticateWithWallet(dto);
  }

  /**
   * POST /auth/refresh
   * Exchange a refresh token for a new access/refresh token pair.
   */
  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Refresh access token using a valid refresh token",
    description:
      "Accepts a non-expired refresh token and issues a new access token and rotated refresh token. " +
      "The old refresh token is revoked on success.",
    operationId: "authRefresh",
  })
  @ApiBody({
    type: RefreshTokenDto,
    description: "Refresh token payload",
    examples: {
      typical: {
        summary: "Standard refresh",
        value: {
          refreshToken:
            "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQUFaST...",
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "New token pair issued",
    type: AuthResponseDto,
    content: {
      "application/json": {
        example: {
          accessToken:
            "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQUFaSS...",
          refreshToken:
            "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQUFaSS...",
          expiresIn: 900,
          tokenType: "Bearer",
          walletAddress:
            "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "Missing or malformed refreshToken field",
    content: {
      "application/json": {
        example: {
          statusCode: 400,
          message: ["refreshToken should not be empty"],
          error: "Bad Request",
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: "Refresh token is expired or has been revoked",
    content: {
      "application/json": {
        example: {
          statusCode: 401,
          message: "Refresh token is invalid or expired",
          error: "Unauthorized",
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: "Refresh token belongs to a suspended account",
    content: {
      "application/json": {
        example: {
          statusCode: 403,
          message: "Account is not authorised",
          error: "Forbidden",
        },
      },
    },
  })
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refreshTokens(dto);
  }

  /**
   * DELETE /auth/session (mapped from POST /auth/logout)
   * Revoke the current access token / session.
   */
  @UseGuards(JwtAuthGuard)
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Revoke current session (logout)",
    description:
      "Revokes the JWT identified by the `jti` claim in the Bearer token, " +
      "effectively ending the current session. " +
      "This endpoint maps to DELETE /auth/session in the OpenAPI spec.",
    operationId: "authDeleteSession",
  })
  @ApiResponse({
    status: 204,
    description: "Session revoked — no content returned",
  })
  @ApiResponse({
    status: 401,
    description: "No valid Bearer token provided",
    content: {
      "application/json": {
        example: {
          statusCode: 401,
          message: "Unauthorized",
          error: "Unauthorized",
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: "Token does not have permission to revoke this session",
    content: {
      "application/json": {
        example: {
          statusCode: 403,
          message: "Forbidden",
          error: "Forbidden",
        },
      },
    },
  })
  async logout(@CurrentUser() user: JwtPayloadDto): Promise<void> {
    if (user.jti) {
      await this.authService.logout(user.jti);
    }
  }

  /**
   * GET /auth/me
   * Return the currently authenticated user's profile from the JWT payload.
   */
  @UseGuards(JwtAuthGuard)
  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get current authenticated user info",
    description:
      "Returns the decoded JWT payload for the authenticated caller, " +
      "including wallet address and token metadata.",
    operationId: "authMe",
  })
  @ApiResponse({
    status: 200,
    description: "Current user payload",
    type: JwtPayloadDto,
    content: {
      "application/json": {
        example: {
          sub: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          walletAddress:
            "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          type: "access",
          iat: 1719100000,
          exp: 1719100900,
          jti: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: "No valid Bearer token provided",
    content: {
      "application/json": {
        example: {
          statusCode: 401,
          message: "Unauthorized",
          error: "Unauthorized",
        },
      },
    },
  })
  me(@CurrentUser() user: JwtPayloadDto): JwtPayloadDto {
    return user;
  }
}
