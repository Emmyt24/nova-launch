/**
 * Vault Event Parser
 * 
 * Parses versioned vault/stream events from the Stellar contract.
 * Supports schema-stable event parsing with version detection.
 */

import { xdr } from '@stellar/stellar-sdk';

// Event schema versions
export const VAULT_EVENT_VERSIONS = {
  CREATED: 'vlt_cr_v1',
  FUNDED: 'vlt_fd_v1',
  CLAIMED: 'vlt_cl_v1',
  CANCELLED: 'vlt_cn_v1',
  METADATA_UPDATED: 'vlt_md_v1',
} as const;

// Type definitions for vault events
export interface VaultCreatedEvent {
  version: string;
  streamId: number;
  creator: string;
  recipient: string;
  amount: string;
  hasMetadata: boolean;
  timestamp: number;
}

export interface VaultFundedEvent {
  version: string;
  streamId: number;
  funder: string;
  amount: string;
  timestamp: number;
}

export interface VaultClaimedEvent {
  version: string;
  streamId: number;
  recipient: string;
  amount: string;
  timestamp: number;
}

export interface VaultCancelledEvent {
  version: string;
  streamId: number;
  canceller: string;
  remainingAmount: string;
  timestamp: number;
}

export interface VaultMetadataUpdatedEvent {
  version: string;
  streamId: number;
  updater: string;
  hasMetadata: boolean;
  timestamp: number;
}

export type VaultEvent =
  | VaultCreatedEvent
  | VaultFundedEvent
  | VaultClaimedEvent
  | VaultCancelledEvent
  | VaultMetadataUpdatedEvent;

/**
 * Parse a vault created event (v1)
 */
export function parseVaultCreatedEvent(
  event: any,
  timestamp: number
): VaultCreatedEvent | null {
  try {
    const topics = event.topics();
    const data = event.data();

    // Verify event name
    const eventName = topics[0].sym().toString();
    if (eventName !== VAULT_EVENT_VERSIONS.CREATED) {
      return null;
    }

    // Extract stream ID from topics
    const streamId = topics[1].u32();

    // Parse payload
    const payload = data.vec();
    const creator = scValToAddress(payload[0]);
    const recipient = scValToAddress(payload[1]);
    const amount = scValToString(payload[2]);
    const hasMetadata = payload[3].b();

    return {
      version: VAULT_EVENT_VERSIONS.CREATED,
      streamId,
      creator,
      recipient,
      amount,
      hasMetadata,
      timestamp,
    };
  } catch (error) {
    console.error('Error parsing vault created event:', error);
    return null;
  }
}

/**
 * Parse a vault funded event (v1)
 */
export function parseVaultFundedEvent(
  event: any,
  timestamp: number
): VaultFundedEvent | null {
  try {
    const topics = event.topics();
    const data = event.data();

    const eventName = topics[0].sym().toString();
    if (eventName !== VAULT_EVENT_VERSIONS.FUNDED) {
      return null;
    }

    const streamId = topics[1].u32();
    const payload = data.vec();
    const funder = scValToAddress(payload[0]);
    const amount = scValToString(payload[1]);

    return {
      version: VAULT_EVENT_VERSIONS.FUNDED,
      streamId,
      funder,
      amount,
      timestamp,
    };
  } catch (error) {
    console.error('Error parsing vault funded event:', error);
    return null;
  }
}

/**
 * Parse a vault claimed event (v1)
 */
export function parseVaultClaimedEvent(
  event: any,
  timestamp: number
): VaultClaimedEvent | null {
  try {
    const topics = event.topics();
    const data = event.data();

    const eventName = topics[0].sym().toString();
    if (eventName !== VAULT_EVENT_VERSIONS.CLAIMED) {
      return null;
    }

    const streamId = topics[1].u32();
    const payload = data.vec();
    const recipient = scValToAddress(payload[0]);
    const amount = scValToString(payload[1]);

    return {
      version: VAULT_EVENT_VERSIONS.CLAIMED,
      streamId,
      recipient,
      amount,
      timestamp,
    };
  } catch (error) {
    console.error('Error parsing vault claimed event:', error);
    return null;
  }
}

/**
 * Parse a vault cancelled event (v1)
 */
export function parseVaultCancelledEvent(
  event: any,
  timestamp: number
): VaultCancelledEvent | null {
  try {
    const topics = event.topics();
    const data = event.data();

    const eventName = topics[0].sym().toString();
    if (eventName !== VAULT_EVENT_VERSIONS.CANCELLED) {
      return null;
    }

    const streamId = topics[1].u32();
    const payload = data.vec();
    const canceller = scValToAddress(payload[0]);
    const remainingAmount = scValToString(payload[1]);

    return {
      version: VAULT_EVENT_VERSIONS.CANCELLED,
      streamId,
      canceller,
      remainingAmount,
      timestamp,
    };
  } catch (error) {
    console.error('Error parsing vault cancelled event:', error);
    return null;
  }
}

/**
 * Parse a vault metadata updated event (v1)
 */
export function parseVaultMetadataUpdatedEvent(
  event: any,
  timestamp: number
): VaultMetadataUpdatedEvent | null {
  try {
    const topics = event.topics();
    const data = event.data();

    const eventName = topics[0].sym().toString();
    if (eventName !== VAULT_EVENT_VERSIONS.METADATA_UPDATED) {
      return null;
    }

    const streamId = topics[1].u32();
    const payload = data.vec();
    const updater = scValToAddress(payload[0]);
    const hasMetadata = payload[1].b();

    return {
      version: VAULT_EVENT_VERSIONS.METADATA_UPDATED,
      streamId,
      updater,
      hasMetadata,
      timestamp,
    };
  } catch (error) {
    console.error('Error parsing vault metadata updated event:', error);
    return null;
  }
}

/**
 * Parse any vault event based on event name
 */
export function parseVaultEvent(
  event: any,
  timestamp: number
): VaultEvent | null {
  try {
    const topics = event.topics();
    const eventName = topics[0].sym().toString();

    switch (eventName) {
      case VAULT_EVENT_VERSIONS.CREATED:
        return parseVaultCreatedEvent(event, timestamp);
      case VAULT_EVENT_VERSIONS.FUNDED:
        return parseVaultFundedEvent(event, timestamp);
      case VAULT_EVENT_VERSIONS.CLAIMED:
        return parseVaultClaimedEvent(event, timestamp);
      case VAULT_EVENT_VERSIONS.CANCELLED:
        return parseVaultCancelledEvent(event, timestamp);
      case VAULT_EVENT_VERSIONS.METADATA_UPDATED:
        return parseVaultMetadataUpdatedEvent(event, timestamp);
      default:
        return null;
    }
  } catch (error) {
    console.error('Error parsing vault event:', error);
    return null;
  }
}

// Helper functions for ScVal conversion
function scValToAddress(scVal: any): string {
  try {
    const address = scVal.address();
    return address.toString();
  } catch (error) {
    throw new Error(`Failed to convert ScVal to address: ${error}`);
  }
}

function scValToString(scVal: any): string {
  try {
    // Handle i128 amounts
    if (scVal.switch().name === 'scvI128') {
      const i128 = scVal.i128();
      const hi = i128.hi().toString();
      const lo = i128.lo().toString();
      // Combine hi and lo parts
      return (BigInt(hi) * BigInt(2 ** 64) + BigInt(lo)).toString();
    }
    return scVal.toString();
  } catch (error) {
    throw new Error(`Failed to convert ScVal to string: ${error}`);
  }
}
