import axios, { AxiosInstance } from 'axios';

export interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

/**
 * Default ordered list of IPFS gateways used for fetching metadata and logos.
 * Overridable via the REACT_APP_IPFS_GATEWAYS env var (comma-separated).
 */
export const DEFAULT_IPFS_GATEWAYS: string[] = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
];

/** Default per-gateway request timeout in milliseconds. */
export const DEFAULT_IPFS_GATEWAY_TIMEOUT_MS = 5000;

/**
 * Parses the ordered gateway list from config.
 * Falls back to DEFAULT_IPFS_GATEWAYS when unset/empty.
 */
export function resolveGateways(raw?: string | null): string[] {
  if (!raw) return [...DEFAULT_IPFS_GATEWAYS];
  const parsed = raw
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => (g.endsWith('/') ? g : `${g}/`));
  return parsed.length > 0 ? parsed : [...DEFAULT_IPFS_GATEWAYS];
}

/**
 * Resolves the per-gateway timeout from config.
 */
export function resolveTimeout(raw?: string | null): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IPFS_GATEWAY_TIMEOUT_MS;
}

/**
 * Builds a full gateway URL for a given CID/path.
 */
export function buildGatewayUrl(gateway: string, cid: string): string {
  const base = gateway.endsWith('/') ? gateway : `${gateway}/`;
  const path = cid.replace(/^\/+/, '');
  return `${base}${path}`;
}

/**
 * GatewayManager attempts an ordered list of IPFS gateways, falling back on
 * error or timeout, and caches the last successful gateway for subsequent
 * fetches.
 */
export class GatewayManager {
  private gateways: string[];
  private timeoutMs: number;
  private lastWorkingGateway: string | null = null;

  constructor(gateways?: string[], timeoutMs?: number) {
    this.gateways = gateways && gateways.length > 0 ? gateways : resolveGateways(
      typeof process !== 'undefined' ? process.env.REACT_APP_IPFS_GATEWAYS : undefined,
    );
    this.timeoutMs =
      timeoutMs ??
      resolveTimeout(
        typeof process !== 'undefined' ? process.env.REACT_APP_IPFS_GATEWAY_TIMEOUT_MS : undefined,
      );
  }

  /** Returns the currently cached working gateway, if any. */
  getCachedGateway(): string | null {
    return this.lastWorkingGateway;
  }

  /** Returns the configured ordered gateway list. */
  getGateways(): string[] {
    return [...this.gateways];
  }

  /** Returns the configured timeout in milliseconds. */
  getTimeout(): number {
    return this.timeoutMs;
  }

  /**
   * Returns the ordered list of gateways to try, putting the cached working
   * gateway first.
   */
  private orderedGateways(): string[] {
    if (!this.lastWorkingGateway) return [...this.gateways];
    return [
      this.lastWorkingGateway,
      ...this.gateways.filter((g) => g !== this.lastWorkingGateway),
    ];
  }

  /**
   * Fetches a resource from the first gateway that succeeds.
   * Falls back to the next gateway on error or timeout.
   * @param cid The IPFS CID / path to fetch.
   * @param init Optional fetch init.
   */
  async fetch(cid: string, init?: RequestInit): Promise<Response> {
    const gateways = this.orderedGateways();
    let lastError: unknown = null;

    for (const gateway of gateways) {
      const url = buildGatewayUrl(gateway, cid);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Gateway ${gateway} responded with status ${response.status}`);
        }
        this.lastWorkingGateway = gateway;
        return response;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(
      `IPFS fetch failed for "${cid}" across all gateways: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /**
   * Fetches and parses JSON metadata from IPFS.
   */
  async fetchJSON<T = unknown>(cid: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(cid, init);
    return (await response.json()) as T;
  }

  /**
   * Fetches a logo/image from IPFS and returns it as a Blob.
   */
  async fetchLogo(cid: string, init?: RequestInit): Promise<Blob> {
    const response = await this.fetch(cid, init);
    return await response.blob();
  }
}

class IPFSService {
  private client: AxiosInstance;
  private gatewayManager: GatewayManager;

  constructor() {
    // 1. Requirement: Configure Pinata API client & Auth
    const apiKey = process.env.REACT_APP_PINATA_API_KEY;
    const apiSecret = process.env.REACT_APP_PINATA_API_SECRET;

    if (!apiKey || !apiSecret) {
      console.warn('IPFSService: Pinata credentials missing from environment.');
    }

    this.client = axios.create({
      baseURL: 'https://api.pinata.cloud',
      headers: {
        pinata_api_key: apiKey,
        pinata_secret_api_key: apiSecret,
      },
    });

    this.gatewayManager = new GatewayManager();
  }

  /** Returns the gateway manager used for metadata/logo fetching. */
  getGatewayManager(): GatewayManager {
    return this.gatewayManager;
  }

  /**
   * Fetches JSON metadata from IPFS with gateway fallback.
   */
  async fetchMetadata<T = unknown>(cid: string): Promise<T> {
    return this.gatewayManager.fetchJSON<T>(cid);
  }

  /**
   * Fetches a logo/image from IPFS with gateway fallback.
   */
  async fetchLogo(cid: string): Promise<Blob> {
    return this.gatewayManager.fetchLogo(cid);
  }

  /**
   * Uploads JSON metadata to IPFS
   * @param metadata The object to pin (e.g., Token metadata)
   */
  async uploadJSON(metadata: object): Promise<string> {
    try {
      const response = await this.client.post<PinataResponse>('/pinning/pinJSONToIPFS', {
        pinataContent: metadata,
      });
      return response.data.IpfsHash;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  // 2. Requirement: Handle API errors
  private handleError(error: any) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.error || error.message;
      console.error(`IPFS Service Error: ${message}`);
    } else {
      console.error('An unexpected error occurred in IPFSService');
    }
  }
}

export const ipfsService = new IPFSService();
export const gatewayManager = ipfsService.getGatewayManager();
