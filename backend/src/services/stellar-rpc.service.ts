import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

interface LatencySample {
  endpoint: string;
  durationMs: number;
  timestamp: number;
}

interface EndpointMetrics {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  slaBreaches: number;
}

const DEFAULT_SLA_MS = 2000;
const MAX_SAMPLES_PER_ENDPOINT = 1000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 200;

@Injectable()
export class StellarRpcService {
  private readonly logger = new Logger(StellarRpcService.name);
  private readonly http: AxiosInstance;
  private readonly slaMs: number;
  private readonly samples = new Map<string, LatencySample[]>();
  private readonly breachListeners: Array<(endpoint: string, durationMs: number) => void> = [];

  constructor(private readonly configService: ConfigService) {
    this.http = axios.create({
      timeout: this.configService.get<number>('STELLAR_RPC_TIMEOUT_MS', 10000),
    });
    this.slaMs = this.configService.get<number>('STELLAR_RPC_SLA_MS', DEFAULT_SLA_MS);
  }

  onSlaBreach(listener: (endpoint: string, durationMs: number) => void): void {
    this.breachListeners.push(listener);
  }

  async call<T = unknown>(
    endpoint: string,
    payload: Record<string, unknown>,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const start = Date.now();
    try {
      const response = await this.requestWithRetry<T>(endpoint, payload, config);
      return response;
    } finally {
      this.recordLatency(endpoint, Date.now() - start);
    }
  }

  private async requestWithRetry<T>(
    endpoint: string,
    payload: Record<string, unknown>,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.http.post<T>(endpoint, payload, config);
        return response.data;
      } catch (error) {
        lastError = error;
        const isRetryable = this.isRetryable(error);
        if (!isRetryable || attempt === MAX_RETRIES) {
          break;
        }
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        this.logger.warn(
          `Stellar RPC call to ${endpoint} failed (attempt ${attempt + 1}); retrying in ${backoff}ms`,
        );
        await this.sleep(backoff);
      }
    }
    this.logger.error(`Stellar RPC call to ${endpoint} failed after retries`);
    throw lastError;
  }

  private isRetryable(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }
    if (!error.response) {
      return true;
    }
    const status = error.response.status;
    return status >= 500 || status === 429;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private recordLatency(endpoint: string, durationMs: number): void {
    const list = this.samples.get(endpoint) ?? [];
    list.push({ endpoint, durationMs, timestamp: Date.now() });
    if (list.length > MAX_SAMPLES_PER_ENDPOINT) {
      list.shift();
    }
    this.samples.set(endpoint, list);

    if (durationMs > this.slaMs) {
      this.logger.warn(
        `Stellar RPC SLA breach on ${endpoint}: ${durationMs}ms exceeds ${this.slaMs}ms`,
      );
      for (const listener of this.breachListeners) {
        try {
          listener(endpoint, durationMs);
        } catch (err) {
          this.logger.error('SLA breach listener threw', err as Error);
        }
      }
    }
  }

  getMetrics(): Record<string, EndpointMetrics> {
    const result: Record<string, EndpointMetrics> = {};
    for (const [endpoint, list] of this.samples.entries()) {
      const durations = list.map((s) => s.durationMs).sort((a, b) => a - b);
      result[endpoint] = {
        count: durations.length,
        p50: this.percentile(durations, 50),
        p95: this.percentile(durations, 95),
        p99: this.percentile(durations, 99),
        slaBreaches: durations.filter((d) => d > this.slaMs).length,
      };
    }
    return result;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
  }
}
