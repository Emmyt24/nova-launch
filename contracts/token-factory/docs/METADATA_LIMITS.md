# Metadata size limits (#2241)

`src/metadata_limits.rs` defines the shared constant `MAX_METADATA_URI_LEN`
(256 bytes) and `validate_metadata_uri`, enforced on every path that stores a
metadata URI: token creation (`create_token_internal`), `set_metadata`,
`set_token_metadata`, `update_metadata` and `governance_update_metadata`.

A URI longer than the limit fails with `Error::MetadataUriTooLong` (code 300),
distinct from `InvalidParameters` and `InvalidMetadataHash`. A URI of exactly
256 bytes is accepted. Boundary tests live in the module's `tests` submodule.
