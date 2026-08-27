import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { VaultDashboard } from '../../components/Vaults/VaultDashboard';
import { useWallet } from '../../hooks/useWallet';
import { vaultsApi } from '../../services/vaultsApi';
import { BrowserRouter } from 'react-router-dom';

// Mock hooks and services
vi.mock('../../hooks/useWallet');
vi.mock('../../services/vaultsApi');

const mockAddress = 'GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12';

describe('Vault Dashboard Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useWallet as any).mockReturnValue({ wallet: { address: mockAddress }, connected: true });
  });

  describe('VaultDashboard', () => {
    it('renders vaults from API', async () => {
      const mockVaults = [
        {
          id: '1',
          streamId: 201,
          creator: mockAddress,
          recipient: 'GRECIPIENT',
          amount: '50',
          status: 'CREATED',
          txHash: 'tx456',
          createdAt: new Date().toISOString(),
        }
      ];

      (vaultsApi.getByCreator as any).mockResolvedValue(mockVaults);

      render(
        <BrowserRouter>
          <VaultDashboard />
        </BrowserRouter>
      );

      await waitFor(() => {
        expect(screen.getByText('50')).toBeInTheDocument();
        expect(screen.getByText('CREATED')).toBeInTheDocument();
      });
    });
  });
});
