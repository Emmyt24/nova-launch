/// Example: Complete Governance Flow with Quorum and Approval Thresholds
///
/// This example demonstrates how to use the governance configuration
/// system in a real-world DAO voting scenario.
use soroban_sdk::{Address, Env};
use token_factory::{governance, timelock, types::Error};

/// Example 1: Initialize governance for a standard DAO
pub fn example_standard_dao_setup(env: &Env, admin: &Address) {
    // 30% quorum, 51% simple majority
    let result = governance::initialize_governance(env, Some(30), Some(51));
    assert!(result.is_ok());

    let config = governance::get_governance_config(env);
    println!(
        "DAO configured: {}% quorum, {}% approval",
        config.quorum_percent, config.approval_percent
    );
}

/// Example 2: High-security DAO for critical operations
pub fn example_high_security_dao(env: &Env, admin: &Address) {
    // 75% quorum, 90% approval for critical changes
    let result = governance::initialize_governance(env, Some(75), Some(90));
    assert!(result.is_ok());
}

/// Example 3: Check if a proposal passes
pub fn example_check_proposal(
    env: &Env,
    total_votes: u32,
    yes_votes: u32,
    total_eligible: u32,
) -> bool {
    let config = governance::get_governance_config(env);

    // Check quorum
    let quorum_met = governance::is_quorum_met(total_votes, total_eligible, config.quorum_percent);

    // Check approval
    let approval_met = governance::is_approval_met(yes_votes, total_votes, config.approval_percent);

    // Both must pass
    quorum_met && approval_met
}

/// Example 4: Complete governance flow with timelock
pub fn example_governance_with_timelock(
    env: &Env,
    admin: &Address,
    total_votes: u32,
    yes_votes: u32,
    total_eligible: u32,
    new_base_fee: i128,
) -> Result<u64, Error> {
    // Step 1: Check governance thresholds
    let config = governance::get_governance_config(env);

    let quorum_met = governance::is_quorum_met(total_votes, total_eligible, config.quorum_percent);

    let approval_met = governance::is_approval_met(yes_votes, total_votes, config.approval_percent);

    if !quorum_met {
        return Err(Error::InvalidParameters); // Quorum not met
    }

    if !approval_met {
        return Err(Error::InvalidParameters); // Approval not met
    }

    // Step 2: Schedule change with timelock
    let change_id = timelock::schedule_fee_update(env, admin, Some(new_base_fee), None)?;

    // Step 3: Return change ID for later execution
    Ok(change_id)
}

/// Example 5: Update governance config for different proposal types
pub fn example_dynamic_thresholds(env: &Env, admin: &Address, proposal_type: &str) {
    match proposal_type {
        "routine" => {
            // Low threshold for routine changes
            governance::update_governance_config(env, admin, Some(20), Some(51)).unwrap();
        }
        "important" => {
            // Medium threshold for important changes
            governance::update_governance_config(env, admin, Some(40), Some(66)).unwrap();
        }
        "critical" => {
            // High threshold for critical changes
            governance::update_governance_config(env, admin, Some(75), Some(90)).unwrap();
        }
        _ => {}
    }
}

/// Example 6: Real-world DAO voting scenario
pub fn example_dao_vote_scenario(env: &Env) {
    // DAO Setup: 1000 members, 30% quorum, 66% supermajority
    let total_eligible = 1000;
    let config = governance::get_governance_config(env);

    // Scenario A: Successful proposal
    // 350 people voted (35% participation)
    // 250 voted yes (71% approval)
    let total_votes_a = 350;
    let yes_votes_a = 250;

    assert!(governance::is_quorum_met(
        total_votes_a,
        total_eligible,
        config.quorum_percent
    ));
    assert!(governance::is_approval_met(
        yes_votes_a,
        total_votes_a,
        config.approval_percent
    ));
    println!("Proposal A: PASSED ✓");

    // Scenario B: Failed - insufficient approval
    // 350 people voted (35% participation) ✓
    // 200 voted yes (57% approval) ✗ (need 66%)
    let total_votes_b = 350;
    let yes_votes_b = 200;

    assert!(governance::is_quorum_met(
        total_votes_b,
        total_eligible,
        config.quorum_percent
    ));
    assert!(!governance::is_approval_met(
        yes_votes_b,
        total_votes_b,
        config.approval_percent
    ));
    println!("Proposal B: FAILED - insufficient approval");

    // Scenario C: Failed - insufficient quorum
    // 250 people voted (25% participation) ✗ (need 30%)
    // 200 voted yes (80% approval) ✓
    let total_votes_c = 250;
    let yes_votes_c = 200;

    assert!(!governance::is_quorum_met(
        total_votes_c,
        total_eligible,
        config.quorum_percent
    ));
    assert!(governance::is_approval_met(
        yes_votes_c,
        total_votes_c,
        config.approval_percent
    ));
    println!("Proposal C: FAILED - insufficient quorum");
}

/// Example 7: Edge case handling
pub fn example_edge_cases(env: &Env) {
    // Zero eligible voters - always fails
    assert!(!governance::is_quorum_met(10, 0, 30));

    // Zero votes cast - always fails approval
    assert!(!governance::is_approval_met(10, 0, 51));

    // 0% threshold - always passes
    assert!(governance::is_quorum_met(0, 100, 0));
    assert!(governance::is_approval_met(0, 100, 0));

    // 100% threshold - requires all
    assert!(governance::is_quorum_met(100, 100, 100));
    assert!(!governance::is_quorum_met(99, 100, 100));
}

#[cfg(test)]
mod example_tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_complete_governance_flow() {
        let env = Env::default();
        env.mock_all_auths();

        // This would work with actual contract integration
        // For now, demonstrates the API usage
        example_dao_vote_scenario(&env);
        example_edge_cases(&env);
    }
}
