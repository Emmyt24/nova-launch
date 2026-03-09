import { useState, useCallback } from 'react';
import { StellarService } from '../services/stellar.service';

export const useStellar = () => {
  const [stellarService] = useState(() => new StellarService());

  const executeBuybackStep = useCallback(
    async (campaignId: number, executorAddress: string) => {
      return await stellarService.executeBuybackStep(campaignId, executorAddress);
    },
    [stellarService]
  );

  const getCampaign = useCallback(
    async (campaignId: number) => {
      return await stellarService.getCampaign(campaignId);
    },
    [stellarService]
  );

  return {
    executeBuybackStep,
    getCampaign,
  };
};
