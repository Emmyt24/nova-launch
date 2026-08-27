import {
    StellarWalletsKit,
    Networks,
    type ISupportedWallet,
} from '@creit.tech/stellar-wallets-kit';
import { FreighterModule, FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { LobstrModule, LOBSTR_ID } from '@creit.tech/stellar-wallets-kit/modules/lobstr';
import { AlbedoModule, ALBEDO_ID } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { xBullModule, XBULL_ID } from '@creit.tech/stellar-wallets-kit/modules/xbull';
import type { WalletType } from '../types';

export { FREIGHTER_ID, LOBSTR_ID, ALBEDO_ID, XBULL_ID };

export const WALLET_TYPE_MAP: Record<string, WalletType> = {
    [FREIGHTER_ID]: 'freighter',
    [LOBSTR_ID]: 'lobstr',
    [ALBEDO_ID]: 'albedo',
    [XBULL_ID]: 'xbull',
};

export const WALLET_ID_MAP: Record<WalletType, string> = {
    freighter: FREIGHTER_ID,
    lobstr: LOBSTR_ID,
    albedo: ALBEDO_ID,
    xbull: XBULL_ID,
};

let initialized = false;

export function initWalletKit(network: 'testnet' | 'mainnet'): void {
    if (initialized) return;
    initialized = true;

    StellarWalletsKit.init({
        network: network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
        selectedWalletId: FREIGHTER_ID,
        modules: [
            new FreighterModule(),
            new LobstrModule(),
            new AlbedoModule(),
            new xBullModule(),
        ],
    });
}

export function setKitNetwork(network: 'testnet' | 'mainnet'): void {
    StellarWalletsKit.setNetwork(
        network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
    );
}

export async function getSupportedWallets(): Promise<ISupportedWallet[]> {
    return StellarWalletsKit.refreshSupportedWallets();
}

export { StellarWalletsKit };
