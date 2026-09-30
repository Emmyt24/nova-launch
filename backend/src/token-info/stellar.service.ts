/**
 * StellarService — token-info read layer  (backend/src/token-info/)
 *
 * PURPOSE
 * -------
 * Thin HTTP client that reads token metadata, burn statistics, and trading
 * volume from the public Horizon REST API.  All methods are read-only: they
 * fetch data from the Stellar network and return it to the tokens module
 * without writing any on-chain state.
 *
 * HOW IT DIFFERS FROM THE OTHER StellarService
 * ---------------------------------------------
 * There is a second file with the identical class name located at:
 *   backend/src/stellar-service-integration/stellar.service.ts
 *
 * That service is the *write/transaction* layer: it owns the Soroban RPC
 * client, submits signed transactions to the factory contract, monitors
 * transaction status, and wraps the full retry/circuit-breaker/rate-limiter
 * stack needed for reliable contract invocations.
 *
 * This file (token-info) vs. that file (stellar-service-integration):
 *
 *   | Concern                | token-info (this file)     | stellar-service-integration |
 *   |------------------------|----------------------------|-----------------------------|
 *   | Storage tier used      | read-only                  | read + write (Soroban RPC)  |
 *   | Primary client         | Horizon HTTP (HttpService) | @stellar/stellar-sdk        |
 *   | Retry / circuit-breaker| none (simple HTTP)         | RateLimiter + CircuitBreaker|
 *   | Injected into          | TokensModule               | StellarModule               |
 *
 * If you are looking for the service that deploys tokens, mints, or manages
 * the factory contract, open:
 *   backend/src/stellar-service-integration/stellar.service.ts
 */
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import { StellarTokenData } from "./interfaces/token.interface";

interface StellarAssetResponse {
  _embedded: {
    records: StellarTokenData[];
  };
}

interface StellarOperationsResponse {
  _embedded: {
    records: Array<{
      type: string;
      created_at: string;
      source_account: string;
    }>;
  };
}

interface StellarTradesResponse {
  _embedded: {
    records: Array<{
      base_amount: string;
      counter_amount: string;
      ledger_close_time: string;
    }>;
  };
}

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly horizonUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.horizonUrl =
      this.configService.get<string>("STELLAR_HORIZON_URL") ||
      "https://horizon.stellar.org";
  }

  async getAssetData(
    assetCode: string,
    assetIssuer: string
  ): Promise<StellarTokenData | null> {
    try {
      const url = `${this.horizonUrl}/assets?asset_code=${assetCode}&asset_issuer=${assetIssuer}&limit=1`;
      const response = await firstValueFrom(
        this.httpService.get<StellarAssetResponse>(url)
      );
      const records = response.data?._embedded?.records;
      return records?.length > 0 ? records[0] : null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch asset data for ${assetCode}:${assetIssuer}`,
        error
      );
      return null;
    }
  }

  async getAssetCreationInfo(
    assetCode: string,
    assetIssuer: string
  ): Promise<{ creatorAddress: string; createdAt: string } | null> {
    try {
      const url = `${this.horizonUrl}/accounts/${assetIssuer}/operations?type=create_account&order=asc&limit=1`;
      const response = await firstValueFrom(
        this.httpService.get<StellarOperationsResponse>(url)
      );
      const records = response.data?._embedded?.records;
      if (records?.length > 0) {
        return {
          creatorAddress: records[0].source_account || assetIssuer,
          createdAt: records[0].created_at,
        };
      }
      // Fallback: return issuer as creator
      return {
        creatorAddress: assetIssuer,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.warn(
        `Could not fetch creation info for ${assetCode}:${assetIssuer}`,
        error
      );
      return {
        creatorAddress: assetIssuer,
        createdAt: new Date().toISOString(),
      };
    }
  }

  async getBurnStatistics(
    assetCode: string,
    assetIssuer: string,
    totalSupply: string
  ): Promise<{
    totalBurned: string;
    burnCount: number;
    percentBurned: string;
  }> {
    try {
      // Burns on Stellar = payments to the issuer account (which removes them from circulation)
      const url = `${this.horizonUrl}/accounts/${assetIssuer}/payments?limit=200&order=desc`;
      const response = await firstValueFrom(
        this.httpService.get<{
          _embedded: {
            records: Array<{
              type: string;
              amount: string;
              asset_code: string;
              to: string;
            }>;
          };
        }>(url)
      );

      const burnPayments =
        response.data?._embedded?.records?.filter(
          (r) =>
            r.type === "payment" &&
            r.asset_code === assetCode &&
            r.to === assetIssuer
        ) || [];

      const totalBurned = burnPayments
        .reduce((sum, r) => sum + parseFloat(r.amount || "0"), 0)
        .toFixed(7);

      const totalSupplyNum = parseFloat(totalSupply) || 0;
      const burnedNum = parseFloat(totalBurned);
      const percentBurned =
        totalSupplyNum > 0
          ? ((burnedNum / totalSupplyNum) * 100).toFixed(4)
          : "0.0000";

      return {
        totalBurned,
        burnCount: burnPayments.length,
        percentBurned,
      };
    } catch (error) {
      this.logger.warn(
        `Could not fetch burn stats for ${assetCode}:${assetIssuer}`,
        error
      );
      return { totalBurned: "0", burnCount: 0, percentBurned: "0.0000" };
    }
  }

  async getVolumeData(
    assetCode: string,
    assetIssuer: string
  ): Promise<{ volume24h: string; volume7d: string; txCount24h: number }> {
    try {
      const now = Date.now();
      const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const sevenDaysAgo = new Date(
        now - 7 * 24 * 60 * 60 * 1000
      ).toISOString();

      const url7d = `${this.horizonUrl}/trades?base_asset_type=credit_alphanum4&base_asset_code=${assetCode}&base_asset_issuer=${assetIssuer}&start_time=${sevenDaysAgo}&limit=200&order=desc`;

      const response = await firstValueFrom(
        this.httpService.get<StellarTradesResponse>(url7d)
      );

      const trades = response.data?._embedded?.records || [];
      const cutoff24h = new Date(oneDayAgo).getTime();

      let volume24h = 0;
      let volume7d = 0;
      let txCount24h = 0;

      trades.forEach((trade) => {
        const tradeTime = new Date(trade.ledger_close_time).getTime();
        const amount = parseFloat(trade.base_amount || "0");
        volume7d += amount;
        if (tradeTime >= cutoff24h) {
          volume24h += amount;
          txCount24h++;
        }
      });

      return {
        volume24h: volume24h.toFixed(7),
        volume7d: volume7d.toFixed(7),
        txCount24h,
      };
    } catch (error) {
      this.logger.warn(
        `Could not fetch volume for ${assetCode}:${assetIssuer}`,
        error
      );
      return { volume24h: "0", volume7d: "0", txCount24h: 0 };
    }
  }

  parseAddress(address: string): { assetCode: string; assetIssuer: string } {
    if (address.includes(":")) {
      const [assetCode, assetIssuer] = address.split(":");
      return { assetCode, assetIssuer };
    }
    // Pure Stellar address treated as issuer of native-like asset
    return { assetCode: "UNKNOWN", assetIssuer: address };
  }
}
