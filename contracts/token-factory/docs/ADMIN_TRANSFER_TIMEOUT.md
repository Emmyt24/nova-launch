# Admin transfer acceptance timeout (#2230)

`propose_admin` records an expiry of `ADMIN_TRANSFER_TIMEOUT_SECS` (7 days) in
`admin_transfer_timeout.rs`. `accept_admin` fails with `Error::PendingAdminExpired`
(500) once the ledger timestamp is past the expiry. The current admin can
`cancel_admin` at any time or re-propose, which refreshes the expiry.
`pending_admin_expiry()` returns the deadline.
