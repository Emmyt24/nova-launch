//! Fee tiering by token feature set (Issue #2234).
//!
//! The admin configures a surcharge per feature (identified by a `Symbol`,
//! e.g. `burn`, `mint`, `clawback`). The creation fee quote for a token is
//! `base_fee + sum(surcharge(feature))` over the requested features.
//!
//! Bounds: each surcharge must be within `0..=MAX_FEATURE_FEE`; at most
//! `MAX_FEATURES_PER_QUOTE` features are quoted at once and at most
//! `MAX_CONFIGURED_FEATURES` features can be configured.
//!
//! Event: `ftier_set` with topics `(ftier_set, feature)` and data
//! `(admin, old_fee, new_fee)`.
//!
//! New errors: `FeeTierOutOfBounds = 400`, `TooManyFeeTierFeatures = 401`.

use crate::storage;
use crate::types::Error;
use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol, Vec};

#[allow(non_upper_case_globals)]
impl Error {
    pub const FeeTierOutOfBounds: Self = Self(400);
    pub const TooManyFeeTierFeatures: Self = Self(401);
}

/// Maximum surcharge per feature (1,000 XLM in stroops).
pub const MAX_FEATURE_FEE: i128 = 1_000_0000000;
pub const MAX_FEATURES_PER_QUOTE: u32 = 16;
pub const MAX_CONFIGURED_FEATURES: u32 = 32;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum FeeTierKey {
    Fee(Symbol),
    Features,
}

/// Set the surcharge for `feature`.
pub fn set_feature_fee(
    env: &Env,
    admin: &Address,
    feature: &Symbol,
    fee: i128,
) -> Result<(), Error> {
    admin.require_auth();
    let current = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current {
        return Err(Error::Unauthorized);
    }
    if fee < 0 || fee > MAX_FEATURE_FEE {
        return Err(Error::FeeTierOutOfBounds);
    }

    let mut features: Vec<Symbol> = get_fee_tier_features(env);
    if !features.contains(feature) {
        if features.len() >= MAX_CONFIGURED_FEATURES {
            return Err(Error::TooManyFeeTierFeatures);
        }
        features.push_back(feature.clone());
        env.storage().instance().set(&FeeTierKey::Features, &features);
    }

    let old: i128 = get_feature_fee(env, feature);
    env.storage()
        .instance()
        .set(&FeeTierKey::Fee(feature.clone()), &fee);
    env.events().publish(
        (symbol_short!("ftier_set"), feature.clone()),
        (admin.clone(), old, fee),
    );
    Ok(())
}

/// Surcharge for `feature` (0 if not configured).
pub fn get_feature_fee(env: &Env, feature: &Symbol) -> i128 {
    env.storage()
        .instance()
        .get(&FeeTierKey::Fee(feature.clone()))
        .unwrap_or(0)
}

/// All features that have a configured surcharge.
pub fn get_fee_tier_features(env: &Env) -> Vec<Symbol> {
    env.storage()
        .instance()
        .get(&FeeTierKey::Features)
        .unwrap_or(Vec::new(env))
}

/// Total creation fee for a token using `features`: base fee plus surcharges.
/// Duplicate features are charged once.
pub fn quote_creation_fee(env: &Env, features: &Vec<Symbol>) -> Result<i128, Error> {
    if features.len() > MAX_FEATURES_PER_QUOTE {
        return Err(Error::TooManyFeeTierFeatures);
    }
    let mut total: i128 = storage::get_base_fee(env).unwrap_or(0);
    let mut seen: Vec<Symbol> = Vec::new(env);
    for feature in features.iter() {
        if seen.contains(&feature) {
            continue;
        }
        total = total
            .checked_add(get_feature_fee(env, &feature))
            .ok_or(Error::ArithmeticError)?;
        seen.push_back(feature);
    }
    Ok(total)
}
