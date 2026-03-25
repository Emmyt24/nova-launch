/**
 * Formatting utilities
 */

/**
 * Format XLM amount for display
 */
export function formatXLM(amount: string | number): string {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 7,
    }).format(num);
}

/**
 * Format large numbers with commas
 */
export function formatNumber(value: string | number): string {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Truncate Stellar address for display
 */
export function truncateAddress(address: string, startChars = 6, endChars = 4): string {
    if (address.length <= startChars + endChars) {
        return address;
    }
    return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/**
 * Format timestamp to readable date
 */
export function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(timestamp));
}

/**
 * Format timestamp to relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return `${days} day${days > 1 ? 's' : ''} ago`;
    }
    if (hours > 0) {
        return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }
    if (minutes > 0) {
        return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    }
    return 'Just now';
}

/**
 * Convert stroops to XLM
 */
export function stroopsToXLM(stroops: number | string): number {
    const num = typeof stroops === 'string' ? parseInt(stroops) : stroops;
    return num / 10_000_000;
}

/**
 * Convert XLM to stroops
 */
export function xlmToStroops(xlm: number | string): number {
    const num = typeof xlm === 'string' ? parseFloat(xlm) : xlm;
    return Math.floor(num * 10_000_000);
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Get error message from error object
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return 'An unknown error occurred';
}

/**
 * Format a BigInt string value for display with proper decimal handling
 * Handles token supply values that come as strings from the backend
 */
export function formatTokenSupply(
    value: string,
    decimals: number = 7,
    options: { compact?: boolean; maxDecimals?: number } = {}
): string {
    const { compact = false, maxDecimals = 2 } = options;

    if (!value || value === '0') {
        return '0';
    }

    try {
        const bigValue = BigInt(value);
        const divisor = BigInt(10 ** decimals);
        const wholePart = bigValue / divisor;
        const remainder = bigValue % divisor;

        if (compact) {
            return formatCompactNumber(Number(wholePart));
        }

        const wholeStr = wholePart.toString();
        if (remainder === BigInt(0)) {
            return formatNumber(wholeStr);
        }

        const decimalStr = remainder.toString().padStart(decimals, '0').slice(0, maxDecimals);
        const trimmedDecimal = decimalStr.replace(/0+$/, '');

        if (!trimmedDecimal) {
            return formatNumber(wholeStr);
        }

        return `${formatNumber(wholeStr)}.${trimmedDecimal}`;
    } catch {
        return formatNumber(value);
    }
}

/**
 * Format a number in compact notation (e.g., 1.5M, 2.3B)
 */
export function formatCompactNumber(value: number): string {
    if (value < 1000) {
        return value.toString();
    }

    const suffixes = ['', 'K', 'M', 'B', 'T'];
    const tier = Math.floor(Math.log10(Math.abs(value)) / 3);
    const suffix = suffixes[Math.min(tier, suffixes.length - 1)];
    const scale = Math.pow(10, tier * 3);
    const scaled = value / scale;

    return scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0) + suffix;
}

/**
 * Calculate percentage burned from supply strings
 */
export function calculateBurnPercentage(
    totalBurned: string,
    initialSupply: string
): number {
    if (!totalBurned || !initialSupply || initialSupply === '0') {
        return 0;
    }

    try {
        const burned = BigInt(totalBurned);
        const initial = BigInt(initialSupply);

        if (initial === BigInt(0)) {
            return 0;
        }

        const percentage = Number((burned * BigInt(10000)) / initial) / 100;
        return Math.min(percentage, 100);
    } catch {
        return 0;
    }
}

/**
 * Format burn statistics for display
 */
export function formatBurnStats(
    totalBurned: string,
    burnCount: number,
    initialSupply: string,
    decimals: number = 7
): { burnedAmount: string; burnCount: string; percentage: string } {
    const percentage = calculateBurnPercentage(totalBurned, initialSupply);

    return {
        burnedAmount: formatTokenSupply(totalBurned, decimals, { compact: true }),
        burnCount: formatNumber(burnCount),
        percentage: `${percentage.toFixed(2)}%`,
    };
}
