import React, { useMemo, useState } from "react";
import { getTxUrl } from "../../utils/explorer";

type BurnRecord = {
  id: string;
  date: string; // ISO
  from: string;
  amount: number; // numeric amount
  symbol: string;
  type: "self" | "admin";
  txHash?: string;
};

type Props = {
  records: BurnRecord[];
  loading?: boolean;
  network?: 'testnet' | 'mainnet';
};

const PAGE_SIZE = 10;

function truncate(addr: string) {
  if (!addr) return "";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return iso;
  }
}

function formatAmount(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
}

export default function BurnHistoryTable({ records, loading, network = 'testnet' }: Props) {
  const [filter, setFilter] = useState<"all" | "self" | "admin">("all");
  const [sortKey, setSortKey] = useState<"date" | "from" | "amount">("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    return records.filter((r) => (filter === "all" ? true : r.type === filter));
  }, [records, filter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let res = 0;
      if (sortKey === "date") {
        res = new Date(a.date).getTime() - new Date(b.date).getTime();
      } else if (sortKey === "from") {
        res = a.from.localeCompare(b.from);
      } else if (sortKey === "amount") {
        res = a.amount - b.amount;
      }
      return sortDir === "asc" ? res : -res;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageItems = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(1);
  }

  function explorerLink(tx?: string) {
    if (!tx) return undefined;
    return getTxUrl(tx, network);
  }

  const styles: { [k: string]: React.CSSProperties } = {
    container: { width: "100%" },
    toolbar: { display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" },
    btn: {
      padding: "6px 10px",
      border: "1px solid #ccc",
      background: "white",
      cursor: "pointer",
      borderRadius: 4,
    },
    activeBtn: { background: "#0366d6", color: "white", borderColor: "#0366d6" },
    table: { width: "100%", borderCollapse: "collapse" } as React.CSSProperties,
    th: { textAlign: "left", padding: "8px 10px", cursor: "pointer", userSelect: "none" },
    td: { padding: "8px 10px", borderTop: "1px solid #eee" },
    badge: {
      display: "inline-block",
      padding: "4px 8px",
      borderRadius: 999,
      fontSize: 12,
    },
    pager: { display: "flex", gap: 8, alignItems: "center", marginTop: 12 },
    skeletonRow: { height: 20, background: "#eee", borderRadius: 4, marginBottom: 8 },
    mobileCard: { border: "1px solid #eee", padding: 10, borderRadius: 6, marginBottom: 10 },
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.toolbar}>
          <div style={{ width: 120, height: 28, background: "#eee", borderRadius: 6 }} />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <div style={styles.skeletonRow} />
            <div style={{ height: 10 }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <button
          aria-pressed={filter === "all"}
          onClick={() => {
            setFilter("all");
            setPage(1);
          }}
          style={{ ...styles.btn, ...(filter === "all" ? styles.activeBtn : {}) }}
        >
          All
        </button>
        <button
          aria-pressed={filter === "self"}
          onClick={() => {
            setFilter("self");
            setPage(1);
          }}
          style={{ ...styles.btn, ...(filter === "self" ? styles.activeBtn : {}) }}
        >
          Self Burns
        </button>
        <button
          aria-pressed={filter === "admin"}
          onClick={() => {
            setFilter("admin");
            setPage(1);
          }}
          style={{ ...styles.btn, ...(filter === "admin" ? styles.activeBtn : {}) }}
        >
          Admin Burns
        </button>
      </div>

      <div className="desktop-table" style={{ display: "block" }}>
        {sorted.length === 0 ? (
          <div>No burn history available</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th} onClick={() => toggleSort("date")}>
                  Date {sortKey === "date" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                </th>
                <th style={styles.th} onClick={() => toggleSort("from")}>
                  From {sortKey === "from" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                </th>
                <th style={styles.th} onClick={() => toggleSort("amount")}>
                  Amount {sortKey === "amount" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                </th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((r) => (
                <tr key={r.id}>
                  <td style={styles.td}>{formatDate(r.date)}</td>
                  <td style={styles.td} title={r.from}>
                    {truncate(r.from)}
                  </td>
                  <td style={styles.td}>
                    {formatAmount(r.amount)} {r.symbol}
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.badge,
                        background: r.type === "self" ? "#e6ffed" : "#fff4e6",
                        color: r.type === "self" ? "#046c35" : "#8a4b00",
                      }}
                    >
                      {r.type === "self" ? "Self" : "Admin"}
                    </span>
                  </td>
                  <td style={styles.td}>
                    {r.txHash ? (
                      <a href={explorerLink(r.txHash)} target="_blank" rel="noreferrer">
                        View <ExternalIcon />
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mobile-cards" style={{ display: "none" }}>
        {sorted.length === 0 ? null : (
          sorted.map((r) => (
            <div key={r.id} style={styles.mobileCard}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div style={{ fontWeight: 600 }}>{formatAmount(r.amount)} {r.symbol}</div>
                <div>
                  <span style={{ ...styles.badge, background: r.type === "self" ? "#e6ffed" : "#fff4e6" }}>
                    {r.type === "self" ? "Self" : "Admin"}
                  </span>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>{formatDate(r.date)}</div>
              <div style={{ marginTop: 6 }}>{truncate(r.from)}</div>
              <div style={{ marginTop: 8 }}>
                {r.txHash ? (
                  <a href={explorerLink(r.txHash)} target="_blank" rel="noreferrer">
                    View <ExternalIcon />
                  </a>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <div style={styles.pager}>
        <button
          style={styles.btn}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
        >
          Previous
        </button>
        <div>
          Page {page} of {totalPages}
        </div>
        <button
          style={styles.btn}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
        >
          Next
        </button>
      </div>

      <style>{`
        @media (max-width: 720px) {
          .desktop-table { display: none; }
          .mobile-cards { display: block; }
        }
      `}</style>
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "inline-block", marginLeft: 6 }}>
      <path d="M14 3h7v7" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 14L21 3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 21H3V3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
