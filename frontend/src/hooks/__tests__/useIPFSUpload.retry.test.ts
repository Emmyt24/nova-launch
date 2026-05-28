import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useIPFSUpload } from '../useIPFSUpload';
import { IPFSService } from '../../services/IPFSService';

vi.mock('../../services/IPFSService', () => ({ IPFSService: vi.fn() }));

const MOCK_FILE = new File(['x'], 'img.png', { type: 'image/png' });
const CID = 'ipfs://QmRetrySuccess';

function makeMock(overrides: Partial<{ uploadImage: ReturnType<typeof vi.fn>; uploadMetadata: ReturnType<typeof vi.fn> }> = {}) {
    return {
        uploadImage: vi.fn().mockResolvedValue('ipfs://QmImg'),
        uploadMetadata: vi.fn().mockResolvedValue(CID),
        ...overrides,
    };
}

describe('useIPFSUpload – retry and failure surfacing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());

    it('exposes the returned CID on success', async () => {
        const mock = makeMock();
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result } = renderHook(() => useIPFSUpload());

        let cid: string | undefined;
        await act(async () => {
            const p = result.current.upload(MOCK_FILE, 'desc', 'TKN');
            vi.advanceTimersByTime(500);
            cid = await p;
        });

        expect(cid).toBe(CID);
        expect(result.current.error).toBeNull();
        expect(result.current.progress).toBe(100);
    });

    it('surfaces a clear error string when image upload fails persistently', async () => {
        const mock = makeMock({ uploadImage: vi.fn().mockRejectedValue(new Error('Pinata 503')) });
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result } = renderHook(() => useIPFSUpload());

        await act(async () => {
            await expect(result.current.upload(MOCK_FILE, 'desc', 'TKN')).rejects.toThrow('Pinata 503');
        });

        expect(result.current.error).toBe('Pinata 503');
        expect(result.current.uploading).toBe(false);
    });

    it('surfaces a clear error string when metadata upload fails persistently', async () => {
        const mock = makeMock({ uploadMetadata: vi.fn().mockRejectedValue(new Error('metadata failed')) });
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result } = renderHook(() => useIPFSUpload());

        await act(async () => {
            await expect(result.current.upload(MOCK_FILE, 'desc', 'TKN')).rejects.toThrow('metadata failed');
        });

        expect(result.current.error).toBe('metadata failed');
        expect(result.current.uploading).toBe(false);
    });

    it('surfaces a generic message for non-Error throws', async () => {
        const mock = makeMock({ uploadImage: vi.fn().mockRejectedValue('raw string error') });
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result } = renderHook(() => useIPFSUpload());

        await act(async () => {
            await expect(result.current.upload(MOCK_FILE, 'desc', 'TKN')).rejects.toBeDefined();
        });

        expect(result.current.error).toBe('IPFS upload failed');
    });

    it('translates timeout errors into a user-friendly message', async () => {
        const timeoutErr = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
        const mock = makeMock({ uploadImage: vi.fn().mockRejectedValue(timeoutErr) });
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result } = renderHook(() => useIPFSUpload());

        await act(async () => {
            await expect(result.current.upload(MOCK_FILE, 'desc', 'TKN')).rejects.toThrow();
        });

        expect(result.current.error).toMatch(/timed out/i);
    });

    it('clears error state at the start of a new upload attempt', async () => {
        const mock = makeMock({ uploadImage: vi.fn().mockRejectedValueOnce(new Error('first fail')) });
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result } = renderHook(() => useIPFSUpload());

        await act(async () => {
            await expect(result.current.upload(MOCK_FILE, 'desc', 'TKN')).rejects.toThrow();
        });
        expect(result.current.error).toBe('first fail');

        // second attempt succeeds
        mock.uploadImage.mockResolvedValue('ipfs://QmImg');
        await act(async () => {
            const p = result.current.upload(MOCK_FILE, 'desc', 'TKN');
            vi.advanceTimersByTime(500);
            await p;
        });
        expect(result.current.error).toBeNull();
    });

    it('does not update state after unmount during in-flight upload', async () => {
        const mock = makeMock({
            uploadImage: vi.fn().mockImplementation(
                () => new Promise(res => setTimeout(() => res('ipfs://QmImg'), 5000))
            ),
        });
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result, unmount } = renderHook(() => useIPFSUpload());

        act(() => { result.current.upload(MOCK_FILE, 'desc', 'TKN'); });
        expect(result.current.uploading).toBe(true);

        unmount();

        // Advancing timers after unmount must not throw
        expect(() => act(() => { vi.advanceTimersByTime(10_000); })).not.toThrow();
    });

    it('reset() clears all state back to initial values', async () => {
        const mock = makeMock({ uploadImage: vi.fn().mockRejectedValue(new Error('fail')) });
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result } = renderHook(() => useIPFSUpload());

        await act(async () => {
            await expect(result.current.upload(MOCK_FILE, 'desc', 'TKN')).rejects.toThrow();
        });

        act(() => { result.current.reset(); });

        expect(result.current.uploading).toBe(false);
        expect(result.current.progress).toBe(0);
        expect(result.current.error).toBeNull();
        expect(result.current.estimatedTimeMs).toBeUndefined();
    });

    it('sets uploading=true during upload and false after completion', async () => {
        const mock = makeMock({
            uploadImage: vi.fn().mockImplementation(
                () => new Promise(res => setTimeout(() => res('ipfs://QmImg'), 300))
            ),
        });
        (IPFSService as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mock);
        const { result } = renderHook(() => useIPFSUpload());

        act(() => { result.current.upload(MOCK_FILE, 'desc', 'TKN'); });
        expect(result.current.uploading).toBe(true);

        await act(async () => { vi.advanceTimersByTime(1000); });
        await waitFor(() => expect(result.current.uploading).toBe(false));
    });
});
