/**
 * Test fixtures for vault events
 */

import { xdr } from '@stellar/stellar-sdk';

export const vaultCreatedEventFixture = {
  eventName: 'vlt_cr_v1',
  streamId: 1,
  creator: 'GABC123...',
  recipient: 'GDEF456...',
  amount: '1000000000',
  hasMetadata: true,
  timestamp: 1234567890,
};

export const vaultFundedEventFixture = {
  eventName: 'vlt_fd_v1',
  streamId: 1,
  funder: 'GABC123...',
  amount: '1000000000',
  timestamp: 1234567891,
};

export const vaultClaimedEventFixture = {
  eventName: 'vlt_cl_v1',
  streamId: 1,
  recipient: 'GDEF456...',
  amount: '500000000',
  timestamp: 1234567892,
};

export const vaultCancelledEventFixture = {
  eventName: 'vlt_cn_v1',
  streamId: 1,
  canceller: 'GABC123...',
  remainingAmount: '500000000',
  timestamp: 1234567893,
};

export const vaultMetadataUpdatedEventFixture = {
  eventName: 'vlt_md_v1',
  streamId: 1,
  updater: 'GABC123...',
  hasMetadata: false,
  timestamp: 1234567894,
};

/**
 * Mock vault event data for testing
 */
export const mockVaultEvents = {
  created: vaultCreatedEventFixture,
  funded: vaultFundedEventFixture,
  claimed: vaultClaimedEventFixture,
  cancelled: vaultCancelledEventFixture,
  metadataUpdated: vaultMetadataUpdatedEventFixture,
};

/**
 * Expected parsed results for vault events
 */
export const expectedVaultParsedEvents = {
  created: {
    version: 'vlt_cr_v1',
    streamId: 1,
    creator: 'GABC123...',
    recipient: 'GDEF456...',
    amount: '1000000000',
    hasMetadata: true,
    timestamp: 1234567890,
  },
  funded: {
    version: 'vlt_fd_v1',
    streamId: 1,
    funder: 'GABC123...',
    amount: '1000000000',
    timestamp: 1234567891,
  },
  claimed: {
    version: 'vlt_cl_v1',
    streamId: 1,
    recipient: 'GDEF456...',
    amount: '500000000',
    timestamp: 1234567892,
  },
  cancelled: {
    version: 'vlt_cn_v1',
    streamId: 1,
    canceller: 'GABC123...',
    remainingAmount: '500000000',
    timestamp: 1234567893,
  },
  metadataUpdated: {
    version: 'vlt_md_v1',
    streamId: 1,
    updater: 'GABC123...',
    hasMetadata: false,
    timestamp: 1234567894,
  },
};
