import Redis from 'ioredis';

const LOCAL_REDIS_URL = 'redis://localhost:6379';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Resolve the Redis connection URL.
 *
 * In production, an explicit REDIS_URL or REDIS_HOST must be configured;
 * silently falling back to localhost hides misconfiguration (rate limiting
 * and nonces would misbehave). In development/test the local default is kept.
 */
function resolveRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url) {
    return url;
  }

  const host = process.env.REDIS_HOST;
  if (host) {
    const port = process.env.REDIS_PORT ?? '6379';
    return `redis://${host}:${port}`;
  }

  if (isProduction()) {
    throw new Error(
      'Redis is not configured: set REDIS_URL or REDIS_HOST in production. ' +
        'Refusing to fall back to localhost.',
    );
  }

  return LOCAL_REDIS_URL;
}

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(resolveRedisUrl());
  }
  return client;
}

export function closeRedisClient(): Promise<void> {
  if (!client) {
    return Promise.resolve();
  }
  const current = client;
  client = null;
  return current.quit().then(() => undefined);
}
