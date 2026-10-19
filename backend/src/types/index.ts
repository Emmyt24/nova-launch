export interface User {
  id: string;
  address: string;
  role: "user" | "admin" | "super_admin";
  banned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Token {
  id: string;
  name: string;
  symbol: string;
  contractAddress: string;
  creatorAddress: string;
  totalSupply: string;
  burned: string;
  flagged: boolean;
  deleted: boolean;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  adminId: string;
  action: string;
  resource: string;
  resourceId: string;
  beforeState: Record<string, any> | null;
  afterState: Record<string, any> | null;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
}

export interface AdminStats {
  totalTokens: number;
  totalBurns: number;
  totalVolumeBurned: string;
  activeUsers: number;
  revenueGenerated: string;
  platformHealth: {
    uptime: number;
    errorRate: number;
    avgResponseTime: number;
  };
  growth: {
    daily: GrowthMetrics;
    weekly: GrowthMetrics;
    monthly: GrowthMetrics;
  };
}

export interface GrowthMetrics {
  newTokens: number;
  newUsers: number;
  burnVolume: string;
  revenue: string;
}

export interface AdminRequest extends Express.Request {
  admin?: User;
}

export * from "./notification";

export type {
  Network,
  ExplorerProvider,
  ExplorerEntityType,
} from "../config/explorer";