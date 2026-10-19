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

## Proposal cancellation (#2239) - `proposal_cancellation.rs`
- `cancel_proposal(proposer, proposal_id)`: proposer only, and only while the
  proposal is `Active` with no votes cast (pending). Sets the new status
  `ProposalStatus::Cancelled`. Event: `prop_cxl`.
- Errors (`CancelError`): `ProposalNotFound=1`, `NotProposer=2`, `NotPending=3`.

## Vote change window (#2240) - `vote_change.rs`
- Disabled by default. Admin calls `set_vote_change_window(admin, Some(secs))`;
  voters may then `change_vote` until `voting_end - secs`. `None` disables it.
- The originally recorded weight is moved between `votes_for`/`votes_against`
  with checked arithmetic. Event: `vote_chg`. Storage: `VoteChangeKey::Window`.
- Errors (`VoteChangeError`): `ProposalNotFound=1`, `ProposalNotActive=2`,
  `ChangesDisabled=3`, `WindowClosed=4`, `NoExistingVote=5`, `SameVote=6`, `Overflow=7`.
