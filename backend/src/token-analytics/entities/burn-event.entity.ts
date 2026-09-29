import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export enum BurnType {
  SELF = "self",
  ADMIN = "admin",
}

/**
 * BurnEvent — the token-analytics burn model.
 *
 * This entity backs the `token-analytics` module and is optimized for
 * time-bucketed analytics aggregation: rows are indexed by
 * (`tokenAddress`, `burnedAt`) and (`tokenAddress`, `burner`) so the
 * analytics service can roll burns up into per-token/per-window metrics
 * (totals, trends, top burners) without scanning a full transaction log.
 *
 * Distinct from `burn-history`'s `BurnTransaction` entity, which is the
 * detailed per-transaction audit log (one row per burn transaction, with
 * full transaction metadata) used for history/audit queries. Use this
 * entity when recording or querying burns for analytics aggregation; use
 * `BurnTransaction` when you need the per-transaction audit trail.
 *
 * Deliberate exception: analytics-only ingestion paths may write here
 * without a corresponding `BurnTransaction` row, so the two stores are
 * not guaranteed to be 1:1.
 */
@Entity("burn_events")
@Index(["tokenAddress", "burnedAt"])
@Index(["tokenAddress", "burner"])
export class BurnEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "token_address" })
  @Index()
  tokenAddress: string;

  @Column({ name: "burner_address" })
  burner: string;

  @Column({ type: "numeric", precision: 78, scale: 0, name: "amount" })
  amount: string;

  @Column({
    type: "enum",
    enum: BurnType,
    default: BurnType.SELF,
    name: "burn_type",
  })
  burnType: BurnType;

  @Column({ name: "transaction_hash", nullable: true })
  txHash: string;

  @Column({ name: "block_number", type: "bigint", nullable: true })
  blockNumber: string;

  @CreateDateColumn({ name: "burned_at" })
  burnedAt: Date;
}
