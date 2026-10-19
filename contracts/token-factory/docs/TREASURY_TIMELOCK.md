# Treasury Withdrawal Timelock (#2235)

Module: `treasury_timelock.rs`. Entry points: `queue_treasury_withdrawal`, `cancel_treasury_withdrawal`,
`execute_treasury_withdrawal`, `set_treasury_withdrawal_delay`, `get_treasury_withdrawal_delay`,
`get_queued_treasury_withdrawal`.

- Default delay 48h (172800s); configurable between 1h and 30d.
- A queued withdrawal is executable when `now >= queued_at + delay` (exact boundary succeeds;
  one second earlier returns `TimelockNotElapsed`=411).
- Cancel is admin-only before execution; both cancel and execute remove the entry.
- Execution re-validates the treasury policy (allowlist, daily cap) and records the withdrawal.
- Errors: 410 `TimelockedWithdrawalNotFound`, 411 `TimelockNotElapsed`, 412 `InvalidTimelockDelay`.
- Events: `tw_queue`, `tw_cancel`, `tw_exec`, `tw_delay`.
- The existing immediate `withdraw_fees` is unchanged for backward compatibility.
