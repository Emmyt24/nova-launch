# Max supply cap at token creation (#2233)

Already implemented on main; no contract change was needed.

- Optional `max_supply: Option<i128>` is part of `TokenCreationParams` and persisted in `TokenInfo`.
- Creation: `mint::validate_max_supply_at_creation` (called from `token_creation::create_token_internal`) rejects `max_supply < initial_supply` with `Error::InvalidMaxSupply`.
- Mint paths: `mint::validate_max_supply` rejects any mint that would push total supply past the cap with `Error::MaxSupplyExceeded`.
- Boundary tests: `src/supply_cap_test.rs` (equal-to-initial, above-initial, exact-cap mint, one-over-cap mint, unlimited tokens).
