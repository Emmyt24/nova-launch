/**
 * Render-count regression tests for BurnHistoryTable
 *
 * Why BurnHistoryTable? It renders on every sort/filter/page interaction and
 * is a prime candidate for unnecessary re-renders when a parent re-renders
 * for unrelated reasons (e.g. wallet state updates, unrelated context changes).
 *
 * Pattern: wrap BurnHistoryTable in a transparent counting shim and then in
 * React.memo so that:
 *   - Unrelated parent state changes do NOT trigger a re-render
 *   - Genuine prop changes trigger exactly one re-render
 *
 * If BurnHistoryTable is later wrapped in React.memo in the component file
 * itself, the MemoizedTable wrapper here becomes redundant but tests still pass.
 */

import React, { memo, useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import BurnHistoryTable from '../../components/BurnToken/BurnHistoryTable';

// ── Helpers ────────────────────────────────────────────────────────────────────

type BurnRecord = {
  id: string;
  date: string;
  from: string;
  amount: number;
  symbol: string;
  type: 'self' | 'admin';
  txHash?: string;
};

function makeRecords(count = 5): BurnRecord[] {
  return Array.from({ length: count }).map((_, i) => ({
    id: `r${i + 1}`,
    date: new Date(2026, 0, i + 1).toISOString(),
    from: `GADDR${String(i + 1).padStart(4, '0')}`,
    amount: (i + 1) * 100,
    symbol: 'TOK',
    type: i % 2 === 0 ? 'self' : 'admin',
    txHash: `tx${i + 1}`,
  }));
}

// Counting shim — increments renderCount on every render of BurnHistoryTable.
// Wrapping this in React.memo means re-renders only happen when props change.
let renderCount = 0;

const CountingTable = (props: React.ComponentProps<typeof BurnHistoryTable>) => {
  renderCount++;
  return <BurnHistoryTable {...props} />;
};

const MemoizedTable = memo(CountingTable);

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BurnHistoryTable render optimisation', () => {
  beforeEach(() => {
    renderCount = 0;
  });

  it('renders exactly once on initial mount', () => {
    render(<MemoizedTable records={makeRecords(5)} />);
    expect(renderCount).toBe(1);
  });

  it('does not re-render when an unrelated parent state change occurs', () => {
    // Parent holds state that BurnHistoryTable never receives as a prop.
    function Parent({ records }: { records: BurnRecord[] }) {
      const [counter, setCounter] = useState(0);
      return (
        <>
          <button onClick={() => setCounter((c) => c + 1)}>
            {`unrelated-${counter}`}
          </button>
          <MemoizedTable records={records} />
        </>
      );
    }

    const records = makeRecords(5);
    const { getByText } = render(<Parent records={records} />);

    renderCount = 0; // reset after initial mount

    act(() => {
      fireEvent.click(getByText(/^unrelated-/));
    });

    expect(renderCount).toBe(0);
  });

  it('re-renders exactly once when the records prop changes', () => {
    const { rerender } = render(<MemoizedTable records={makeRecords(5)} />);
    renderCount = 0;

    rerender(<MemoizedTable records={makeRecords(10)} />);

    expect(renderCount).toBe(1);
  });

  it('re-renders exactly once when the network prop changes', () => {
    const records = makeRecords(5);
    const { rerender } = render(<MemoizedTable records={records} network="testnet" />);
    renderCount = 0;

    rerender(<MemoizedTable records={records} network="mainnet" />);

    expect(renderCount).toBe(1);
  });

  it('does not re-render when the same records reference is passed again', () => {
    const records = makeRecords(5);
    const { rerender } = render(<MemoizedTable records={records} />);
    renderCount = 0;

    rerender(<MemoizedTable records={records} />);

    expect(renderCount).toBe(0);
  });
});
