# Governance: delegation expiry, proposal cancellation, vote change window

All three features live in `contracts/governance` in their own modules and are
wired into `lib.rs` with thin entry points.

## Delegation expiry (#2238) - `delegation_expiry.rs`
- `delegate_with_expiry(delegator, delegatee, expires_at)`: like `delegate`, but
  the delegation lapses at `expires_at` (ledger timestamp, must be in the future).
- Expired delegations are ignored in vote weight: `cast_vote` first unwinds any
  lapsed delegation of the voter and any lapsed delegations made to the voter.
  Anyone may also call `expire_delegation(delegator)`.
- `get_delegation_expiry(delegator)`; plain `delegate`/`undelegate` clear the expiry.
- Events: `dlg_exp` (set), `dlg_end` (expired). Storage: `ExpiryKey::{Expiry, Delegators}`.

