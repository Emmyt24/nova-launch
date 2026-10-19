import {
  Controller,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { TokensService } from "./tokens.service";
import { GetTokenParamDto } from "./dto/get-token-param.dto";
import { GetTokenQueryDto, TokenInclude } from "./dto/get-token-query.dto";
import { GetTokenCreationFeeQuoteQueryDto } from "./dto/get-token-creation-fee-quote-query.dto";
import {
  TokenApiResponse,
  TokenCreationFeeQuoteApiResponse,
} from "./interfaces/token.interface";

@ApiTags("Tokens")
@Controller("api/tokens")
export class TokensController {
  constructor(private readonly tokensService: TokensService) {}

  /**
   * GET /api/tokens/creation-fee/quote
   * Read-only quote of the fee that would be charged for token creation.
   * Mirrors the on-chain charge logic so clients can preview costs.
   */
  @Get("creation-fee/quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } }) // 60 req/min per IP
  @ApiOperation({
    summary: "Quote token creation fee",
    description:
      "Returns the fee that would be charged for creating a token with the given options. " +
      "The quote is read-only and matches the actual creation charge logic.",
  })
  @ApiQuery({
    name: "include",
    required: false,
    isArray: true,
    enum: TokenInclude,
    description: "Optional data fields to include in the quote breakdown",
  })
  @ApiResponse({
    status: 200,
    description: "Token creation fee quote retrieved successfully",
    schema: {
      example: {
        success: true,
        data: {
          baseFee: "1.0000000",
          totalFee: "1.0000000",
          asset: "XLM",
          breakdown: [],
        },
        cached: false,
        timestamp: "2025-01-01T00:00:00.000Z",
      },
    },
  })
  @ApiResponse({ status: 400, description: "Invalid quote options" })
  @ApiResponse({ status: 429, description: "Too many requests" })
  async getTokenCreationFeeQuote(
    @Query() query: GetTokenCreationFeeQuoteQueryDto
  ): Promise<TokenCreationFeeQuoteApiResponse> {
    const quote = await this.tokensService.getTokenCreationFeeQuote({
      include: query.include,
    });

    return {
      success: true,
      data: quote,
      cached: false,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /api/tokens/:address
   * Fetch detailed token information from the Stellar blockchain.
   */
  @Get(":address")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } }) // 60 req/min per IP
  @ApiOperation({
    summary: "Get token information",
    description:
      "Fetch token metadata, supply, burn statistics, and analytics from the Stellar network.",
  })
  @ApiParam({
    name: "address",
    description: "Token address in ASSET_CODE:ISSUER format",
    example: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  })
  @ApiQuery({
    name: "include",
    required: false,
    isArray: true,
    enum: TokenInclude,
    description: "Optional data fields to include",
  })
  @ApiResponse({
    status: 200,
    description: "Token information retrieved successfully",
    schema: {
      example: {
        success: true,
        data: {
          basicInfo: {
            name: "USDC",
            symbol: "USDC",
            decimals: 7,
            address:
              "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          },
          supplyInfo: {
            total: "1000000000.0000000",
            initial: "1000000000.0000000",
            circulating: "900000000.0000000",
          },
          burnInfo: {
            totalBurned: "0",
            burnCount: 0,
            percentBurned: "0.0000",
          },
          creator: {
            address: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            createdAt: "2021-01-01T00:00:00Z",
          },
          analytics: {
            volume24h: "0",
            volume7d: "0",
          },
        },
        cached: false,
        timestamp: "2025-01-01T00:00:00.000Z",
      },
    },
  })
  @ApiResponse({ status: 400, description: "Invalid address format" })
  @ApiResponse({ status: 404, description: "Token not found" })
  @ApiResponse({ status: 429, description: "Too many requests" })
  async getToken(
    @Param() params: GetTokenParamDto,
    @Query() query: GetTokenQueryDto
  ): Promise<TokenApiResponse> {
    const { token, cached } = await this.tokensService.getToken(
      params.address,
      { include: query.include }
    );

    return {
      success: true,
      data: token,
      cached,
      timestamp: new Date().toISOString(),
    };
  }
}
