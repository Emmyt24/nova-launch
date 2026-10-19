import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { StellarService } from "./stellar.service";
import { IpfsService } from "./ipfs.service";
import { TokenCacheService } from "./token-cache.service";
import { TokenInclude } from "./dto/get-token-query.dto";
import {
  Token,
  TokenAnalytics,
  TokenBurnInfo,
  TokenCreator,
  TokenMetadata,
  TokenSupplyInfo,
} from "./interfaces/token.interface";

export interface GetTokenOptions {
  include?: TokenInclude[];
}

export interface TokenCreationFeeQuoteOptions {
  /** Number of decimal places for the token (defaults to 7, matching Stellar). */
  decimals?: number;
  /** Whether the token requires an issuer authorization flag. */
  requiresAuth?: boolean;
  /** Optional metadata payload size in bytes, which may affect the fee. */
  metadataSizeBytes?: number;
}

export interface TokenCreationFeeQuote {
  /** Total fee in stroops (1 XLM = 10,000,000 stroops). */
  feeStroops: string;
  /** Total fee in XLM, formatted with 7 decimal places. */
  feeXlm: string;
  /** Base fee component in stroops. */
  baseFeeStroops: string;
  /** Additional fee component in stroops. */
  additionalFeeStroops: string;
  /** The options the quote was computed for. */
  options: Required<TokenCreationFeeQuoteOptions>;
}

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    private readonly stellarService: StellarService,
    private readonly ipfsService: IpfsService,
    private readonly tokenCacheService: TokenCacheService
  ) {}

  async getToken(
    address: string,
    options: GetTokenOptions = {}
  ): Promise<{ token: Token; cached: boolean }> {
    const include = options.include || [];
    const cacheKey = this.tokenCacheService.buildKey(address, include);

    // Try cache first
    const cached = await this.tokenCacheService.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for token ${address}`);
      return { token: cached, cached: true };
    }

    const token = await this.fetchTokenData(address, include);

    // Cache the result
    await this.tokenCacheService.set(cacheKey, token);

    return { token, cached: false };
  }

  private async fetchTokenData(
    address: string,
    include: TokenInclude[]
  ): Promise<Token> {
    const { assetCode, assetIssuer } =
      this.stellarService.parseAddress(address);

    if (!assetCode || !assetIssuer) {
      throw new BadRequestException("Invalid token address format");
    }

    // Fetch base asset data from Stellar
    const assetData = await this.stellarService.getAssetData(
      assetCode,
      assetIssuer
    );

    if (!assetData) {
      throw new NotFoundException(
        `Token not found on Stellar network: ${address}`
      );
    }

    // Fetch creator info
    const creationInfo = await this.stellarService.getAssetCreationInfo(
      assetCode,
      assetIssuer
    );

    const creator: TokenCreator = {
      address: creationInfo?.creatorAddress || assetIssuer,
      createdAt: creationInfo?.createdAt || new Date().toISOString(),
    };

    // Calculate supply info
    const totalSupply = parseFloat(assetData.amount || "0");
    const authorizedBalance = parseFloat(assetData.balances?.authorized || "0");
    const circulatingSupply = Math.max(0, authorizedBalance).toString();

    const supplyInfo: TokenSupplyInfo = {
      total: assetData.amount || "0",
      initial: assetData.amount || "0", // Stellar doesn't expose initial; use current total
      circulating: circulatingSupply,
    };

    // Build token object
    const token: Token = {
      basicInfo: {
        name: assetCode, // Stellar assets don't have on-chain names; use code
        symbol: assetCode,
        decimals: 7, // Stellar uses 7 decimal places
        address,
      },
      supplyInfo,
      burnInfo: {
        totalBurned: "0",
        burnCount: 0,
        percentBurned: "0.0000",
      },
      creator,
      analytics: {
        volume24h: "0",
        volume7d: "0",
        txCount24h: 0,
      },
    };

    // Fetch optional data in parallel
    const optionalFetches: Promise<void>[] = [];

    if (include.includes(TokenInclude.BURNS)) {
      optionalFetches.push(
        this.stellarService
          .getBurnStatistics(assetCode, assetIssuer, supplyInfo.total)
          .then((burnInfo: TokenBurnInfo) => {
            token.burnInfo = burnInfo;
          })
      );
    }

    if (include.includes(TokenInclude.ANALYTICS)) {
      optionalFetches.push(
        this.stellarService
          .getVolumeData(assetCode, assetIssuer)
          .then(
            (volumeData: {
              volume24h: string;
              volume7d: string;
              txCount24h: number;
            }) => {
              token.analytics = volumeData as TokenAnalytics;
            }
          )
      );
    }

    if (include.includes(TokenInclude.METADATA)) {
      optionalFetches.push(
        this.fetchMetadataForAsset(assetIssuer).then(
          (metadata: TokenMetadata | null) => {
            if (metadata) token.metadata = metadata;
          }
        )
      );
    }

    if (optionalFetches.length > 0) {
      await Promise.allSettled(optionalFetches);
    }

    return token;
  }

  /**
   * Returns a read-only quote of the fee that would be charged for creating a
   * token with the given options. This mirrors the on-chain fee calculation so
   * clients can display the expected charge without submitting a transaction.
   */
  async getTokenCreationFeeQuote(
    options: TokenCreationFeeQuoteOptions = {}
  ): Promise<TokenCreationFeeQuote> {
    const resolvedOptions: Required<TokenCreationFeeQuoteOptions> = {
      decimals: options.decimals ?? 7,
      requiresAuth: options.requiresAuth ?? false,
      metadataSizeBytes: options.metadataSizeBytes ?? 0,
    };

    if (resolvedOptions.decimals < 0 || resolvedOptions.decimals > 18) {
      throw new BadRequestException(
        "decimals must be between 0 and 18 inclusive"
      );
    }

    if (resolvedOptions.metadataSizeBytes < 0) {
      throw new BadRequestException("metadataSizeBytes must not be negative");
    }

    const quote = await this.stellarService.getTokenCreationFeeQuote(
      resolvedOptions
    );

    return {
      feeStroops: quote.feeStroops,
      feeXlm: quote.feeXlm,
      baseFeeStroops: quote.baseFeeStroops,
      additionalFeeStroops: quote.additionalFeeStroops,
      options: resolvedOptions,
    };
  }

  private async fetchMetadataForAsset(
    assetIssuer: string
  ): Promise<TokenMetadata | null> {
    try {
      // Try fetching toml file from the issuer's home domain
      // For a production system, you'd fetch stellar.toml and parse CURRENCIES section
      // Here we attempt IPFS if hash is discoverable
      return null;
    } catch (error) {
      this.logger.warn(`Could not fetch metadata for issuer ${assetIssuer}`);
      return null;
    }
  }
}
