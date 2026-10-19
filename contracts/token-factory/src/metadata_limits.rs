//! Shared metadata size limits and validation (#2241).
//!
//! The same limit is enforced on every path that stores a metadata URI:
//! token creation, `set_metadata`, `set_token_metadata`, `update_metadata`
//! and `governance_update_metadata`.

use soroban_sdk::String;

use crate::types::Error;

/// Maximum metadata URI length in bytes (comfortably fits `ipfs://<cid>` / https URLs).
pub const MAX_METADATA_URI_LEN: u32 = 256;

impl Error {
    /// Metadata URI exceeds [`MAX_METADATA_URI_LEN`] bytes.
    pub const MetadataUriTooLong: Self = Self(300);
}

/// Reject a metadata URI longer than [`MAX_METADATA_URI_LEN`].
pub fn validate_metadata_uri(uri: &String) -> Result<(), Error> {
    if uri.len() > MAX_METADATA_URI_LEN {
        return Err(Error::MetadataUriTooLong);
    }
    Ok(())
}

/// Validate an optional metadata URI (creation path).
pub fn validate_optional_metadata_uri(uri: &Option<String>) -> Result<(), Error> {
    match uri {
        Some(u) => validate_metadata_uri(u),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    fn uri_of_len(env: &Env, n: u32) -> String {
        String::from_str(env, &"a".repeat(n as usize))
    }

    #[test]
    fn accepts_up_to_limit() {
        let env = Env::default();
        assert_eq!(validate_metadata_uri(&uri_of_len(&env, 0)), Ok(()));
        assert_eq!(validate_metadata_uri(&uri_of_len(&env, 1)), Ok(()));
        assert_eq!(
            validate_metadata_uri(&uri_of_len(&env, MAX_METADATA_URI_LEN - 1)),
            Ok(())
        );
        assert_eq!(
            validate_metadata_uri(&uri_of_len(&env, MAX_METADATA_URI_LEN)),
            Ok(())
        );
    }

    #[test]
    fn rejects_above_limit_with_distinct_error() {
        let env = Env::default();
        let r = validate_metadata_uri(&uri_of_len(&env, MAX_METADATA_URI_LEN + 1));
        assert_eq!(r, Err(Error::MetadataUriTooLong));
        assert_ne!(Error::MetadataUriTooLong, Error::InvalidParameters);
        assert_ne!(Error::MetadataUriTooLong, Error::InvalidMetadataHash);
        assert_eq!(Error::MetadataUriTooLong.0, 300);
    }

    #[test]
    fn optional_validation_covers_none_and_some() {
        let env = Env::default();
        assert_eq!(validate_optional_metadata_uri(&None), Ok(()));
        assert_eq!(
            validate_optional_metadata_uri(&Some(uri_of_len(&env, MAX_METADATA_URI_LEN))),
            Ok(())
        );
        assert_eq!(
            validate_optional_metadata_uri(&Some(uri_of_len(&env, MAX_METADATA_URI_LEN + 1))),
            Err(Error::MetadataUriTooLong)
        );
    }
}
