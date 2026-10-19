export const IPFS_CONFIG = {
    apiKey: import.meta.env.VITE_IPFS_API_KEY || '',
    apiSecret: import.meta.env.VITE_IPFS_API_SECRET || '',
    pinataApiUrl: 'https://api.pinata.cloud',
    pinataGateway: 'https://gateway.pinata.cloud/ipfs',
} as const;

/**
 * Default ordered list of IPFS gateways to try when fetching metadata.
 * The first gateway is tried first; on failure the next is tried, and so on.
 * Pinata is listed first because it is the upload target and is most likely
 * to have the content immediately available.
 */
export const DEFAULT_IPFS_GATEWAYS: readonly string[] = [
    'https://gateway.pinata.cloud/ipfs',
    'https://ipfs.io/ipfs',
    'https://cloudflare-ipfs.com/ipfs',
    'https://dweb.link/ipfs',
];

/**
 * Parse the optional `VITE_IPFS_GATEWAYS` env override.
 * The value is expected to be a comma-separated list of gateway base URLs,
 * e.g. `https://gateway.pinata.cloud/ipfs,https://ipfs.io/ipfs`.
 * Empty entries and surrounding whitespace are ignored. If the override is
 * missing or contains no valid entries, the default list is used.
 */
function parseGatewayOverride(raw: string | undefined): readonly string[] {
    if (!raw) {
        return DEFAULT_IPFS_GATEWAYS;
    }
    const parsed = raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    return parsed.length > 0 ? parsed : DEFAULT_IPFS_GATEWAYS;
}

/**
 * Ordered list of IPFS gateways to try when fetching metadata.
 * Can be overridden at build time via `VITE_IPFS_GATEWAYS` (comma-separated).
 */
export const IPFS_GATEWAYS: readonly string[] = parseGatewayOverride(
    import.meta.env.VITE_IPFS_GATEWAYS,
);

/** Per-gateway fetch timeout in milliseconds. */
export const IPFS_GATEWAY_TIMEOUT_MS = 5_000;