/**
 * Bundle-size regression tests
 *
 * Fails CI when any production chunk exceeds its budget, preventing silent
 * size regressions from slipping through code review.
 *
 * Updating the budget intentionally
 * ──────────────────────────────────
 * 1. Run `npm run build` to produce a fresh dist/.
 * 2. Note the actual sizes logged when this suite runs.
 * 3. Edit the BUDGETS object below with the new approved limits.
 * 4. Add a comment explaining the size increase and link the PR/issue.
 * 5. Commit the budget change alongside the feature that grew the bundle.
 *
 * Running locally
 * ───────────────
 * npm run build && npx vitest run src/test/performance/bundle-size-regression.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

// ── Budget configuration ───────────────────────────────────────────────────────
// Sizes are in bytes.  Keep these values in sync with the actual built output
// and bump them only via an intentional PR (see instructions above).

const BUDGETS = {
  /** Main entry chunk produced by Vite (index-*.js or main-*.js). */
  mainChunk: 300 * 1024,   // 300 KB
  /** Sum of all JS assets in dist/assets. */
  totalJs: 600 * 1024,     // 600 KB
  /** Any individual vendor chunk (chunk name contains "vendor"). */
  vendorChunk: 250 * 1024, // 250 KB
  /** Sum of all CSS assets in dist/assets. */
  totalCss: 80 * 1024,     //  80 KB
} as const;

// ── Helpers ────────────────────────────────────────────────────────────────────

const DIST_ASSETS = join(process.cwd(), 'dist', 'assets');

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function collectFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const all: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      all.push(...collectFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      all.push(full);
    }
  }
  return all;
}

function fileSize(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('Bundle-size regression', () => {
  let jsFiles: string[] = [];
  let cssFiles: string[] = [];
  let distExists: boolean;

  beforeAll(() => {
    distExists = existsSync(DIST_ASSETS);
    jsFiles = collectFiles(DIST_ASSETS, '.js');
    cssFiles = collectFiles(DIST_ASSETS, '.css');
  });

  it('dist/assets directory exists (run npm run build first)', () => {
    expect(
      distExists,
      'dist/assets not found — run `npm run build` before this suite'
    ).toBe(true);
  });

  it('main entry chunk is within budget', () => {
    if (!distExists) return;

    const main = jsFiles.find(
      (f) => /\/(index|main)[^/]*\.js$/.test(f) && !f.includes('vendor')
    );

    if (!main) {
      console.warn('⚠  Main chunk not identified; skipping size assertion');
      return;
    }

    const size = fileSize(main);
    console.log(`📦 Main chunk: ${kb(size)} (budget: ${kb(BUDGETS.mainChunk)})`);

    expect(
      size,
      `Main chunk (${kb(size)}) exceeds budget (${kb(BUDGETS.mainChunk)}). ` +
      'See the "Updating the budget intentionally" instructions at the top of this file.'
    ).toBeLessThanOrEqual(BUDGETS.mainChunk);
  });

  it('total JS bundle is within budget', () => {
    if (!distExists || jsFiles.length === 0) return;

    const total = jsFiles.reduce((sum, f) => sum + fileSize(f), 0);
    console.log(`📦 Total JS: ${kb(total)} (budget: ${kb(BUDGETS.totalJs)})`);

    expect(
      total,
      `Total JS (${kb(total)}) exceeds budget (${kb(BUDGETS.totalJs)}). ` +
      'See the "Updating the budget intentionally" instructions at the top of this file.'
    ).toBeLessThanOrEqual(BUDGETS.totalJs);
  });

  it('every vendor chunk is within budget', () => {
    if (!distExists) return;

    const vendors = jsFiles.filter((f) => f.includes('vendor'));
    if (vendors.length === 0) return;

    for (const f of vendors) {
      const size = fileSize(f);
      const name = f.split('/').pop()!;
      console.log(`📦 Vendor chunk ${name}: ${kb(size)} (budget: ${kb(BUDGETS.vendorChunk)})`);

      expect(
        size,
        `Vendor chunk ${name} (${kb(size)}) exceeds budget (${kb(BUDGETS.vendorChunk)}). ` +
        'See the "Updating the budget intentionally" instructions at the top of this file.'
      ).toBeLessThanOrEqual(BUDGETS.vendorChunk);
    }
  });

  it('total CSS bundle is within budget', () => {
    if (!distExists || cssFiles.length === 0) return;

    const total = cssFiles.reduce((sum, f) => sum + fileSize(f), 0);
    console.log(`📦 Total CSS: ${kb(total)} (budget: ${kb(BUDGETS.totalCss)})`);

    expect(
      total,
      `Total CSS (${kb(total)}) exceeds budget (${kb(BUDGETS.totalCss)}). ` +
      'See the "Updating the budget intentionally" instructions at the top of this file.'
    ).toBeLessThanOrEqual(BUDGETS.totalCss);
  });

  it('bundle report (informational)', () => {
    if (!distExists || jsFiles.length === 0) return;

    console.log('\n📊 Bundle size report:');
    console.log('─'.repeat(55));
    for (const f of jsFiles) {
      const name = f.split('/').pop()!;
      console.log(`  ${name.padEnd(40)} ${kb(fileSize(f)).padStart(10)}`);
    }
    if (cssFiles.length) {
      console.log('  CSS:');
      for (const f of cssFiles) {
        const name = f.split('/').pop()!;
        console.log(`  ${name.padEnd(40)} ${kb(fileSize(f)).padStart(10)}`);
      }
    }
    const totalJs = jsFiles.reduce((s, f) => s + fileSize(f), 0);
    const totalCss = cssFiles.reduce((s, f) => s + fileSize(f), 0);
    console.log('─'.repeat(55));
    console.log(`  ${'Total JS'.padEnd(40)} ${kb(totalJs).padStart(10)}`);
    console.log(`  ${'Total CSS'.padEnd(40)} ${kb(totalCss).padStart(10)}`);
    console.log(`  ${'Grand total'.padEnd(40)} ${kb(totalJs + totalCss).padStart(10)}`);
    console.log('─'.repeat(55) + '\n');

    // Always passes — this test exists only for the report output.
    expect(true).toBe(true);
  });
});
