import { describe, it, expect } from 'vitest';
import { getDeploymentFeeBreakdown, formatFeeAmount, FALLBACK_BASE_FEE, FALLBACK_METADATA_FEE } from '../feeCalculation';

describe('feeCalculation – accuracy, denominations, and boundary inputs', () => {

    // ── Representative inputs ──────────────────────────────────────────────

    it('returns correct breakdown without metadata (default fees)', () => {
        const r = getDeploymentFeeBreakdown(false);
        expect(r).toEqual({ baseFee: 7, metadataFee: 0, totalFee: 7 });
    });

    it('returns correct breakdown with metadata (default fees)', () => {
        const r = getDeploymentFeeBreakdown(true);
        expect(r).toEqual({ baseFee: 7, metadataFee: 3, totalFee: 10 });
    });

    it('uses supplied baseFee and metadataFee when provided', () => {
        const r = getDeploymentFeeBreakdown(true, 5, 2);
        expect(r).toEqual({ baseFee: 5, metadataFee: 2, totalFee: 7 });
    });

    it('metadataFee is 0 when hasMetadata=false regardless of supplied metadataFee', () => {
        const r = getDeploymentFeeBreakdown(false, 5, 2);
        expect(r.metadataFee).toBe(0);
        expect(r.totalFee).toBe(5);
    });

    // ── totalFee invariant ─────────────────────────────────────────────────

    it('totalFee always equals baseFee + metadataFee', () => {
        const cases: [boolean, number, number][] = [
            [false, 7, 3],
            [true, 7, 3],
            [true, 0, 0],
            [true, 100, 50],
            [false, 0, 0],
        ];
        for (const [meta, base, mFee] of cases) {
            const r = getDeploymentFeeBreakdown(meta, base, mFee);
            expect(r.totalFee).toBe(r.baseFee + r.metadataFee);
        }
    });

    // ── Boundary / edge inputs ─────────────────────────────────────────────

    it('handles zero fees without throwing', () => {
        const r = getDeploymentFeeBreakdown(true, 0, 0);
        expect(r).toEqual({ baseFee: 0, metadataFee: 0, totalFee: 0 });
    });

    it('handles very large fee values deterministically', () => {
        const r = getDeploymentFeeBreakdown(true, 1_000_000, 500_000);
        expect(r.totalFee).toBe(1_500_000);
    });

    it('handles fractional XLM fees with correct precision', () => {
        const r = getDeploymentFeeBreakdown(true, 7.5, 2.5);
        expect(r.baseFee).toBe(7.5);
        expect(r.metadataFee).toBe(2.5);
        expect(r.totalFee).toBeCloseTo(10, 10);
    });

    // ── Determinism ────────────────────────────────────────────────────────

    it('is deterministic – same inputs always produce same output', () => {
        const a = getDeploymentFeeBreakdown(true, 7, 3);
        const b = getDeploymentFeeBreakdown(true, 7, 3);
        expect(a).toEqual(b);
    });

    // ── Fallback constants ─────────────────────────────────────────────────

    it('FALLBACK_BASE_FEE matches the default baseFee used in breakdown', () => {
        const r = getDeploymentFeeBreakdown(false);
        expect(r.baseFee).toBe(FALLBACK_BASE_FEE);
    });

    it('FALLBACK_METADATA_FEE matches the default metadataFee used in breakdown', () => {
        const r = getDeploymentFeeBreakdown(true);
        expect(r.metadataFee).toBe(FALLBACK_METADATA_FEE);
    });

    // ── formatFeeAmount ────────────────────────────────────────────────────

    it('formatFeeAmount appends " XLM" suffix', () => {
        expect(formatFeeAmount(7)).toBe('7 XLM');
        expect(formatFeeAmount(10)).toBe('10 XLM');
        expect(formatFeeAmount(0)).toBe('0 XLM');
    });

    it('formatFeeAmount handles fractional amounts', () => {
        expect(formatFeeAmount(7.5)).toBe('7.5 XLM');
        expect(formatFeeAmount(3.14)).toBe('3.14 XLM');
    });

    it('formatFeeAmount output is stable for the same input', () => {
        expect(formatFeeAmount(7)).toBe(formatFeeAmount(7));
    });
});
