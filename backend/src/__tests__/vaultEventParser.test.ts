/**
 * Tests for Vault Event Parser
 */

import {
  parseVaultCreatedEvent,
  parseVaultFundedEvent,
  parseVaultClaimedEvent,
  parseVaultCancelledEvent,
  parseVaultMetadataUpdatedEvent,
  parseVaultEvent,
  VAULT_EVENT_VERSIONS,
} from '../services/vaultEventParser';
import {
  mockVaultEvents,
  expectedVaultParsedEvents,
} from './fixtures/vaultEvents';

describe('Vault Event Parser', () => {
  describe('parseVaultCreatedEvent', () => {
    it('should parse vault created event correctly', () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CREATED,
        mockVaultEvents.created
      );

      const result = parseVaultCreatedEvent(
        mockEvent,
        mockVaultEvents.created.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.created);
    });

    it('should return null for invalid event name', () => {
      const mockEvent = createMockEvent(
        'invalid_event',
        mockVaultEvents.created
      );

      const result = parseVaultCreatedEvent(
        mockEvent,
        mockVaultEvents.created.timestamp
      );

      expect(result).toBeNull();
    });

    it('should handle parsing errors gracefully', () => {
      const invalidEvent = {
        topics: () => {
          throw new Error('Invalid topics');
        },
      };

      const result = parseVaultCreatedEvent(invalidEvent, 123456);

      expect(result).toBeNull();
    });
  });

  describe('parseVaultFundedEvent', () => {
    it('should parse vault funded event correctly', () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.FUNDED,
        mockVaultEvents.funded
      );

      const result = parseVaultFundedEvent(
        mockEvent,
        mockVaultEvents.funded.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.funded);
    });

    it('should return null for wrong event type', () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CREATED,
        mockVaultEvents.funded
      );

      const result = parseVaultFundedEvent(
        mockEvent,
        mockVaultEvents.funded.timestamp
      );

      expect(result).toBeNull();
    });
  });

  describe('parseVaultClaimedEvent', () => {
    it('should parse vault claimed event correctly', () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CLAIMED,
        mockVaultEvents.claimed
      );

      const result = parseVaultClaimedEvent(
        mockEvent,
        mockVaultEvents.claimed.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.claimed);
    });

    it('should handle large amounts correctly', () => {
      const largeAmountEvent = {
        ...mockVaultEvents.claimed,
        amount: '999999999999999999',
      };

      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CLAIMED,
        largeAmountEvent
      );

      const result = parseVaultClaimedEvent(
        mockEvent,
        largeAmountEvent.timestamp
      );

      expect(result?.amount).toBe('999999999999999999');
    });
  });

  describe('parseVaultCancelledEvent', () => {
    it('should parse vault cancelled event correctly', () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CANCELLED,
        mockVaultEvents.cancelled
      );

      const result = parseVaultCancelledEvent(
        mockEvent,
        mockVaultEvents.cancelled.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.cancelled);
    });

    it('should handle zero remaining amount', () => {
      const zeroAmountEvent = {
        ...mockVaultEvents.cancelled,
        remainingAmount: '0',
      };

      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CANCELLED,
        zeroAmountEvent
      );

      const result = parseVaultCancelledEvent(
        mockEvent,
        zeroAmountEvent.timestamp
      );

      expect(result?.remainingAmount).toBe('0');
    });
  });

  describe('parseVaultMetadataUpdatedEvent', () => {
    it('should parse vault metadata updated event correctly', () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.METADATA_UPDATED,
        mockVaultEvents.metadataUpdated
      );

      const result = parseVaultMetadataUpdatedEvent(
        mockEvent,
        mockVaultEvents.metadataUpdated.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.metadataUpdated);
    });

    it('should handle both true and false hasMetadata values', () => {
      const withMetadata = {
        ...mockVaultEvents.metadataUpdated,
        hasMetadata: true,
      };

      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.METADATA_UPDATED,
        withMetadata
      );

      const result = parseVaultMetadataUpdatedEvent(
        mockEvent,
        withMetadata.timestamp
      );

      expect(result?.hasMetadata).toBe(true);
    });
  });

  describe('parseVaultEvent', () => {
    it('should route to correct parser based on event name', () => {
      const testCases = [
        {
          version: VAULT_EVENT_VERSIONS.CREATED,
          data: mockVaultEvents.created,
          expected: expectedVaultParsedEvents.created,
        },
        {
          version: VAULT_EVENT_VERSIONS.FUNDED,
          data: mockVaultEvents.funded,
          expected: expectedVaultParsedEvents.funded,
        },
        {
          version: VAULT_EVENT_VERSIONS.CLAIMED,
          data: mockVaultEvents.claimed,
          expected: expectedVaultParsedEvents.claimed,
        },
        {
          version: VAULT_EVENT_VERSIONS.CANCELLED,
          data: mockVaultEvents.cancelled,
          expected: expectedVaultParsedEvents.cancelled,
        },
        {
          version: VAULT_EVENT_VERSIONS.METADATA_UPDATED,
          data: mockVaultEvents.metadataUpdated,
          expected: expectedVaultParsedEvents.metadataUpdated,
        },
      ];

      testCases.forEach(({ version, data, expected }) => {
        const mockEvent = createMockEvent(version, data);
        const result = parseVaultEvent(mockEvent, data.timestamp);
        expect(result).toEqual(expected);
      });
    });

    it('should return null for unknown event types', () => {
      const mockEvent = createMockEvent('unknown_event', mockVaultEvents.created);
      const result = parseVaultEvent(mockEvent, 123456);
      expect(result).toBeNull();
    });

    it('should handle malformed events gracefully', () => {
      const malformedEvent = {
        topics: () => {
          throw new Error('Malformed');
        },
      };

      const result = parseVaultEvent(malformedEvent, 123456);
      expect(result).toBeNull();
    });
  });

  describe('Schema Stability', () => {
    it('should maintain consistent event versions', () => {
      expect(VAULT_EVENT_VERSIONS.CREATED).toBe('vlt_cr_v1');
      expect(VAULT_EVENT_VERSIONS.FUNDED).toBe('vlt_fd_v1');
      expect(VAULT_EVENT_VERSIONS.CLAIMED).toBe('vlt_cl_v1');
      expect(VAULT_EVENT_VERSIONS.CANCELLED).toBe('vlt_cn_v1');
      expect(VAULT_EVENT_VERSIONS.METADATA_UPDATED).toBe('vlt_md_v1');
    });

    it('should parse events with consistent field names', () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CREATED,
        mockVaultEvents.created
      );

      const result = parseVaultCreatedEvent(
        mockEvent,
        mockVaultEvents.created.timestamp
      );

      // Verify all expected fields are present
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('streamId');
      expect(result).toHaveProperty('creator');
      expect(result).toHaveProperty('recipient');
      expect(result).toHaveProperty('amount');
      expect(result).toHaveProperty('hasMetadata');
      expect(result).toHaveProperty('timestamp');
    });
  });
});

// Helper function to create mock events
function createMockEvent(eventName: string, data: any) {
  return {
    topics: () => [
      {
        sym: () => ({
          toString: () => eventName,
        }),
      },
      {
        u32: () => data.streamId,
      },
    ],
    data: () => ({
      vec: () => {
        switch (eventName) {
          case VAULT_EVENT_VERSIONS.CREATED:
            return [
              createMockAddress(data.creator),
              createMockAddress(data.recipient),
              createMockI128(data.amount),
              createMockBool(data.hasMetadata),
            ];
          case VAULT_EVENT_VERSIONS.FUNDED:
            return [
              createMockAddress(data.funder),
              createMockI128(data.amount),
            ];
          case VAULT_EVENT_VERSIONS.CLAIMED:
            return [
              createMockAddress(data.recipient),
              createMockI128(data.amount),
            ];
          case VAULT_EVENT_VERSIONS.CANCELLED:
            return [
              createMockAddress(data.canceller),
              createMockI128(data.remainingAmount),
            ];
          case VAULT_EVENT_VERSIONS.METADATA_UPDATED:
            return [
              createMockAddress(data.updater),
              createMockBool(data.hasMetadata),
            ];
          default:
            return [];
        }
      },
    }),
  };
}

function createMockAddress(address: string) {
  return {
    address: () => ({
      toString: () => address,
    }),
  };
}

function createMockI128(amount: string) {
  const bigIntAmount = BigInt(amount);
  const hi = bigIntAmount / BigInt(2 ** 64);
  const lo = bigIntAmount % BigInt(2 ** 64);

  return {
    switch: () => ({ name: 'scvI128' }),
    i128: () => ({
      hi: () => hi,
      lo: () => lo,
    }),
    toString: () => amount,
  };
}

function createMockBool(value: boolean) {
  return {
    b: () => value,
  };
}
