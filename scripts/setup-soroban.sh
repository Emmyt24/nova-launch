#!/bin/bash

# Setup script for Soroban development environment
# Uses strict mode: abort on errors, unset variables, and failed pipes.
set -euo pipefail

echo "Setting up Soroban development environment..."

# Check if Rust is installed
if ! command -v rustc &> /dev/null; then
    echo "Rust is not installed. Installing..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
fi

# Add wasm32 target
echo "Adding wasm32-unknown-unknown target..."
rustup target add wasm32-unknown-unknown

# Check if Soroban CLI is installed
if ! command -v soroban &> /dev/null; then
    echo "Soroban CLI is not installed. Installing..."
    cargo install --locked soroban-cli
fi

# Configure Stellar testnet
echo "Configuring Stellar testnet..."
# Optional: ignore failure if the network is already configured.
soroban network add \
  --global testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" || true

# Generate identity for testing (if not exists)
if ! soroban keys show admin &> /dev/null; then
    echo "Generating admin identity..."
    soroban keys generate --global admin
fi

echo "Setup complete!"
echo "Admin address: $(soroban keys address admin)"
echo ""
echo "To fund your testnet account, visit:"
echo "https://laboratory.stellar.org/#account-creator?network=test"
