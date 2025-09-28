#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, symbol_short};
use soroban_sdk::token::TokenClient;

#[contracttype]
#[derive(Clone)]
pub struct Pool {
    pub id: u32,
    pub creator: Address,
    pub token: Address,
    pub supplier: Address,
    pub goal: i128,
    pub raised: i128,
    pub deadline: u64,
    pub finalized: bool,
}

#[contracttype]
pub enum DataKey {
    NextPoolId,
    Pools(u32),
    Contributions(u32, Address),
}

#[contract]
pub struct CollectivePurchase;

#[contractimpl]
impl CollectivePurchase {
    /// Inicializa el contrato
    pub fn initialize(env: Env) {
        if env.storage().instance().has(&DataKey::NextPoolId) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&DataKey::NextPoolId, &1u32);
    }

    /// Crea un nuevo pool de compra colectiva
    pub fn create_pool(
        env: Env,
        creator: Address,
        token: Address,
        supplier: Address,
        goal: i128,
        deadline: u64,
    ) -> u32 {
        creator.require_auth();
        assert!(goal > 0, "Goal must be positive");
        let now = env.ledger().timestamp();
        assert!(deadline > now, "Deadline must be in the future");

        let next_id = env.storage().instance().get(&DataKey::NextPoolId).unwrap_or(1u32);
        let pool = Pool {
            id: next_id,
            creator: creator.clone(),
            token,
            supplier,
            goal,
            raised: 0,
            deadline,
            finalized: false,
        };

        env.storage().instance().set(&DataKey::Pools(next_id), &pool);
        env.storage().instance().set(&DataKey::NextPoolId, &(next_id + 1));

        // Evento PoolCreated (PC)
        env.events().publish((symbol_short!("PC"), next_id), pool);

        next_id
    }

    /// Contribuye a un pool (usuario debe haber aprobado el contrato previamente)
    pub fn contribute(env: Env, pool_id: u32, user: Address, amount: i128) {
        user.require_auth();
        let now = env.ledger().timestamp();
        let mut pool: Pool = env.storage().instance().get(&DataKey::Pools(pool_id)).expect("Pool not found");
        assert!(!pool.finalized, "Pool is already finalized");
        assert!(now <= pool.deadline, "Deadline has passed");
        assert!(amount > 0, "Amount must be positive");

        // Transfer from user to contract (requiere approve previo del user al contrato)
        let token_client = TokenClient::new(&env, &pool.token);
        token_client.transfer_from(&env.current_contract_address(), &user, &env.current_contract_address(), &amount);

        // Actualizar estado
        pool.raised += amount;
        let key = DataKey::Contributions(pool_id, user.clone());
        let mut contrib = env.storage().instance().get(&key).unwrap_or(0i128);
        contrib += amount;
        env.storage().instance().set(&key, &contrib);
        env.storage().instance().set(&DataKey::Pools(pool_id), &pool);

        // Evento Contributed (CTR)
        env.events().publish((symbol_short!("CTR"), pool_id, user), amount);
    }

    /// Finaliza el pool si se alcanzó la meta (solo creator)
    pub fn finalize(env: Env, pool_id: u32, creator: Address) {
        creator.require_auth();
        let mut pool: Pool = env.storage().instance().get(&DataKey::Pools(pool_id)).expect("Pool not found");
        assert!(creator == pool.creator, "Only creator can finalize");
        assert!(!pool.finalized, "Pool is already finalized");
        let now = env.ledger().timestamp();
        assert!(now <= pool.deadline, "Deadline has passed");
        assert!(pool.raised >= pool.goal, "Goal not reached");

        // Transferir raised al supplier
        let token_client = TokenClient::new(&env, &pool.token);
        token_client.transfer(&env.current_contract_address(), &pool.supplier, &pool.raised);

        pool.finalized = true;
        env.storage().instance().set(&DataKey::Pools(pool_id), &pool);

        // Evento Finalized (FN)
        env.events().publish((symbol_short!("FN"), pool_id), pool.raised);
    }

    /// Reembolsa al usuario si el pool falló (solo post-deadline)
    pub fn refund(env: Env, pool_id: u32, user: Address) {
        user.require_auth();
        let now = env.ledger().timestamp();
        let pool: Pool = env.storage().instance().get(&DataKey::Pools(pool_id)).expect("Pool not found");
        assert!(!pool.finalized, "Pool is finalized");
        assert!(now > pool.deadline, "Deadline not passed");
        assert!(pool.raised < pool.goal, "Goal was reached");

        let key = DataKey::Contributions(pool_id, user.clone());
        let amount = env.storage().instance().get(&key).unwrap_or(0i128);
        assert!(amount > 0, "No contribution found");

        // Transferir de vuelta al user
        let token_client = TokenClient::new(&env, &pool.token);
        token_client.transfer(&env.current_contract_address(), &user, &amount);

        // Limpiar contribución
        env.storage().instance().remove(&key);

        // Evento Refunded (RF)
        env.events().publish((symbol_short!("RF"), pool_id, user), amount);
    }

    /// Obtiene el estado de un pool
    pub fn get_pool(env: Env, pool_id: u32) -> Pool {
        env.storage().instance().get(&DataKey::Pools(pool_id)).expect("Pool not found")
    }
}
