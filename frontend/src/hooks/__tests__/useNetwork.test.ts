import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as leaderboardApi from '../../services/leaderboardApi';
import { useNetwork } from '../useNetwork';
import { getApiNetwork } from '../../services/apiClient';
import { transactionHistoryStorage } from '../../services/TransactionHistoryStorage';

describe('useNetwork', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('initial state', () => {
        it('defaults to testnet', () => {
            const { result } = renderHook(() => useNetwork());

            expect(result.current.network).toBe('testnet');
            expect(result.current.isTestnet).toBe(true);
            expect(result.current.isMainnet).toBe(false);
            expect(result.current.isChanging).toBe(false);
        });

        it('loads from localStorage if available', () => {
            localStorage.setItem('nova_network_preference', 'mainnet');

            const { result } = renderHook(() => useNetwork());

            expect(result.current.network).toBe('mainnet');
            expect(result.current.isMainnet).toBe(true);
        });

        it('ignores invalid localStorage value', () => {
            localStorage.setItem('nova_network_preference', 'invalid');

            const { result } = renderHook(() => useNetwork());

            expect(result.current.network).toBe('testnet');
        });
    });

    describe('setNetwork', () => {
        it('changes network to mainnet', () => {
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('mainnet');
            });

            expect(result.current.network).toBe('mainnet');
            expect(result.current.isMainnet).toBe(true);
            expect(result.current.isTestnet).toBe(false);
        });

        it('changes network to testnet', () => {
            localStorage.setItem('nova_network_preference', 'mainnet');
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('testnet');
            });

            expect(result.current.network).toBe('testnet');
            expect(result.current.isTestnet).toBe(true);
            expect(result.current.isMainnet).toBe(false);
        });

        it('sets isChanging during transition', () => {
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('mainnet');
            });

            expect(result.current.isChanging).toBe(true);

            act(() => {
                vi.advanceTimersByTime(300);
            });

            expect(result.current.isChanging).toBe(false);
        });

        it('persists to localStorage', () => {
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('mainnet');
            });

            expect(localStorage.getItem('nova_network_preference')).toBe('mainnet');
        });
    });

    describe('toggleNetwork', () => {
        it('toggles from testnet to mainnet', () => {
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.toggleNetwork();
            });

            expect(result.current.network).toBe('mainnet');
        });

        it('toggles from mainnet to testnet', () => {
            localStorage.setItem('nova_network_preference', 'mainnet');
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.toggleNetwork();
            });

            expect(result.current.network).toBe('testnet');
        });

        it('sets isChanging during toggle', () => {
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.toggleNetwork();
            });

            expect(result.current.isChanging).toBe(true);

            act(() => {
                vi.advanceTimersByTime(300);
            });

            expect(result.current.isChanging).toBe(false);
        });

        it('persists toggle to localStorage', () => {
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.toggleNetwork();
            });

            expect(localStorage.getItem('nova_network_preference')).toBe('mainnet');

            act(() => {
                result.current.toggleNetwork();
            });

            expect(localStorage.getItem('nova_network_preference')).toBe('testnet');
        });
    });

    describe('localStorage handling', () => {
        it('handles localStorage unavailable on read', () => {
            const originalGetItem = localStorage.getItem;
            localStorage.getItem = vi.fn().mockImplementation(() => {
                throw new Error('localStorage unavailable');
            });

            const { result } = renderHook(() => useNetwork());

            expect(result.current.network).toBe('testnet');

            localStorage.getItem = originalGetItem;
        });

        it('handles localStorage unavailable on write', () => {
            const originalSetItem = localStorage.setItem;
            localStorage.setItem = vi.fn().mockImplementation(() => {
                throw new Error('localStorage unavailable');
            });

            const { result } = renderHook(() => useNetwork());

            expect(() => {
                act(() => {
                    result.current.setNetwork('mainnet');
                });
            }).not.toThrow();

            expect(result.current.network).toBe('mainnet');

            localStorage.setItem = originalSetItem;
        });
    });

    describe('computed properties', () => {
        it('updates isTestnet and isMainnet correctly', () => {
            const { result } = renderHook(() => useNetwork());

            expect(result.current.isTestnet).toBe(true);
            expect(result.current.isMainnet).toBe(false);

            act(() => {
                result.current.setNetwork('mainnet');
            });

            expect(result.current.isTestnet).toBe(false);
            expect(result.current.isMainnet).toBe(true);
        });
    });

    describe('network-scoped state isolation (issue #1375)', () => {
        it('propagates the initial network to the shared apiClient', () => {
            localStorage.setItem('nova_network_preference', 'mainnet');
            renderHook(() => useNetwork());

            expect(getApiNetwork()).toBe('mainnet');
        });

        it('updates the apiClient X-Network header when the network changes', () => {
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('mainnet');
            });

            expect(getApiNetwork()).toBe('mainnet');
        });

        it('clears network-scoped caches when switching networks', () => {
            const tokenSpy = vi.spyOn(transactionHistoryStorage, 'clearAll');
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('mainnet');
            });

            expect(tokenSpy).toHaveBeenCalledTimes(1);
            tokenSpy.mockRestore();
        });

        it('clears the leaderboard cache when switching networks', () => {
            const leaderboardSpy = vi.spyOn(leaderboardApi, 'invalidateLeaderboardCache');
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('mainnet');
            });

            expect(leaderboardSpy).toHaveBeenCalledTimes(1);
            leaderboardSpy.mockRestore();
        });

        it('does not clear caches when setNetwork is called with the same network', () => {
            const tokenSpy = vi.spyOn(transactionHistoryStorage, 'clearAll');
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('testnet');
            });

            expect(tokenSpy).not.toHaveBeenCalled();
            tokenSpy.mockRestore();
        });

        it('restores the persisted network and re-applies it to apiClient after a reload', () => {
            const { result, unmount } = renderHook(() => useNetwork());

            act(() => {
                result.current.setNetwork('mainnet');
            });
            unmount();

            // Simulate a page reload by mounting a fresh hook instance
            const { result: reloaded } = renderHook(() => useNetwork());

            expect(reloaded.current.network).toBe('mainnet');
            expect(getApiNetwork()).toBe('mainnet');
        });
    });

    describe('edge cases', () => {
        it('handles rapid network changes', () => {
            const { result } = renderHook(() => useNetwork());

            act(() => {
                result.current.toggleNetwork();
                result.current.toggleNetwork();
                result.current.toggleNetwork();
            });

            expect(result.current.network).toBe('mainnet');
        });

        it('maintains state across multiple toggles', () => {
            const { result } = renderHook(() => useNetwork());

            for (let i = 0; i < 10; i++) {
                act(() => {
                    result.current.toggleNetwork();
                });
            }

            expect(result.current.network).toBe('testnet');
        });
    });
});
