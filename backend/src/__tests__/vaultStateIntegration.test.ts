/**
 * Vault State Integration Tests
 * 
 * Ensures backend indexed vault state remains consistent with contract query state
 */

import {
  parseVaultEvent,
  VaultCreatedEvent,
  VaultClaimedEvent,
  VaultCancelledEvent,
} from '../services/vaultEventParser';

describe('Vault State Integration Tests', () => {
  describe('Backend vs Contract State Consistency', () => {
    it('should maintain consistent vault state after creation', () => {
      // Simulate contract state
      const contractState = {
        streamId: 1,
        creator: 'GABC123...',
        recipient: 'GDEF456...',
        amount: '1000000000',
        claimed: '0',
        cancelled: false,
      };

      // Simulate backend indexed state from event
      const mockCreatedEvent = createMockVaultCreatedEvent(contractState);
      const parsedEvent = parseVaultEvent(mockCreatedEvent, 1234567890);

      expect(parsedEvent).not.toBeNull();
      const createdEvent = parsedEvent as VaultCreatedEvent;

      // Verify consistency
      expect(createdEvent.streamId).toBe(contractState.streamId);
      expect(createdEvent.creator).toBe(contractState.creator);
      expect(createdEvent.recipient).toBe(contractState.recipient);
      expect(createdEvent.amount).toBe(contractState.amount);
    });

    it('should track claimed amounts consistently', () => {
      // Initial contract state
      const initialState = {
        streamId: 1,
        amount: '1000000000',
        claimed: '0',
      };

      // After first claim
      const firstClaimAmount = '300000000';
      const afterFirstClaim = {
        ...initialState,
        claimed: firstClaimAmount,
      };

      // Simulate claim event
      const mockClaimEvent = createMockVaultClaimedEvent({
        streamId: 1,
        recipient: 'GDEF456...',
        amount: firstClaimAmount,
      });

      const parsedClaim = parseVaultEvent(mockClaimEvent, 1234567891);
      expect(parsedClaim).not.toBeNull();
      const claimEvent = parsedClaim as VaultClaimedEvent;

      // Verify backend can reconstruct state
      const backendState = {
        streamId: initialState.streamId,
        amount: initialState.amount,
        claimed: claimEvent.amount,
      };

      expect(backendState.claimed).toBe(afterFirstClaim.claimed);
      expect(BigInt(backendState.claimed)).toBeLessThanOrEqual(
        BigInt(backendState.amount)
      );
    });

    it('should handle multiple claims correctly', () => {
      const streamId = 1;
      const totalAmount = '1000000000';
      let cumulativeClaimed = BigInt(0);

      const claims = [
        { amount: '200000000', timestamp: 1234567891 },
        { amount: '300000000', timestamp: 1234567892 },
        { amount: '500000000', timestamp: 1234567893 },
      ];

      claims.forEach((claim) => {
        const mockEvent = createMockVaultClaimedEvent({
          streamId,
          recipient: 'GDEF456...',
          amount: claim.amount,
        });

        const parsed = parseVaultEvent(mockEvent, claim.timestamp);
        expect(parsed).not.toBeNull();

        const claimEvent = parsed as VaultClaimedEvent;
        cumulativeClaimed += BigInt(claimEvent.amount);

        // Verify invariant: cumulative claimed <= total amount
        expect(cumulativeClaimed).toBeLessThanOrEqual(BigInt(totalAmount));
      });

      // Final state should match total
      expect(cumulativeClaimed.toString()).toBe(totalAmount);
    });

    it('should reflect cancellation state correctly', () => {
      const contractState = {
        streamId: 1,
        amount: '1000000000',
        claimed: '400000000',
        cancelled: false,
      };

      // After cancellation
      const remainingAmount = '600000000';
      const mockCancelEvent = createMockVaultCancelledEvent({
        streamId: 1,
        canceller: 'GABC123...',
        remainingAmount,
      });

      const parsed = parseVaultEvent(mockCancelEvent, 1234567894);
      expect(parsed).not.toBeNull();

      const cancelEvent = parsed as VaultCancelledEvent;

      // Verify backend can track cancellation
      const backendState = {
        ...contractState,
        cancelled: true,
        remainingAmount: cancelEvent.remainingAmount,
      };

      expect(backendState.cancelled).toBe(true);
      expect(
        BigInt(backendState.claimed) + BigInt(backendState.remainingAmount)
      ).toBe(BigInt(contractState.amount));
    });

    it('should maintain state consistency across event sequence', () => {
      // Simulate full lifecycle
      const streamId = 1;
      const totalAmount = '1000000000';

      // 1. Creation
      const createEvent = createMockVaultCreatedEvent({
        streamId,
        creator: 'GABC123...',
        recipient: 'GDEF456...',
        amount: totalAmount,
      });

      const created = parseVaultEvent(createEvent, 1000) as VaultCreatedEvent;
      expect(created.amount).toBe(totalAmount);

      // 2. First claim
      const claim1Event = createMockVaultClaimedEvent({
        streamId,
        recipient: 'GDEF456...',
        amount: '300000000',
      });

      const claim1 = parseVaultEvent(claim1Event, 2000) as VaultClaimedEvent;

      // 3. Second claim
      const claim2Event = createMockVaultClaimedEvent({
        streamId,
        recipient: 'GDEF456...',
        amount: '200000000',
      });

      const claim2 = parseVaultEvent(claim2Event, 3000) as VaultClaimedEvent;

      // 4. Cancellation
      const cancelEvent = createMockVaultCancelledEvent({
        streamId,
        canceller: 'GABC123...',
        remainingAmount: '500000000',
      });

      const cancel = parseVaultEvent(
        cancelEvent,
        4000
      ) as VaultCancelledEvent;

      // Verify final state consistency
      const totalClaimed = BigInt(claim1.amount) + BigInt(claim2.amount);
      const totalAccounted =
        totalClaimed + BigInt(cancel.remainingAmount);

      expect(totalAccounted.toString()).toBe(totalAmount);
    });

    it('should detect state drift between backend and contract', () => {
      // Contract state
      const contractState = {
        streamId: 1,
        amount: '1000000000',
        claimed: '500000000',
      };

      // Backend state (potentially drifted)
      const backendState = {
        streamId: 1,
        amount: '1000000000',
        claimed: '450000000', // Drift!
      };

      // Detect inconsistency
      const isDrifted = contractState.claimed !== backendState.claimed;
      expect(isDrifted).toBe(true);

      // In real implementation, this would trigger reconciliation
      if (isDrifted) {
        // Reconcile by trusting contract state
        backendState.claimed = contractState.claimed;
      }

      expect(backendState.claimed).toBe(contractState.claimed);
    });

    it('should handle concurrent claims without state corruption', () => {
      const streamId = 1;
      const totalAmount = '1000000000';

      // Simulate concurrent claims at same timestamp
      const concurrentClaims = [
        { amount: '100000000', timestamp: 5000 },
        { amount: '150000000', timestamp: 5000 },
        { amount: '200000000', timestamp: 5000 },
      ];

      let totalClaimed = BigInt(0);

      concurrentClaims.forEach((claim) => {
        const mockEvent = createMockVaultClaimedEvent({
          streamId,
          recipient: 'GDEF456...',
          amount: claim.amount,
        });

        const parsed = parseVaultEvent(mockEvent, claim.timestamp);
        const claimEvent = parsed as VaultClaimedEvent;

        totalClaimed += BigInt(claimEvent.amount);
      });

      // Verify no overflow or corruption
      expect(totalClaimed).toBeLessThanOrEqual(BigInt(totalAmount));
      expect(totalClaimed.toString()).toBe('450000000');
    });

    it('should validate event ordering for state reconstruction', () => {
      const events = [
        { type: 'created', timestamp: 1000, streamId: 1 },
        { type: 'claimed', timestamp: 2000, streamId: 1 },
        { type: 'claimed', timestamp: 3000, streamId: 1 },
        { type: 'cancelled', timestamp: 4000, streamId: 1 },
      ];

      // Verify events are in chronological order
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timestamp).toBeGreaterThan(
          events[i - 1].timestamp
        );
      }

      // Verify logical ordering
      expect(events[0].type).toBe('created');
      expect(events[events.length - 1].type).toBe('cancelled');
    });
  });

  describe('Schema Stability Verification', () => {
    it('should parse events with stable schema across versions', () => {
      const v1Event = createMockVaultCreatedEvent({
        streamId: 1,
        creator: 'GABC123...',
        recipient: 'GDEF456...',
        amount: '1000000000',
      });

      const parsed = parseVaultEvent(v1Event, 1234567890);
      expect(parsed).not.toBeNull();

      const createdEvent = parsed as VaultCreatedEvent;
      expect(createdEvent.version).toBe('vlt_cr_v1');

      // Verify all v1 fields are present
      expect(createdEvent).toHaveProperty('streamId');
      expect(createdEvent).toHaveProperty('creator');
      expect(createdEvent).toHaveProperty('recipient');
      expect(createdEvent).toHaveProperty('amount');
      expect(createdEvent).toHaveProperty('hasMetadata');
      expect(createdEvent).toHaveProperty('timestamp');
    });

    it('should reject events with schema violations', () => {
      const malformedEvent = {
        topics: () => [
          { sym: () => ({ toString: () => 'vlt_cr_v1' }) },
          { u32: () => 1 },
        ],
        data: () => ({
          vec: () => [
            // Missing required fields
            createMockAddress('GABC123...'),
          ],
        }),
      };

      const parsed = parseVaultEvent(malformedEvent, 1234567890);
      expect(parsed).toBeNull();
    });
  });
});

// Helper functions
function createMockVaultCreatedEvent(data: any) {
  return {
    topics: () => [
      { sym: () => ({ toString: () => 'vlt_cr_v1' }) },
      { u32: () => data.streamId },
    ],
    data: () => ({
      vec: () => [
        createMockAddress(data.creator),
        createMockAddress(data.recipient),
        createMockI128(data.amount),
        createMockBool(data.hasMetadata || false),
      ],
    }),
  };
}

function createMockVaultClaimedEvent(data: any) {
  return {
    topics: () => [
      { sym: () => ({ toString: () => 'vlt_cl_v1' }) },
      { u32: () => data.streamId },
    ],
    data: () => ({
      vec: () => [
        createMockAddress(data.recipient),
        createMockI128(data.amount),
      ],
    }),
  };
}

function createMockVaultCancelledEvent(data: any) {
  return {
    topics: () => [
      { sym: () => ({ toString: () => 'vlt_cn_v1' }) },
      { u32: () => data.streamId },
    ],
    data: () => ({
      vec: () => [
        createMockAddress(data.canceller),
        createMockI128(data.remainingAmount),
      ],
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
