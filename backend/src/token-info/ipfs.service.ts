import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import { TokenMetadata } from "./interfaces/token.interface";

@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);
  private readonly ipfsGateways: string[];
  private readonly timeoutMs: number;
  private lastWorkingGateway: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.ipfsGateways = this.parseGateways();
    this.timeoutMs = this.configService.get<number>("IPFS_TIMEOUT_MS") || 5000;
  }

  private parseGateways(): string[] {
    const listConfig = this.configService.get<string>("IPFS_GATEWAY_URLS");
    const singleConfig = this.configService.get<string>("IPFS_GATEWAY_URL");

    const raw = listConfig || singleConfig;
    const gateways = (raw || "https://ipfs.io/ipfs")
      .split(",")
      .map((g) => g.trim().replace(/\/+$/, ""))
      .filter((g) => g.length > 0);

    return gateways.length > 0 ? gateways : ["https://ipfs.io/ipfs"];
  }

  /**
   * Returns the ordered list of gateways, with the last known working
   * gateway moved to the front so it is tried first.
   */
  private getOrderedGateways(): string[] {
    if (!this.lastWorkingGateway) return this.ipfsGateways;
    const rest = this.ipfsGateways.filter(
      (g) => g !== this.lastWorkingGateway
    );
    return [this.lastWorkingGateway, ...rest];
  }

  async fetchMetadata(ipfsHashOrUrl: string): Promise<TokenMetadata | null> {
    if (!ipfsHashOrUrl) return null;

    // Already a full HTTP URL: no gateway fallback applies.
    if (
      ipfsHashOrUrl.startsWith("http://") ||
      ipfsHashOrUrl.startsWith("https://")
    ) {
      return this.fetchFromUrl(ipfsHashOrUrl);
    }

    const path = this.extractPath(ipfsHashOrUrl);
    if (!path) return null;

    for (const gateway of this.getOrderedGateways()) {
      const url = `${gateway}/${path}`;
      const metadata = await this.fetchFromUrl(url);
      if (metadata !== null) {
        this.lastWorkingGateway = gateway;
        return metadata;
      }
    }

    this.logger.warn(
      `Failed to fetch metadata for ${ipfsHashOrUrl} from all gateways`
    );
    return null;
  }

  private async fetchFromUrl(url: string): Promise<TokenMetadata | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<TokenMetadata>(url, {
          timeout: this.timeoutMs,
        })
      );
      return this.sanitizeMetadata(response.data);
    } catch (error) {
      this.logger.warn(`Failed to fetch metadata from ${url}`, error?.message);
      return null;
    }
  }

  private extractPath(ipfsHashOrUrl: string): string | null {
    // ipfs:// protocol
    if (ipfsHashOrUrl.startsWith("ipfs://")) {
      return ipfsHashOrUrl.replace("ipfs://", "");
    }

    // Raw IPFS hash (Qm... or bafy...)
    if (ipfsHashOrUrl.startsWith("Qm") || ipfsHashOrUrl.startsWith("bafy")) {
      return ipfsHashOrUrl;
    }

    return null;
  }

  resolveUrl(ipfsHashOrUrl: string): string | null {
    if (!ipfsHashOrUrl) return null;

    // Already a full HTTP URL
    if (
      ipfsHashOrUrl.startsWith("http://") ||
      ipfsHashOrUrl.startsWith("https://")
    ) {
      return ipfsHashOrUrl;
    }

    const path = this.extractPath(ipfsHashOrUrl);
    if (!path) return null;

    return `${this.getOrderedGateways()[0]}/${path}`;
  }

  private sanitizeMetadata(raw: unknown): TokenMetadata {
    if (!raw || typeof raw !== "object") return {};
    const r = raw as Record<string, unknown>;
    return {
      image: typeof r.image === "string" ? r.image : undefined,
      description:
        typeof r.description === "string" ? r.description : undefined,
      externalUrl:
        typeof r.external_url === "string" ? r.external_url : undefined,
      attributes: Array.isArray(r.attributes)
        ? (r.attributes as Record<string, unknown>[])
        : undefined,
    };
  }
}
