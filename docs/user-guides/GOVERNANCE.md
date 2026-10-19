# Governance Guide

How to find proposals and understand your voting power on the Nova Launch governance page (`/governance`).

---

## Finding proposals

The proposal list has a search box and status filters above it.

- **Search** matches text in a proposal's title or description (case-insensitive). Results update shortly after you stop typing.
- **Status filters** narrow the list to one status:

  | Filter | Meaning |
  | --- | --- |
  | Active | Voting is open |
  | Passed | Voting ended and the proposal met quorum and threshold |
  | Failed | Voting ended and the proposal did not pass (stored as `REJECTED`) |
  | Queued | Passed and waiting in the timelock before it can be executed |
  | Executed / Cancelled / Expired | Final states |

- **Shareable links.** Search and status are saved in the page URL, for example:

  ```
  /governance?q=treasury&status=queued
  ```

  Bookmark or share that link to open the same filtered view. `status` accepts `active`, `passed`, `failed` (or `rejected`), `queued`, `executed`, `cancelled`, `expired`.

---

## How voting power is calculated

When your wallet is connected, the governance page shows your **voting power**. Click or hover the **?** next to it to see the breakdown:

| Line | What it is |
| --- | --- |
| **Own balance** | Governance tokens held by your address |
| **Delegated to you** | Voting power other holders have delegated to you |
| **Delegated away** | Your own balance that you have delegated to someone else |
| **Effective voting power** | Own balance + delegated to you − delegated away |

### How delegation works

- Delegating moves your **entire balance's** voting power to the delegatee. While delegated, your own balance does not count for you.
- Delegation is one level deep: power delegated to you can't be passed on again. You can only re-delegate your own balance.
- You can't delegate to yourself, and two addresses can't delegate to each other.

For the contract-level rules, see [`contracts/governance/src/delegation.rs`](../../contracts/governance/src/delegation.rs).

### Zero voting power

If the breakdown shows 0, you can't vote yet. Either acquire the governance token, or ask a holder to delegate their voting power to you.

> **Note:** The backend doesn't index delegation events yet. Until it does, the app treats your full reported voting power as your own balance and shows 0 for both delegation lines.

The link target for "Learn how voting power works" can be overridden with the `VITE_GOVERNANCE_DOCS_URL` environment variable.

---

## Gas baselines for governance operations

Governance operations (propose, vote, queue, execute, delegate) are benchmarked so that gas regressions are caught before they reach `main`.

### Where baselines live

All gas baselines are stored in a single file:

```
gas-dashboard/data/benchmarks.json
```

Each entry records the operation name and its measured gas cost. CI compares every benchmarked operation against this file.

### Running the measurement locally

From the repository root:

```bash
# Measure all governance operations and compare against the stored baselines
npm run bench:governance

# Measure and print the raw numbers without comparing
npm run bench:governance -- --no-compare
```

The script runs the benchmarks for `propose`, `vote`, `queue`, `execute`, and `delegate`, then diffs the results against `gas-dashboard/data/benchmarks.json`.

### The 10 percent threshold

CI fails when any governance operation's gas cost is **more than 10 percent above** its stored baseline. A regression under that threshold is reported as a warning but does not fail the build.

If CI fails on a gas regression:

1. Check whether the change is expected. If it is an unintended regression, fix the code rather than the baseline.
2. If the increase is intentional and approved (for example, a deliberate feature addition), refresh the baseline as described below.

### Refreshing a baseline after an approved gas change

Only update baselines for changes that have been reviewed and approved.

1. Make sure your branch contains the approved gas change.
2. Re-run the benchmarks and write the new values:

   ```bash
   npm run bench:governance -- --update
   ```

   This rewrites the affected entries in `gas-dashboard/data/benchmarks.json`.
3. Review the diff in `gas-dashboard/data/benchmarks.json`. Confirm that only the operations you intended to change have new values, and that the increases are explained in the pull request description.
4. Commit the updated baseline file together with the code change so reviewers can see both in the same pull request.
5. Note the reason for the refresh in the pull request description (for example, "adds an extra storage read to `execute`").

> **Tip:** Never update baselines just to make CI green. A baseline refresh is a deliberate decision that should be justified in review.
