import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, SelectQueryBuilder } from "typeorm";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Inject } from "@nestjs/common";
import { Cache } from "cache-manager";
import { BurnTransaction } from "./burn-transaction.entity";
import {
  BurnHistoryQueryDto,
  BurnType,
  SortBy,
  SortOrder,
} from "./burn-history-query.dto";
import {
  BurnHistoryResponse,
  AppliedFilters,
} from "./burn-history.interface";

@Injectable()
export class BurnHistoryService {
  private readonly logger = new Logger(BurnHistoryService.name);
  private readonly CACHE_TTL = 60; // seconds
  private readonly CACHE_PREFIX = "burn_history";

  constructor(
    @InjectRepository(BurnTransaction)
    private readonly burnRepository: Repository<BurnTransaction>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache
  ) {}

  async getHistory(query: BurnHistoryQueryDto): Promise<BurnHistoryResponse> {
    const cacheKey = this.buildCacheKey(query);

    const cached = await this.cacheManager.get<BurnHistoryResponse>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for key: ${cacheKey}`);
      return cached;
    }

    const {
      tokenAddress,
      type = BurnType.ALL,
      startDate,
      endDate,
      page = 1,
      limit = 10,
      sortBy = SortBy.TIMESTAMP,
      sortOrder = SortOrder.DESC,
    } = query;

    const qb = this.buildQuery({
      tokenAddress,
      type,
      startDate,
      endDate,
      sortBy,
      sortOrder,
    });

    const total = await qb.getCount();
    const totalPages = Math.ceil(total / limit);

    const data = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    const appliedFilters: AppliedFilters = {
      ...(tokenAddress && { tokenAddress }),
      ...(type !== BurnType.ALL && { type }),
      ...(startDate && { startDate }),
      ...(endDate && { endDate }),
      sortBy,
      sortOrder,
    };

    const response: BurnHistoryResponse = {
      success: true,
      data: data.map((tx) => ({
        id: tx.id,
        tokenAddress: tx.tokenAddress,
        amount: tx.amount,
        from: tx.from,
        type: tx.type,
        transactionHash: tx.transactionHash,
        blockNumber: tx.blockNumber,
        timestamp: tx.timestamp,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      filters: appliedFilters,
    };

    await this.cacheManager.set(cacheKey, response, this.CACHE_TTL * 1000);
    this.logger.debug(`Cached result for key: ${cacheKey}`);

    return response;
  }

  private buildQuery(params: {
    tokenAddress?: string;
    type: BurnType;
    startDate?: string;
    endDate?: string;
    sortBy: SortBy;
    sortOrder: SortOrder;
  }): SelectQueryBuilder<BurnTransaction> {
    const { tokenAddress, type, startDate, endDate, sortBy, sortOrder } =
      params;

    const qb = this.burnRepository
      .createQueryBuilder("bt")
      .select([
        "bt.id",
        "bt.tokenAddress",
        "bt.amount",
        "bt.from",
        "bt.type",
        "bt.transactionHash",
        "bt.blockNumber",
        "bt.timestamp",
      ]);

    if (tokenAddress) {
      qb.andWhere("bt.tokenAddress = :tokenAddress", { tokenAddress });
    }

    if (type !== BurnType.ALL) {
      qb.andWhere("bt.type = :type", { type });
    }

    if (startDate) {
      qb.andWhere("bt.timestamp >= :startDate", {
        startDate: new Date(startDate),
      });
    }

    if (endDate) {
      qb.andWhere("bt.timestamp <= :endDate", { endDate: new Date(endDate) });
    }

    const sortColumn = this.resolveSortColumn(sortBy);
    qb.orderBy(sortColumn, sortOrder.toUpperCase() as "ASC" | "DESC");

    return qb;
  }

  private resolveSortColumn(sortBy: SortBy): string {
    const map: Record<SortBy, string> = {
      [SortBy.TIMESTAMP]: "bt.timestamp",
      [SortBy.AMOUNT]: "bt.amount",
      [SortBy.FROM]: "bt.from",
    };
    return map[sortBy] ?? "bt.timestamp";
  }

  private buildCacheKey(query: BurnHistoryQueryDto): string {
    const parts = [
      this.CACHE_PREFIX,
      query.tokenAddress ?? "all",
      query.type ?? BurnType.ALL,
      query.startDate ?? "none",
      query.endDate ?? "none",
      query.page ?? 1,
      query.limit ?? 10,
      query.sortBy ?? SortBy.TIMESTAMP,
      query.sortOrder ?? SortOrder.DESC,
    ];
    return parts.join(":");
  }

  async invalidateCache(tokenAddress?: string): Promise<void> {
    // Pattern-based invalidation if your cache manager supports it
    // For simple implementations, log the intent
    this.logger.log(
      `Cache invalidation triggered${tokenAddress ? ` for token: ${tokenAddress}` : ""}`
    );
  }
}
