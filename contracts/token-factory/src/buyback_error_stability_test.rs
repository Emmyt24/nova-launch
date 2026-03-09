#![cfg(test)]

extern crate alloc;
use alloc::vec;

use crate::types::Error;

/// Error code stability tests for buyback operations
/// 
/// These tests ensure error codes remain stable across contract versions.
/// Buyback operations reuse existing error codes for compatibility.
/// 
/// Error code mapping:
/// - Campaign not found -> TokenNotFound (4)
/// - Campaign inactive -> ContractPaused (14)
/// - Budget exhausted -> InsufficientFee (1)
/// - Slippage exceeded -> InvalidAmount (10)
/// - Invalid params -> InvalidParameters (3)

#[test]
fn test_buyback_error_codes_stable() {
    // Campaign lifecycle errors
    assert_eq!(Error::TokenNotFound as u32, 4);
    assert_eq!(Error::ContractPaused as u32, 14);
    
    // Execution errors
    assert_eq!(Error::InsufficientFee as u32, 1);
    assert_eq!(Error::InvalidAmount as u32, 10);
    
    // Validation errors
    assert_eq!(Error::InvalidParameters as u32, 3);
}

#[test]
fn test_error_code_uniqueness() {
    let codes = vec![
        Error::TokenNotFound as u32,
        Error::ContractPaused as u32,
        Error::InsufficientFee as u32,
        Error::InvalidAmount as u32,
        Error::InvalidParameters as u32,
    ];
    
    // Ensure no duplicate codes
    let mut sorted = codes.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(codes.len(), sorted.len(), "Duplicate error codes detected");
}

#[test]
fn test_buyback_error_mapping_documented() {
    // This test documents the semantic mapping of errors for buyback operations
    // These mappings must remain stable for client compatibility
    
    // Campaign not found uses TokenNotFound
    assert_eq!(Error::TokenNotFound as u32, 4);
    
    // Campaign inactive uses ContractPaused
    assert_eq!(Error::ContractPaused as u32, 14);
    
    // Budget exhausted uses InsufficientFee
    assert_eq!(Error::InsufficientFee as u32, 1);
    
    // Slippage exceeded uses InvalidAmount
    assert_eq!(Error::InvalidAmount as u32, 10);
    
    // Invalid buyback params uses InvalidParameters
    assert_eq!(Error::InvalidParameters as u32, 3);
}
