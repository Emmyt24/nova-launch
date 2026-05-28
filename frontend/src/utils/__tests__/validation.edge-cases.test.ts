import { describe, it, expect } from 'vitest';
import {
    isValidStellarAddress,
    isValidTokenName,
    isValidTokenSymbol,
    isValidDecimals,
    isValidSupply,
    validateTokenParams,
} from '../validation';

// A known-good 56-char Stellar address (G + 55 base32 chars)
const VALID_ADDR = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

// ── isValidStellarAddress ──────────────────────────────────────────────────

describe('isValidStellarAddress', () => {
    const valid = [
        ['standard G-address', VALID_ADDR],
        ['all-uppercase base32 chars', 'G' + 'A'.repeat(55)],
        ['digits 2-7 in body', 'G' + '2'.repeat(55)],
    ] as const;

    const invalid = [
        ['empty string', ''],
        ['whitespace only', '   '],
        ['wrong prefix A', 'A' + 'A'.repeat(55)],
        ['wrong prefix C (contract)', 'C' + 'A'.repeat(55)],
        ['too short (55 chars)', 'G' + 'A'.repeat(54)],
        ['too long (57 chars)', 'G' + 'A'.repeat(56)],
        ['lowercase body', 'G' + 'a'.repeat(55)],
        ['invalid char 0', 'G' + '0' + 'A'.repeat(54)],
        ['invalid char 1', 'G' + '1' + 'A'.repeat(54)],
        ['invalid char 8', 'G' + '8' + 'A'.repeat(54)],
        ['special chars', 'G' + '!'.repeat(55)],
        ['spaces inside', 'G' + 'A'.repeat(27) + ' ' + 'A'.repeat(27)],
    ] as const;

    it.each(valid)('accepts %s', (_label, addr) => {
        expect(isValidStellarAddress(addr)).toBe(true);
    });

    it.each(invalid)('rejects %s', (_label, addr) => {
        expect(isValidStellarAddress(addr)).toBe(false);
    });
});

// ── isValidTokenName ───────────────────────────────────────────────────────

describe('isValidTokenName', () => {
    const valid = [
        ['single char', 'A'],
        ['32 chars (max)', 'A'.repeat(32)],
        ['alphanumeric with spaces', 'Nova Token 123'],
        ['hyphen allowed', 'My-Token'],
        ['digits only', '12345'],
    ] as const;

    const invalid = [
        ['empty string', ''],
        ['whitespace only', '   '],
        ['33 chars (over max)', 'A'.repeat(33)],
        ['special char @', 'Token@Name'],
        ['special char !', 'Token!'],
        ['underscore', 'Token_Name'],
        ['newline', 'Token\nName'],
    ] as const;

    it.each(valid)('accepts %s', (_label, name) => {
        expect(isValidTokenName(name)).toBe(true);
    });

    it.each(invalid)('rejects %s', (_label, name) => {
        expect(isValidTokenName(name)).toBe(false);
    });
});

// ── isValidTokenSymbol ─────────────────────────────────────────────────────

describe('isValidTokenSymbol', () => {
    const valid = [
        ['single uppercase letter', 'A'],
        ['12 chars (max)', 'A'.repeat(12)],
        ['mixed uppercase + digits', 'NOVA123'],
        ['digits only', '123'],
    ] as const;

    const invalid = [
        ['empty string', ''],
        ['13 chars (over max)', 'A'.repeat(13)],
        ['lowercase', 'nova'],
        ['mixed case', 'Nova'],
        ['special char $', 'SYM$'],
        ['space inside', 'SY M'],
        ['hyphen', 'SY-M'],
    ] as const;

    it.each(valid)('accepts %s', (_label, sym) => {
        expect(isValidTokenSymbol(sym)).toBe(true);
    });

    it.each(invalid)('rejects %s', (_label, sym) => {
        expect(isValidTokenSymbol(sym)).toBe(false);
    });
});

// ── isValidDecimals ────────────────────────────────────────────────────────

describe('isValidDecimals', () => {
    const valid = [0, 1, 7, 18] as const;
    const invalid = [-1, 19, 1.5, NaN, Infinity] as const;

    it.each(valid)('accepts %d', (d) => expect(isValidDecimals(d)).toBe(true));
    it.each(invalid)('rejects %s', (d) => expect(isValidDecimals(d)).toBe(false));
});

// ── isValidSupply ──────────────────────────────────────────────────────────

describe('isValidSupply', () => {
    const valid = [
        ['minimum supply "1"', '1'],
        ['typical supply', '1000000'],
        ['max safe integer', String(2 ** 53 - 1)],
    ] as const;

    const invalid = [
        ['zero', '0'],
        ['negative', '-1'],
        ['float string', '1.5'],
        ['empty string', ''],
        ['non-numeric', 'abc'],
        ['over max safe integer', String(BigInt(2 ** 53))],
    ] as const;

    it.each(valid)('accepts %s', (_label, s) => expect(isValidSupply(s)).toBe(true));
    it.each(invalid)('rejects %s', (_label, s) => expect(isValidSupply(s)).toBe(false));
});

// ── validateTokenParams ────────────────────────────────────────────────────

describe('validateTokenParams', () => {
    const BASE = {
        name: 'Nova Token',
        symbol: 'NOVA',
        decimals: 7,
        initialSupply: '1000000',
        adminWallet: VALID_ADDR,
    };

    it('returns valid=true with no errors for a fully valid set', () => {
        const r = validateTokenParams(BASE);
        expect(r.valid).toBe(true);
        expect(r.errors).toEqual({});
    });

    it('error messages are stable strings (not empty)', () => {
        const r = validateTokenParams({ ...BASE, name: '' });
        expect(typeof r.errors.name).toBe('string');
        expect(r.errors.name.length).toBeGreaterThan(0);
    });

    it('accumulates all errors when every field is invalid', () => {
        const r = validateTokenParams({
            name: '',
            symbol: 'lowercase',
            decimals: 25,
            initialSupply: '-10',
            adminWallet: 'bad',
        });
        expect(r.valid).toBe(false);
        expect(Object.keys(r.errors)).toEqual(
            expect.arrayContaining(['name', 'symbol', 'decimals', 'initialSupply', 'adminWallet'])
        );
    });

    it('reports only the failing field when a single field is invalid', () => {
        const r = validateTokenParams({ ...BASE, symbol: 'bad symbol' });
        expect(r.valid).toBe(false);
        expect(Object.keys(r.errors)).toEqual(['symbol']);
    });

    it('error message for invalid address is user-friendly', () => {
        const r = validateTokenParams({ ...BASE, adminWallet: 'not-an-address' });
        expect(r.errors.adminWallet).toMatch(/stellar address/i);
    });

    it('error message for invalid name is user-friendly', () => {
        const r = validateTokenParams({ ...BASE, name: '' });
        expect(r.errors.name).toMatch(/token name/i);
    });

    it('error message for invalid symbol is user-friendly', () => {
        const r = validateTokenParams({ ...BASE, symbol: '' });
        expect(r.errors.symbol).toMatch(/token symbol/i);
    });

    it('error message for invalid decimals is user-friendly', () => {
        const r = validateTokenParams({ ...BASE, decimals: 99 });
        expect(r.errors.decimals).toMatch(/decimal/i);
    });

    it('error message for invalid supply is user-friendly', () => {
        const r = validateTokenParams({ ...BASE, initialSupply: '0' });
        expect(r.errors.initialSupply).toMatch(/supply/i);
    });

    it('validation is deterministic for the same input', () => {
        const r1 = validateTokenParams(BASE);
        const r2 = validateTokenParams(BASE);
        expect(r1).toEqual(r2);
    });
});
