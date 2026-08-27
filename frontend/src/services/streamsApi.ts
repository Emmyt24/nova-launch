/**
 * Backend HTTP wrapper for the payment-streaming/vesting feature (Issue #1765).
 *
 * Distinct from `vaultsApi.ts`, which backs the pre-existing Vaults feature —
 * see that file for the naming-history note. This talks to the new
 * `backend/src/routes/streams.ts` endpoints, which serve off-chain
 * descriptive metadata only; the on-chain stream data itself (amounts,
 * vesting schedule, claim state) comes from the contract directly via
 * `useStreamContract`.
 */

import type { PaymentStreamMetadata } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp: string;
  error?: { code: string; message: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body: ApiResponse<T> = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error?.message || `Streams API error: ${response.status}`);
  }
  return body.data;
}

export interface UpsertStreamMetadataInput {
  creator: string;
  recipient: string;
  title?: string;
  description?: string;
  tags?: string[];
}

export const streamsApi = {
  getMetadata: (streamId: string) =>
    request<PaymentStreamMetadata | null>(`/streams/${streamId}/metadata`),

  upsertMetadata: (streamId: string, input: UpsertStreamMetadataInput) =>
    request<PaymentStreamMetadata>(`/streams/${streamId}/metadata`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  getByCreator: (address: string) =>
    request<PaymentStreamMetadata[]>(`/streams/creator/${address}`),

  getByRecipient: (address: string) =>
    request<PaymentStreamMetadata[]>(`/streams/recipient/${address}`),
};
