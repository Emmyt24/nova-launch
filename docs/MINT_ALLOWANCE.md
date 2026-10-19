# Per-Address Mint Allowance (token-factory)

The token creator can delegate limited minting to another address.

| Entry point | Auth | Notes |
|-------------|------|-------|
| `set_mint_allowance(creator, token_index, spender, amount, expires_at)` | creator | `amount > 0`, `expires_at` (ledger timestamp) in the future; replaces any existing allowance |
| `revoke_mint_allowance(creator, token_index, spender)` | creator | errors if no allowance exists |
| `get_mint_allowance(token_index, spender)` | none | remaining unexpired amount, 0 if none/expired |
| `mint_with_allowance(spender, token_index, to, amount)` | spender | consumes the allowance, then mints (max supply, pause and compliance checks still apply) |

Events: `mal_set` (topic: token_index; data: spender, amount, expires_at), `mal_rev` (data: spender).

Errors (module `mint_allowance.rs`): `600 MintAllowanceInsufficient`, `601 MintAllowanceExpired`. Other failures reuse `Unauthorized`, `InvalidAmount`, `InvalidParameters`, `TokenNotFound`, `ContractPaused`.

Storage: persistent `MintAllowanceKey::Allowance(token_index, spender) -> (remaining, expires_at)`.

Tests: `mint_allowance_test.rs`.
