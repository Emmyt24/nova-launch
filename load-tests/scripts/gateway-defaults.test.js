import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  BACKEND_DEFAULT_PORT,
  BACKEND_DEFAULT_BASE_URL,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from '../config/gateway-defaults.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');

describe('gateway-defaults', () => {
  it('uses backend default port 3001', () => {
    expect(BACKEND_DEFAULT_PORT).toBe(3001);
    expect(BACKEND_DEFAULT_BASE_URL).toBe('http://localhost:3001');
  });

  it('uses the 100 req / 15 min default rate-limit tier', () => {
    expect(RATE_LIMIT_WINDOW_MS).toBe(900000);
    expect(RATE_LIMIT_MAX_REQUESTS).toBe(100);
  });

  it('matches the PORT default in backend/src/config/env.ts', () => {
    const src = read('backend/src/config/env.ts');
    const m = src.match(/process\.env\.PORT \|\| '(\d+)'/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(BACKEND_DEFAULT_PORT);
  });

  it('matches the rate-limit defaults in backend/src/middleware/rateLimiter.ts', () => {
    const src = read('backend/src/middleware/rateLimiter.ts');
    const windowMatch = src.match(/RATE_LIMIT_WINDOW_MS \|\| "(\d+)"/);
    const maxMatch = src.match(/RATE_LIMIT_MAX_REQUESTS \|\| "(\d+)"/);
    expect(Number(windowMatch[1])).toBe(RATE_LIMIT_WINDOW_MS);
    expect(Number(maxMatch[1])).toBe(RATE_LIMIT_MAX_REQUESTS);
  });

  it('runbook health check targets the backend default port', () => {
    const runbook = read('docs/PRODUCTION_INTEGRATION_RUNBOOK.md');
    expect(runbook).toContain(`http://localhost:${BACKEND_DEFAULT_PORT}/health`);
    expect(runbook).not.toContain('http://localhost:3000/health');
  });
});
