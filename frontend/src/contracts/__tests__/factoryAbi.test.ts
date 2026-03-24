/**
 * ABI drift regression tests.
 *
 * These tests verify that every method name in FACTORY_METHODS matches an
 * actual exported function in contracts/token-factory/src/lib.rs.
 *
 * If a contract function is renamed or removed, the corresponding entry in
 * factoryAbi.ts must be updated — and this test will catch the drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { FACTORY_METHODS } from '../factoryAbi';

// ---------------------------------------------------------------------------
// Parse exported function names from lib.rs
// ---------------------------------------------------------------------------
const LIB_RS_PATH = resolve(
  __dirname,
  '../../../../../contracts/token-factory/src/lib.rs'
);

function getContractExports(): Set<string> {
  const src = readFileSync(LIB_RS_PATH, 'utf-8');
  const matches = [...src.matchAll(/pub fn ([a-z_]+)\s*\(/g)];
  return new Set(matches.map((m) => m[1]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('FACTORY_METHODS registry', () => {
  const contractExports = getContractExports();

  it('lib.rs exports are parseable (sanity check)', () => {
    expect(contractExports.size).toBeGreaterThan(10);
  });

  it('every registry value matches an exported contract function', () => {
    const mismatches: string[] = [];

    for (const [key, methodName] of Object.entries(FACTORY_METHODS)) {
      if (!contractExports.has(methodName)) {
        mismatches.push(`FACTORY_METHODS.${key} = "${methodName}" — not found in lib.rs`);
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `ABI drift detected — update factoryAbi.ts to match lib.rs:\n` +
          mismatches.map((m) => `  • ${m}`).join('\n')
      );
    }
  });

  it('registry has no duplicate method name values', () => {
    const values = Object.values(FACTORY_METHODS);
    const seen = new Set<string>();
    const dupes: string[] = [];

    for (const v of values) {
      if (seen.has(v)) dupes.push(v);
      seen.add(v);
    }

    expect(dupes, `Duplicate method names: ${dupes.join(', ')}`).toHaveLength(0);
  });

  it('covers the critical call paths: create, burn, mint, buyback, governance', () => {
    expect(FACTORY_METHODS.create_tokens).toBe('set_metadata');
    expect(FACTORY_METHODS.burn).toBe('burn');
    expect(FACTORY_METHODS.admin_burn).toBe('admin_burn');
    expect(FACTORY_METHODS.mint).toBe('mint');
    expect(FACTORY_METHODS.create_buyback_campaign).toBe('create_buyback_campaign');
    expect(FACTORY_METHODS.get_buyback_campaign).toBe('get_buyback_campaign');
    expect(FACTORY_METHODS.update_governance_config).toBe('update_governance_config');
    expect(FACTORY_METHODS.get_governance_config).toBe('get_governance_config');
  });
});
