# Per-function pause (#2231)

Admin entrypoints `pause_function(admin, func)`, `unpause_function(admin, func)` and
view `is_function_paused(func)` (`function_pause.rs`). `func` is a Symbol:
`mint` guards `mint`; `create` guards `create_token`. The global pause keeps
precedence (`ContractPaused`); a set flag yields `Error::FunctionPaused` (510).
Events: `fn_pause` / `fn_unpaus` with the function symbol as second topic.
Flags are stored under a private `FunctionPauseKey::Paused(Symbol)` instance key.
