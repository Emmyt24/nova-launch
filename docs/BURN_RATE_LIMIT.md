# Burn Rate Limiting per Ledger Window (token-factory)

Optional per-token cap on how much holders may burn within a ledger window.

| Entry point | Auth | Notes |
|-------------|------|-------|
| `set_burn_rate_limit(admin, token_index, window_ledgers, max_burn)` | admin | `max_burn == 0` clears the limit; otherwise `window_ledgers > 0` and `max_burn > 0` |
| `get_burn_rate_limit(token_index)` | none | `Some((window_ledgers, max_burn))` or `None` |
| `get_burn_window_usage(token_index)` | none | amount burned in the current window |
| `burn(...)` | holder | rejected with `610 BurnRateLimitExceeded` when the burn would exceed the cap |

Windows are aligned: `window_id = ledger_sequence / window_ledgers`; usage resets when the window id changes. `admin_burn`, `batch_burn` and clawback are not rate limited.

Event: `brl_cfg` (topic: token_index; data: window_ledgers, max_burn) on every config change.

Errors (module `burn_rate_limit.rs`): `610 BurnRateLimitExceeded`, `611 InvalidBurnRateLimit`.

Storage: persistent `BurnRateKey::Config(token_index) -> (window_ledgers, max_burn)` and `BurnRateKey::Usage(token_index) -> (window_id, burned)`.

Tests: `burn_rate_limit_test.rs`.
