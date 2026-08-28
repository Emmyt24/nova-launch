//! Lightweight, permissioned price-feed oracle primitive.
//!
//! Admin configures a max staleness window and authorizes/deauthorizes
//! price sources. Authorized sources push prices for an `asset` address;
//! consumers read the latest price via `get_price`, which enforces the
//! staleness window and rejects non-positive values.
//!
//! Scope: this module is the oracle primitive only. Any feature that wants
//! to consume these prices (e.g. an AMM or liquidation flow) must wire that
//! consumption explicitly in its own PR.

use soroban_sdk::{Address, Env};

use crate::types::{Error, OracleConfig, PriceData};
use crate::{events, storage};

/// Configure the oracle's max staleness window (admin only).
///
/// # Errors
/// * `MissingAdmin` - Factory has not been initialized
/// * `Unauthorized` - Caller is not the factory admin
/// * `OracleInvalidConfig` - `max_age_seconds` is zero
pub fn configure_oracle(env: &Env, admin: &Address, max_age_seconds: u64) -> Result<(), Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }
    if max_age_seconds == 0 {
        return Err(Error::OracleInvalidConfig);
    }

    storage::set_oracle_config(env, &OracleConfig { max_age_seconds });
    events::emit_oracle_configured(env, admin, max_age_seconds);
    Ok(())
}

/// Authorize or deauthorize `source` as an oracle price submitter (admin only).
///
/// # Errors
/// * `MissingAdmin` - Factory has not been initialized
/// * `Unauthorized` - Caller is not the factory admin
pub fn set_oracle_authorized(
    env: &Env,
    admin: &Address,
    source: &Address,
    authorized: bool,
) -> Result<(), Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    storage::set_oracle_source_authorized(env, source, authorized);
    events::emit_oracle_source_authorized(env, admin, source, authorized);
    Ok(())
}

/// Submit a price observation for `asset` (authorized sources only).
///
/// # Errors
/// * `OracleUnauthorizedSource` - `source` has not been authorized by the admin
/// * `OracleInvalidPrice` - `price` is not strictly positive
pub fn submit_price(
    env: &Env,
    source: &Address,
    asset: &Address,
    price: i128,
    decimals: u32,
) -> Result<(), Error> {
    source.require_auth();

    if !storage::is_oracle_source_authorized(env, source) {
        return Err(Error::OracleUnauthorizedSource);
    }
    if price <= 0 {
        return Err(Error::OracleInvalidPrice);
    }

    let timestamp = env.ledger().timestamp();
    let data = PriceData {
        price,
        decimals,
        timestamp,
        source: source.clone(),
    };
    storage::set_oracle_price(env, asset, &data);
    events::emit_price_submitted(env, asset, source, price, decimals, timestamp);
    Ok(())
}

/// Read the latest price for `asset`, enforcing the configured staleness
/// window and rejecting non-positive values.
///
/// A price whose submitting source has since been deauthorized is treated
/// as unavailable immediately — it is not served just because it hasn't
/// yet aged out past `max_age_seconds`. This closes the window where a
/// source deauthorized specifically for pushing a bad price would
/// otherwise remain servable until it naturally went stale.
///
/// # Errors
/// * `OraclePriceNotFound` - No price has ever been submitted for `asset`,
///   or the price on record was submitted by a source that is no longer
///   authorized
/// * `OracleNotConfigured` - The oracle max-staleness window has not been set
/// * `OracleInvalidPrice` - The stored price is not strictly positive
/// * `OraclePriceStale` - The stored price is older than the configured max age
pub fn get_price(env: &Env, asset: &Address) -> Result<PriceData, Error> {
    let data = storage::get_oracle_price(env, asset).ok_or(Error::OraclePriceNotFound)?;
    if !storage::is_oracle_source_authorized(env, &data.source) {
        return Err(Error::OraclePriceNotFound);
    }
    if data.price <= 0 {
        return Err(Error::OracleInvalidPrice);
    }

    let config = storage::get_oracle_config(env).ok_or(Error::OracleNotConfigured)?;
    let now = env.ledger().timestamp();
    let age = now.saturating_sub(data.timestamp);
    if age > config.max_age_seconds {
        return Err(Error::OraclePriceStale);
    }

    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    const MAX_AGE: u64 = 300;

    fn setup(env: &Env, contract_id: &Address) -> Address {
        let admin = Address::generate(env);
        env.as_contract(contract_id, || {
            storage::set_admin(env, &admin);
            configure_oracle(env, &admin, MAX_AGE).unwrap();
        });
        admin
    }

    #[test]
    fn deauthorizing_source_invalidates_its_price_immediately() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = Address::generate(&env);
        let admin = setup(&env, &contract_id);
        let source = Address::generate(&env);
        let asset = Address::generate(&env);

        env.as_contract(&contract_id, || {
            set_oracle_authorized(&env, &admin, &source, true).unwrap();
            submit_price(&env, &source, &asset, 1_000, 2).unwrap();

            // Price is servable while the source remains authorized.
            assert!(get_price(&env, &asset).is_ok());

            // Deauthorize the source — its already-submitted price must be
            // rejected immediately, well within `max_age_seconds`.
            set_oracle_authorized(&env, &admin, &source, false).unwrap();

            let result = get_price(&env, &asset);
            assert_eq!(result, Err(Error::OraclePriceNotFound));
        });
    }

    #[test]
    fn reauthorizing_source_restores_its_price() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = Address::generate(&env);
        let admin = setup(&env, &contract_id);
        let source = Address::generate(&env);
        let asset = Address::generate(&env);

        env.as_contract(&contract_id, || {
            set_oracle_authorized(&env, &admin, &source, true).unwrap();
            submit_price(&env, &source, &asset, 1_000, 2).unwrap();
            set_oracle_authorized(&env, &admin, &source, false).unwrap();
            assert_eq!(get_price(&env, &asset), Err(Error::OraclePriceNotFound));

            // Re-authorizing the same source makes its previously-submitted
            // price servable again (it was never cleared from storage).
            set_oracle_authorized(&env, &admin, &source, true).unwrap();
            assert!(get_price(&env, &asset).is_ok());
        });
    }

    #[test]
    fn deauthorizing_unrelated_source_does_not_affect_other_prices() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = Address::generate(&env);
        let admin = setup(&env, &contract_id);
        let source_a = Address::generate(&env);
        let source_b = Address::generate(&env);
        let asset_a = Address::generate(&env);
        let asset_b = Address::generate(&env);

        env.as_contract(&contract_id, || {
            set_oracle_authorized(&env, &admin, &source_a, true).unwrap();
            set_oracle_authorized(&env, &admin, &source_b, true).unwrap();
            submit_price(&env, &source_a, &asset_a, 1_000, 2).unwrap();
            submit_price(&env, &source_b, &asset_b, 2_000, 2).unwrap();

            set_oracle_authorized(&env, &admin, &source_a, false).unwrap();

            assert_eq!(get_price(&env, &asset_a), Err(Error::OraclePriceNotFound));
            assert!(get_price(&env, &asset_b).is_ok());
        });
    }
}
