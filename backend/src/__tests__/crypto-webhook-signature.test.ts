/**
 * Tests for webhook signature generation and verification
 * Issue #1971: Comprehensive webhook signature verification with replay protection
 *
 * Coverage targets:
 *  - generateWebhookSecret: generation with various lengths
 *  - generateWebhookSignature: signature generation and format
 *  - verifyWebhookSignature: verification with replay protection
 *  - verifyStoredWebhookSignature: historical signature verification
 *  - isValidUrl: URL format validation
 *  - isValidStellarAddress: Stellar address format validation
 *  - Edge cases: malformed headers, timestamp validation, tolerance windows
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateWebhookSecret,
  generateWebhookSignature,
  verifyWebhookSignature,
  verifyStoredWebhookSignature,
  isValidUrl,
  isValidStellarAddress,
} from '../utils/crypto';

describe('Webhook Signature Generation and Verification', () => {
  describe('generateWebhookSecret', () => {
    it('generates a hex string of correct length', () => {
      const secret = generateWebhookSecret(32);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(secret.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it('generates different secrets on each call', () => {
      const secret1 = generateWebhookSecret(32);
      const secret2 = generateWebhookSecret(32);
      expect(secret1).not.toBe(secret2);
    });

    it('supports custom length', () => {
      const secret16 = generateWebhookSecret(16);
      expect(secret16.length).toBe(32); // 16 bytes = 32 hex chars

      const secret64 = generateWebhookSecret(64);
      expect(secret64.length).toBe(128); // 64 bytes = 128 hex chars
    });

    it('uses default length of 32 bytes', () => {
      const secret = generateWebhookSecret();
      expect(secret.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it('generates cryptographically random values', () => {
      const secrets = Array.from({ length: 10 }, () => generateWebhookSecret(16));
      const uniqueSecrets = new Set(secrets);
      expect(uniqueSecrets.size).toBe(10); // All should be unique
    });
  });

  describe('generateWebhookSignature', () => {
    const secret = 'test-secret-key-1234567890abcdef';
    const payload = '{"event":"token.deployed","data":{"tokenId":"123"}}';

    it('generates signature with v1 format', () => {
      const signature = generateWebhookSignature(payload, secret);
      expect(signature).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
    });

    it('includes timestamp in signature', () => {
      const timestamp = 1234567890;
      const signature = generateWebhookSignature(payload, secret, timestamp);
      expect(signature).toContain(`v1.${timestamp}`);
    });

    it('uses current timestamp when not provided', () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = generateWebhookSignature(payload, secret);
      const [, sig_timestamp] = signature.split('.').slice(0, 2);
      const timestampDiff = Math.abs(parseInt(sig_timestamp) - now);
      expect(timestampDiff).toBeLessThan(2); // Within 2 seconds
    });

    it('produces different signatures for different payloads', () => {
      const sig1 = generateWebhookSignature(payload, secret, 12345);
      const sig2 = generateWebhookSignature(payload + ' ', secret, 12345);
      expect(sig1).not.toBe(sig2);
    });

    it('produces different signatures for different secrets', () => {
      const sig1 = generateWebhookSignature(payload, secret, 12345);
      const sig2 = generateWebhookSignature(payload, secret + 'different', 12345);
      expect(sig1).not.toBe(sig2);
    });

    it('produces different signatures for different timestamps', () => {
      const sig1 = generateWebhookSignature(payload, secret, 12345);
      const sig2 = generateWebhookSignature(payload, secret, 12346);
      expect(sig1).not.toBe(sig2);
    });

    it('generates deterministic signatures for same inputs', () => {
      const sig1 = generateWebhookSignature(payload, secret, 12345);
      const sig2 = generateWebhookSignature(payload, secret, 12345);
      expect(sig1).toBe(sig2);
    });
  });

  describe('verifyWebhookSignature', () => {
    const secret = 'test-secret-key-1234567890abcdef';
    const payload = '{"event":"token.deployed","data":{"tokenId":"123"}}';

    it('verifies valid webhook signature', () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = generateWebhookSignature(payload, secret, now);
      expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    });

    it('rejects invalid signature format', () => {
      expect(verifyWebhookSignature(payload, 'invalid', secret)).toBe(false);
      expect(verifyWebhookSignature(payload, 'v1.invalid', secret)).toBe(false);
      expect(verifyWebhookSignature(payload, 'v1.123', secret)).toBe(false);
    });

    it('rejects signature with wrong version', () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = generateWebhookSignature(payload, secret, now);
      const wrongVersion = signature.replace('v1.', 'v2.');
      expect(verifyWebhookSignature(payload, wrongVersion, secret)).toBe(false);
    });

    it('rejects signature with non-numeric timestamp', () => {
      expect(verifyWebhookSignature(payload, 'v1.abc.signature', secret)).toBe(false);
    });

    it('rejects signature with invalid number of parts', () => {
      expect(verifyWebhookSignature(payload, 'v1.123.sig.extra', secret)).toBe(false);
    });

    it('rejects signature with wrong payload', () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = generateWebhookSignature(payload, secret, now);
      expect(verifyWebhookSignature(payload + ' modified', signature, secret)).toBe(false);
    });

    it('rejects signature with wrong secret', () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = generateWebhookSignature(payload, secret, now);
      expect(verifyWebhookSignature(payload, signature, 'wrong-secret')).toBe(false);
    });

    it('rejects expired signature (older than tolerance window)', () => {
      const old_timestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
      const signature = generateWebhookSignature(payload, secret, old_timestamp);
      expect(verifyWebhookSignature(payload, signature, secret, 300)).toBe(false); // 5 min tolerance
    });

    it('accepts signature within tolerance window', () => {
      const recent_timestamp = Math.floor(Date.now() / 1000) - 100; // 100 seconds ago
      const signature = generateWebhookSignature(payload, secret, recent_timestamp);
      expect(verifyWebhookSignature(payload, signature, secret, 300)).toBe(true); // 5 min tolerance
    });

    it('accepts signature at tolerance boundary', () => {
      const boundary_timestamp = Math.floor(Date.now() / 1000) - 300; // Exactly 5 min ago
      const signature = generateWebhookSignature(payload, secret, boundary_timestamp);
      expect(verifyWebhookSignature(payload, signature, secret, 300)).toBe(true);
    });

    it('rejects signature just beyond tolerance', () => {
      const beyond_timestamp = Math.floor(Date.now() / 1000) - 301; // Just over 5 min ago
      const signature = generateWebhookSignature(payload, secret, beyond_timestamp);
      expect(verifyWebhookSignature(payload, signature, secret, 300)).toBe(false);
    });

    it('rejects signature with future timestamp beyond tolerance', () => {
      const future_timestamp = Math.floor(Date.now() / 1000) + 400; // 400 seconds in future
      const signature = generateWebhookSignature(payload, secret, future_timestamp);
      expect(verifyWebhookSignature(payload, signature, secret, 300)).toBe(false);
    });

    it('accepts signature with small clock skew', () => {
      const slight_future = Math.floor(Date.now() / 1000) + 50; // 50 seconds in future
      const signature = generateWebhookSignature(payload, secret, slight_future);
      expect(verifyWebhookSignature(payload, signature, secret, 300)).toBe(true);
    });

    it('uses default tolerance of 300 seconds', () => {
      const old_timestamp = Math.floor(Date.now() / 1000) - 250; // 250 seconds ago
      const signature = generateWebhookSignature(payload, secret, old_timestamp);
      expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    });

    it('handles empty header', () => {
      expect(verifyWebhookSignature(payload, '', secret)).toBe(false);
    });

    it('handles null/undefined header', () => {
      expect(verifyWebhookSignature(payload, undefined as any, secret)).toBe(false);
      expect(verifyWebhookSignature(payload, null as any, secret)).toBe(false);
    });
  });

  describe('verifyStoredWebhookSignature', () => {
    const secret = 'test-secret-key-1234567890abcdef';
    const payload = '{"event":"token.deployed","data":{"tokenId":"123"}}';

    it('verifies stored webhook signature without time check', () => {
      const old_timestamp = 1234567890; // Very old timestamp
      const signature = generateWebhookSignature(payload, secret, old_timestamp);
      expect(verifyStoredWebhookSignature(payload, signature, secret)).toBe(true);
    });

    it('rejects signature with mismatched payload', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = generateWebhookSignature(payload, secret, timestamp);
      expect(verifyStoredWebhookSignature(payload + 'modified', signature, secret)).toBe(false);
    });

    it('rejects signature with wrong secret', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = generateWebhookSignature(payload, secret, timestamp);
      expect(verifyStoredWebhookSignature(payload, signature, 'wrong-secret')).toBe(false);
    });

    it('rejects invalid format', () => {
      expect(verifyStoredWebhookSignature(payload, 'invalid', secret)).toBe(false);
      expect(verifyStoredWebhookSignature(payload, 'v1.invalid', secret)).toBe(false);
    });

    it('rejects signature with non-numeric timestamp', () => {
      expect(verifyStoredWebhookSignature(payload, 'v1.abc.sig', secret)).toBe(false);
    });

    it('handles signature with length mismatch', () => {
      expect(verifyStoredWebhookSignature(payload, 'v1.123.abcd', secret)).toBe(false);
    });

    it('differentiates between verifyWebhookSignature and verifyStoredWebhookSignature', () => {
      const old_timestamp = Math.floor(Date.now() / 1000) - 600; // 10 min ago
      const signature = generateWebhookSignature(payload, secret, old_timestamp);

      // Should reject with time check
      expect(verifyWebhookSignature(payload, signature, secret, 300)).toBe(false);

      // Should accept without time check
      expect(verifyStoredWebhookSignature(payload, signature, secret)).toBe(true);
    });
  });

  describe('URL Validation', () => {
    describe('isValidUrl', () => {
      it('validates HTTPS URLs', () => {
        expect(isValidUrl('https://example.com')).toBe(true);
        expect(isValidUrl('https://api.stellar.org/path')).toBe(true);
        expect(isValidUrl('https://example.com:8443')).toBe(true);
        expect(isValidUrl('https://example.com/path?query=value')).toBe(true);
      });

      it('validates HTTP URLs', () => {
        expect(isValidUrl('http://example.com')).toBe(true);
        expect(isValidUrl('http://localhost:3000')).toBe(true);
        expect(isValidUrl('http://127.0.0.1:8080')).toBe(true);
      });

      it('rejects invalid URLs', () => {
        expect(isValidUrl('invalid')).toBe(false);
        expect(isValidUrl('not-a-url')).toBe(false);
        expect(isValidUrl('')).toBe(false);
      });

      it('rejects unsupported protocols', () => {
        expect(isValidUrl('ftp://example.com')).toBe(false);
        expect(isValidUrl('file:///path/to/file')).toBe(false);
        expect(isValidUrl('ws://example.com')).toBe(false);
      });

      it('rejects malformed URLs', () => {
        expect(isValidUrl('http://')).toBe(false);
        expect(isValidUrl('https://')).toBe(false);
        expect(isValidUrl('ht tp://example.com')).toBe(false);
      });

      it('accepts URLs with authentication', () => {
        expect(isValidUrl('https://user:pass@example.com')).toBe(true);
      });

      it('accepts URLs with complex paths and query strings', () => {
        expect(isValidUrl('https://example.com/api/v1/resource?id=123&type=test')).toBe(true);
      });

      it('accepts URLs with fragments', () => {
        expect(isValidUrl('https://example.com/page#section')).toBe(true);
      });
    });
  });

  describe('Stellar Address Validation', () => {
    describe('isValidStellarAddress', () => {
      it('validates correct Stellar addresses', () => {
        expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(true);
        expect(isValidStellarAddress('GBNZILSTVQXHRBHQCUCZD3DSGHB7JTKZPQDJHVYYCAAJQGJRB5EVZGG')).toBe(true);
      });

      it('rejects addresses with incorrect length', () => {
        expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
        expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHFABC')).toBe(false);
      });

      it('rejects addresses not starting with G', () => {
        expect(isValidStellarAddress('BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(false);
        expect(isValidStellarAddress('0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(false);
      });

      it('rejects addresses with invalid characters', () => {
        expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF!')).toBe(false);
        expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF ')).toBe(false);
        expect(isValidStellarAddress('Gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaawhf')).toBe(false);
      });

      it('rejects lowercase addresses', () => {
        expect(isValidStellarAddress('gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaawhf')).toBe(false);
      });

      it('rejects empty string', () => {
        expect(isValidStellarAddress('')).toBe(false);
      });

      it('rejects addresses with spaces', () => {
        expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF ')).toBe(false);
        expect(isValidStellarAddress(' GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(false);
      });

      it('rejects addresses with invalid hex characters', () => {
        expect(isValidStellarAddress('GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZWHF')).toBe(false); // Z is invalid in base32
      });

      it('validates real-world examples', () => {
        // Common test addresses
        expect(isValidStellarAddress('GBPMQGHJYP3RLNVZK37XULKP3IHDQ3ZLWVQR4JQIUVABP3VKWPPJBDY')).toBe(true);
        expect(isValidStellarAddress('GBRPYHIL2CI3WHZDTOOQFC6EB4CGQWF53RZUWX4ODVLKYL5QC5IFA7J')).toBe(true);
      });
    });
  });
});
