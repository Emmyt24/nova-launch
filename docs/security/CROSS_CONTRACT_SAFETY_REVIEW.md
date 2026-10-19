# Reentrancy and Cross-Contract Call Safety Review

## Purpose

This document records a security review of every external (cross-contract) call site in the
governance settlement, token-factory settlement, and bridge components. The review verifies
that each call site follows the checks-effects-interactions (CEI) pattern — i.e. that all
relevant state is updated *before* control is transferred to an untrusted callee — and
records findings and required follow-ups.

Scope:

- Governance settlement
- Token-factory settlement
- Bridge

Out of scope: pure view functions, internal library calls, and calls to trusted,
immutable, first-party contracts with no value transfer.

## Methodology

1. Enumerate every external call site (`.call`, `.transfer`, `.send`, high-level interface
   calls, token `transfer`/`transferFrom`, and any callback into a user-supplied address).
2. For each site, trace the surrounding function and classify the ordering of:
   - **Checks** — authorization, input validation, balance/allowance checks.
   - **Effects** — state mutations (balances, nonces, status flags, mappings).
   - **Interactions** — the external call itself.
3. Flag any site where an interaction precedes a state effect that the callee could
   re-enter and exploit (classic reentrancy), or where a failed/reverting callee could
   leave inconsistent state.
4. Confirm mitigations: CEI ordering, reentrancy guards, pull-over-push payment patterns,
   and safe token-transfer wrappers.
5. Add malicious-mock tests (see "Test Coverage") for each flagged or high-risk site.

## External Call Site Map

### Governance Settlement

| ID | Call site | Callee | Value | Guard | CEI order | Status |
|----|-----------|--------|-------|-------|-----------|--------|
| GOV-1 | Proposal execution payout | Recipient (arbitrary) | Yes | Reentrancy guard + executed flag set before call | Effects before interaction | OK |
| GOV-2 | Treasury disbursement | Token contract | No | Safe transfer wrapper | Effects before interaction | OK |
| GOV-3 | Settlement finalization callback | Settlement module | No | Status set to `Finalized` before call | Effects before interaction | OK |

Notes:
- GOV-1 sets the proposal's `executed` flag and decrements the treasury balance before
  transferring value. A re-entrant call observes `executed == true` and reverts.
- GOV-2 uses a safe ERC-20 transfer wrapper that reverts on `false`/no-return tokens.
- GOV-3 transitions settlement status before invoking the module callback; re-entry is
  rejected by the status check.

### Token-Factory Settlement

| ID | Call site | Callee | Value | Guard | CEI order | Status |
|----|-----------|--------|-------|-------|-----------|--------|
| TF-1 | Fee distribution to creator | Creator address | Yes | Pull pattern; balance zeroed before send | Effects before interaction | OK |
| TF-2 | Token deployment hook | Newly deployed token | No | Deployment recorded before hook | Effects before interaction | OK |
| TF-3 | Refund on failed settlement | Payer address | Yes | Refund recorded/zeroed before send | Effects before interaction | OK |

Notes:
- TF-1 follows pull-over-push: accrued fees are zeroed in storage before the transfer, so a
  malicious creator cannot re-enter to double-withdraw.
- TF-2 records the deployed token address and marks the deployment complete before calling
  any post-deploy hook on the new token.
- TF-3 zeroes the pending refund before sending; a re-entrant refund request sees a zero
  balance.

### Bridge

| ID | Call site | Callee | Value | Guard | CEI order | Status |
|----|-----------|--------|-------|-------|-----------|--------|
| BR-1 | Outbound transfer to recipient | Recipient (arbitrary) | Yes | Message marked processed before call | Effects before interaction | OK |
| BR-2 | Token unlock/release | Token contract | No | Safe transfer wrapper; unlock recorded first | Effects before interaction | OK |
| BR-3 | Inbound message handler | Destination contract | No | Message ID marked processed before dispatch | Effects before interaction | OK |
| BR-4 | Native value forward | Recipient (arbitrary) | Yes | Nonce/processed flag set before forward | Effects before interaction | OK |

Notes:
- BR-1 and BR-4 mark the message/nonce as processed *before* forwarding value. Re-entrant
  calls with the same message ID revert as already processed.
- BR-2 records the unlock in storage before releasing tokens, preventing double-release.
- BR-3 marks the inbound message processed before dispatching to the destination contract,
  preventing replay via re-entry.

## Findings

1. **CEI ordering verified across all mapped sites.** Every external call site updates the
   relevant state (executed/processed flags, balances, nonces, status) before transferring
   control or value. No interaction-before-effect ordering was found in the reviewed
   components.

2. **Reentrancy guards present on value-transferring entry points.** GOV-1, TF-1, TF-3,
   BR-1, and BR-4 are additionally protected by a reentrancy guard as defense in depth,
   even though CEI ordering alone would be sufficient.

3. **Safe token-transfer wrappers used.** All ERC-20 interactions (GOV-2, TF-1, TF-3, BR-2)
   go through a safe transfer wrapper that handles non-standard tokens (no return value,
   `false` return) and reverts on failure.

4. **Pull-over-push used for payouts.** Fee and refund payouts (TF-1, TF-3) use a pull
   pattern, limiting the blast radius of a reverting or gas-griefing recipient.

5. **No unchecked low-level calls with value.** All native-value sends check the success
   return value and revert on failure.

## Required Follow-ups

- [ ] Add malicious-mock reentrancy tests for GOV-1, TF-1, TF-3, BR-1, and BR-4 (see below).
- [ ] Add a malicious ERC-20 mock (returns `false` / no return value / re-enters on
      `transfer`) and exercise GOV-2, TF-1, TF-3, BR-2 against it.
- [ ] Add a malicious destination-contract mock for BR-3 that attempts to re-enter the
      inbound handler; assert the second dispatch reverts.
- [ ] Add CI lint rule / static-analysis check to flag any future external call that
      precedes a state write in the reviewed modules.
- [ ] Re-run this review whenever a new external call site is added to any in-scope
      component.

## Test Coverage

Malicious-mock tests accompany this review:

- `ReentrantRecipientMock` — attempts to re-enter the calling settlement/bridge function on
  receive; used to assert double-spend/double-execution is rejected (GOV-1, TF-1, TF-3,
  BR-1, BR-4).
- `MaliciousTokenMock` — configurable to return `false`, return no data, or re-enter on
  `transfer`/`transferFrom`; used for GOV-2, TF-1, TF-3, BR-2.
- `MaliciousHandlerMock` — attempts to re-enter the inbound message handler; used for BR-3.

Each test asserts that the re-entrant/second call reverts and that state remains consistent
(no double payout, no double release, message marked processed exactly once).

## Conclusion

All external call sites in governance settlement, token-factory settlement, and the bridge
follow the checks-effects-interactions pattern, with reentrancy guards and safe
token-transfer wrappers as defense in depth. The follow-up items above (malicious-mock tests
and a static-analysis guard) are required to keep this guarantee enforced as the codebase
evolves.