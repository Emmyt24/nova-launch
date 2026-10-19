//! Per-function pause flags (#2231).
//!
//! The admin can pause individual entrypoints (identified by their function
//! symbol, e.g. `symbol_short!("mint")`) without halting the whole contract.
//! The global pause keeps precedence: when the contract is globally paused,
//! guarded entrypoints fail with `ContractPaused` before the per-function flag
//! is consulted.
//!
//! Currently enforced on: `mint`, `create` (create_token).

use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol};

use crate::storage;
use crate::types::Error;

#[allow(non_upper_case_globals)]
impl Error {
    /// The called function has been individually paused by the admin.
    pub const FunctionPaused: Self = Self(510);
}

#[contracttype]
#[derive(Clone)]
enum FunctionPauseKey {
    Paused(Symbol),
}

/// Whether the given function's own flag is set (ignores the global pause).
pub fn is_flag_set(env: &Env, func: &Symbol) -> bool {
    env.storage()
        .instance()
        .get(&FunctionPauseKey::Paused(func.clone()))
        .unwrap_or(false)
}

/// Effective state: globally paused or individually paused.
pub fn is_function_paused(env: &Env, func: &Symbol) -> bool {
    storage::is_paused(env) || is_flag_set(env, func)
}

/// Guard for entrypoints. Global pause takes precedence over the function flag.
pub fn require_not_paused(env: &Env, func: &Symbol) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    if is_flag_set(env, func) {
        return Err(Error::FunctionPaused);
    }
    Ok(())
}

fn require_admin(env: &Env, admin: &Address) -> Result<(), Error> {
    admin.require_auth();
    let stored = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

/// Set or clear a function's pause flag (admin only) and emit an event.
pub fn set_function_paused(
    env: &Env,
    admin: &Address,
    func: Symbol,
    paused: bool,
) -> Result<(), Error> {
    require_admin(env, admin)?;
    env.storage()
        .instance()
        .set(&FunctionPauseKey::Paused(func.clone()), &paused);
    let topic: Symbol = if paused {
        symbol_short!("fn_pause")
    } else {
        symbol_short!("fn_unpaus")
    };
    env.events().publish((topic, func), admin.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{TokenFactory, TokenFactoryClient};
    use soroban_sdk::{symbol_short, testutils::Address as _, vec, Address, Env, String};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);
        client.initialize(&admin, &treasury, &70_000_000_i128, &30_000_000_i128);
        (env, contract_id, admin, creator)
    }

    fn make_token(env: &Env, id: &Address, creator: &Address) {
        let client = TokenFactoryClient::new(env, id);
        let params = crate::types::TokenCreationParams {
            name: String::from_str(env, "FnToken"),
            symbol: String::from_str(env, "FNT"),
            decimals: 7,
            initial_supply: 1_000,
            max_supply: None,
            metadata_uri: None,
        };
        client.batch_create_tokens(creator, &vec![env, params], &70_000_000_i128);
    }

    #[test]
    fn mint_flag_blocks_only_mint() {
        let (env, id, admin, creator) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        make_token(&env, &id, &creator);
        let to = Address::generate(&env);

        client.pause_function(&admin, &symbol_short!("mint"));
        assert!(client.is_function_paused(&symbol_short!("mint")));
        assert!(!client.is_function_paused(&symbol_short!("create")));
        assert!(client.try_mint(&creator, &0_u32, &to, &10_i128).is_err());

        client.unpause_function(&admin, &symbol_short!("mint"));
        assert!(client.try_mint(&creator, &0_u32, &to, &10_i128).is_ok());
    }

    #[test]
    fn create_token_flag_blocks_create_token() {
        let (env, id, admin, creator) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        let name = String::from_str(&env, "Tok");
        let sym = String::from_str(&env, "TOK");

        client.pause_function(&admin, &symbol_short!("create"));
        assert!(client
            .try_create_token(&creator, &name, &sym, &7_u32, &1_000_i128, &None, &70_000_000_i128)
            .is_err());
        assert!(client.is_function_paused(&symbol_short!("create")));
        assert!(!client.is_function_paused(&symbol_short!("mint")));
    }

    #[test]
    fn global_pause_takes_precedence_and_flag_survives_unpause() {
        let (env, id, admin, creator) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        make_token(&env, &id, &creator);
        let to = Address::generate(&env);

        client.pause_function(&admin, &symbol_short!("mint"));
        client.pause(&admin);
        assert!(client.try_mint(&creator, &0_u32, &to, &10_i128).is_err());
        client.unpause(&admin);
        // Per-function flag is independent of the global pause.
        assert!(client.try_mint(&creator, &0_u32, &to, &10_i128).is_err());
        client.unpause_function(&admin, &symbol_short!("mint"));
        assert!(client.try_mint(&creator, &0_u32, &to, &10_i128).is_ok());
    }

    #[test]
    fn only_admin_can_set_flags() {
        let (env, id, _admin, creator) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        assert!(client
            .try_pause_function(&creator, &symbol_short!("mint"))
            .is_err());
        assert!(!client.is_function_paused(&symbol_short!("mint")));
    }
}
