# Stellar Token Deployer (Nova Launch)

<div align="center">

![CI](https://github.com/Emmyt24/Nova-launch/workflows/CI/badge.svg)
![Security](https://github.com/Emmyt24/Nova-launch/workflows/Security%20Scan/badge.svg)
![Coverage](https://codecov.io/gh/Emmyt24/Nova-launch/branch/main/graph/badge.svg)

![Stellar](https://img.shields.io/badge/Stellar-Soroban-7D00FF?style=for-the-badge&logo=stellar)
![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript)
![Rust](https://img.shields.io/badge/Rust-2021-000000?style=for-the-badge&logo=rust)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)
![Coverage](https://img.shields.io/badge/Coverage->80%25-brightgreen?style=for-the-badge)

**A user-friendly dApp for quick token deployment on Stellar, targeting creators in Nigeria and emerging markets.**

[Features](#-features) • [Quick Start](#-quick-start) • [User Guides](docs/user-guides/README.md) • [Documentation](#-documentation) • [Contributing](#-contributing) • [Roadmap](#-roadmap)

</div>

---

## Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Development](#development)
- [Project Structure](#-project-structure)
- [Smart Contracts](#-smart-contracts)
- [Frontend Application](#-frontend-application)
- [Testing](#-testing)
- [CI/CD](#-cicd)
- [Deployment](#-deployment)
- [Configuration](#-configuration)
- [API Reference](#-api-reference)
- [Contributing](#-contributing)
- [Roadmap](#-roadmap)
- [FAQ](#-faq)
- [License](#-license)
- [Support](#-support)

---

## Overview

**Stellar Token Deployer** (Nova Launch) is a decentralized application that enables creators, entrepreneurs, and businesses in emerging markets to deploy custom tokens on the Stellar blockchain without writing a single line of code.

### Why Nova Launch?

- **🎯 No Coding Required**: Simple form-based interface for token deployment
- **💰 Low Fees**: Leverage Stellar's ultra-low transaction costs (~0.00001 XLM)
- **⚡ Fast**: Deploy tokens in seconds, not hours
- **🌍 Emerging Markets Focus**: Optimized for users in Nigeria and other developing regions
- **🔒 Secure**: Non-custodial, wallet-based authentication
- **📱 Mobile-First**: Responsive design for all devices
- **📲 PWA Support**: Install as an app on any device with offline capabilities

### Core Value Proposition

Pay minimal XLM fees to deploy and mint tokens directly to your wallet. Optional metadata (images, descriptions) can be added via IPFS for a small additional fee. All fees funnel to the platform treasury, creating a sustainable business model aligned with Stellar's cheap transaction model.

---

## ✨ Features

### Current Features (MVP)

#### 🏭 Token Factory Smart Contract

- ✅ Deploy custom tokens with configurable parameters
- ✅ Set token name, symbol, decimals, and initial supply
- ✅ Automatic minting to creator's wallet
- ✅ Admin-controlled post-deployment minting
- ✅ Fee collection to platform treasury
- ✅ Token registry for tracking deployments

#### 🎨 Frontend Application

- ✅ Wallet connection via Freighter
- ✅ Network switching (Testnet/Mainnet)
- ✅ Multi-step token deployment form
- ✅ Real-time input validation
- ✅ Fee calculation and breakdown
- ✅ Transaction history tracking
- ✅ Responsive, mobile-first design
- ✅ Accessibility compliant (WCAG 2.1)
- ✅ PWA support with offline mode
- ✅ Installable on mobile and desktop

#### 🖼️ Metadata Support

- ✅ Optional IPFS metadata upload
- ✅ Token images and descriptions
- ✅ On-chain metadata URI storage
- ✅ Image validation and preview

#### 🧪 Testing & Quality

- ✅ Comprehensive unit tests
- ✅ Property-based testing
- ✅ 27+ passing tests
- ✅ >80% code coverage
- ✅ TypeScript strict mode

### Coming Soon

- 🔄 Batch token deployment
- 📊 Token analytics dashboard
- 🔐 Pro tier (clawback, multi-sig)
- 🌐 Multi-wallet support
- 📱 Mobile app (iOS/Android)
- 🎨 Token templates
- 🔍 Token discovery marketplace

---

## 🏗️ Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React/TS)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Token Deploy │  │   Wallet     │  │  Transaction │     │
│  │     Form     │  │  Connection  │  │   History    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Integration Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Stellar SDK  │  │   Freighter  │  │     IPFS     │     │
│  │              │  │    Wallet    │  │   (Pinata)   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  Stellar Network (Soroban)                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │          Token Factory Contract (Rust)               │   │
│  │  - create_token()                                    │   │
│  │  - mint_tokens()                                     │   │
│  │  - set_metadata()                                    │   │
│  │  - collect_fees()                                    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **User Input**: User fills deployment form with token parameters
2. **Validation**: Frontend validates all inputs client-side
3. **Metadata Upload** (optional): Images uploaded to IPFS via Pinata
4. **Transaction Building**: Stellar SDK builds contract invocation
5. **Wallet Signing**: User signs transaction via Freighter
6. **Submission**: Transaction submitted to Stellar network
7. **Confirmation**: Monitor transaction status and confirmation
8. **Result**: Display token address and transaction details
9. **History**: Store deployment info in local storage

---

## 🛠️ Tech Stack

### Smart Contracts

| Technology            | Version | Purpose                          |
| --------------------- | ------- | -------------------------------- |
| **Rust**              | 2021    | Smart contract language          |
| **Soroban SDK**       | 21.0.0  | Stellar smart contract framework |
| **soroban-token-sdk** | Latest  | Token standard implementation    |
| **proptest**          | 1.4     | Property-based testing           |

### Frontend

| Technology       | Version    | Purpose                |
| ---------------- | ---------- | ---------------------- |
| **React**        | 19.2.0     | UI framework           |
| **TypeScript**   | 5.9.3      | Type safety            |
| **Vite**         | 8.0.0-beta | Build tool             |
| **Tailwind CSS** | 4.1.18     | Styling                |
| **Vitest**       | 4.0.18     | Testing framework      |
| **fast-check**   | 4.5.3      | Property-based testing |

### Integration

| Service         | Purpose                |
| --------------- | ---------------------- |
| **Stellar SDK** | Blockchain interaction |
| **Freighter**   | Wallet connection      |
| **Pinata**      | IPFS metadata storage  |
| **Horizon API** | Transaction monitoring |

---

## 🚀 Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** 18+ ([Download](https://nodejs.org/))
- **npm** or **yarn**
- **Rust** 1.70+ ([Install](https://rustup.rs/))
- **Soroban CLI** ([Install Guide](https://soroban.stellar.org/docs/getting-started/setup))
- **Freighter Wallet** ([Chrome Extension](https://www.freighter.app/))

### Installation

1. **Clone the repository**

```bash
git clone https://github.com/Emmyt24/Nova-launch.git
cd Nova-launch
```

2. **Install frontend dependencies**

```bash
cd frontend
npm install
```

3. **Install Rust dependencies**

```bash
cd ../contracts/token-factory
cargo build
```

4. **Set up Soroban environment**

```bash
# Run the setup script
chmod +x ../../scripts/setup-soroban.sh
../../scripts/setup-soroban.sh
```

This script will:

- Install Rust and wasm32 target
- Install Soroban CLI
- Configure Stellar testnet
- Generate admin identity
- Provide funding instructions

### Docker (Local Development)

The fastest way to run the full stack locally is with Docker Compose.

**Prerequisites:** Docker 24+ and Docker Compose v2.

```bash
# 1. Copy and configure environment variables
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET and ADMIN_JWT_SECRET

# 2. Start all services (postgres, redis, backend, frontend)
docker compose up --build

# 3. Open the app
#    Frontend → http://localhost:5173
#    Backend  → http://localhost:3001
```

To stop and remove containers:

```bash
docker compose down
# Add -v to also remove the postgres volume (wipes database)
docker compose down -v
```

**Services started by Docker Compose:**

| Service  | Port | Description                       |
| -------- | ---- | --------------------------------- |
| postgres | 5432 | PostgreSQL 16 database            |
| redis    | 6379 | Redis 7 (rate limiter)            |
| backend  | 3001 | Express/Next.js API               |
| frontend | 5173 | React/Vite app (served via nginx) |

> **Note:** `VITE_*` variables are baked into the frontend at build time. If you change them in `.env`, rebuild with `docker compose up --build frontend`.

---

### Development

#### Frontend Development

```bash
cd frontend

# Start development server
npm run dev

# Run tests
npm test

# Run tests with UI
npm run test:ui

# Build for production
npm run build

# Preview production build
npm run preview
```

The frontend will be available at `http://localhost:5173`

#### Smart Contract Development

```bash
cd contracts/token-factory

# Build contract
cargo build --target wasm32-unknown-unknown --release

# Run tests
cargo test

# Optimize WASM (requires soroban-cli)
soroban contract optimize \
  --wasm target/wasm32-unknown-unknown/release/token_factory.wasm
```

#### Event Schemas & Compatibility

Event schemas are maintained under `event-schemas/` and compiled to TypeScript types via codegen. Please review the [Event Schema Compatibility Policy](event-schemas/COMPATIBILITY.md) before making schema changes.

#### Deploy Contract to Testnet

```bash
# Quick deployment (recommended)
./scripts/deploy-testnet.sh

# This script will:
# - Verify admin identity
# - Create treasury identity if needed
# - Deploy the contract
# - Initialize with proper configuration
# - Save deployment info to deployment-testnet.json
# - Run basic smoke tests

# Verify deployment
./scripts/verify-deployment.sh

# Update frontend environment
./scripts/update-frontend-env.sh
```

For detailed deployment instructions, see [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md).

For the end-to-end production deployment and post-deploy verification runbook, see [docs/PRODUCTION_INTEGRATION_RUNBOOK.md](docs/PRODUCTION_INTEGRATION_RUNBOOK.md).

---

## 📁 Project Structure

```
nova-launch/
├── contracts/                    # Smart contracts
│   ├── token-factory/           # Token factory contract
│   │   ├── src/
│   │   │   ├── lib.rs          # Main contract logic
│   │   │   ├── types.rs        # Data structures
│   │   │   ├── storage.rs      # Storage management
│   │   │   └── test.rs         # Contract tests
│   │   └── Cargo.toml
│   └── Cargo.toml               # Workspace config
│
├── frontend/                     # React frontend
│   ├── src/
│   │   ├── components/          # React components
│   │   │   ├── Layout/         # Layout components
│   │   │   ├── UI/             # Reusable UI components
│   │   │   ├── TokenDeployForm/
│   │   │   ├── WalletConnect/
│   │   │   └── TransactionHistory/
│   │   ├── services/            # API services
│   │   │   ├── stellar.ts      # Stellar SDK integration
│   │   │   ├── wallet.ts       # Wallet service
│   │   │   └── ipfs.ts         # IPFS service
│   │   ├── hooks/               # Custom React hooks
│   │   ├── types/               # TypeScript types
│   │   ├── utils/               # Utility functions
│   │   ├── config/              # Configuration
│   │   ├── test/                # Test utilities
│   │   ├── App.tsx              # Main app component
│   │   └── main.tsx             # Entry point
│   ├── public/                  # Static assets
│   ├── package.json
│   └── vite.config.ts
│
├── scripts/                      # Utility scripts
│   └── setup-soroban.sh         # Soroban setup script
│
├── .kiro/                        # Kiro specs (excluded from git)
│   └── specs/
│       └── stellar-token-deployer/
│           ├── requirements.md
│           ├── design.md
│           └── tasks.md
│
├── .gitignore
└── README.md
```

---

## 📜 Smart Contracts

### Token Factory Contract

The Token Factory is the core smart contract that handles token deployment and management.

#### Contract Functions

##### `initialize`

Initialize the factory with admin, treasury, and fee structure.

```rust
pub fn initialize(
    env: Env,
    admin: Address,
    treasury: Address,
    base_fee: i128,
    metadata_fee: i128,
) -> Result<(), Error>
```

##### `create_token`

Deploy a new token with specified parameters.

```rust
pub fn create_token(
    env: Env,
    creator: Address,
    name: String,
    symbol: String,
    decimals: u32,
    initial_supply: i128,
    fee_payment: i128,
) -> Address
```

##### `set_metadata`

Add metadata URI to an existing token.

```rust
pub fn set_metadata(
    env: Env,
    token_address: Address,
    admin: Address,
    metadata_uri: String,
    fee_payment: i128,
) -> Result<(), Error>
```

##### `update_metadata`

Update the metadata URI for a token with full version tracking. Each call increments the on-chain version counter and records a permanent history entry.

```rust
pub fn update_metadata(
    env: Env,
    admin: Address,
    token_index: u32,
    new_metadata_uri: String,
) -> Result<u32, Error>
```

**Parameters:**

- `admin`: Token creator address (must authorize)
- `token_index`: Index of the token to update
- `new_metadata_uri`: New IPFS URI (e.g., `"ipfs://QmNewHash..."`)

**Returns:** The new version number (starts at 2 after the first update).

**Errors:**

- `MetadataNotSet` (54) — metadata was never set; call `set_token_metadata` first
- `Unauthorized` — caller is not the token creator
- `TokenNotFound` — token index does not exist
- `ContractPaused` — contract is paused

**Events:** Emits `meta_upd` with token address, admin, new URI, and version.

##### `get_metadata_history`

Retrieve a historical metadata record for a specific version.

```rust
pub fn get_metadata_history(
    env: Env,
    token_index: u32,
    version: u32,
) -> Option<MetadataRecord>
```

**Returns:** `Some(MetadataRecord)` if the version exists, `None` otherwise.

`MetadataRecord` fields:

- `uri: String` — the metadata URI at that version
- `updated_at: u64` — ledger timestamp of the update
- `updated_by: Address` — address that performed the update

##### `mint_tokens`

Mint additional tokens (admin only).

```rust
pub fn mint_tokens(
    env: Env,
    token_address: Address,
    admin: Address,
    to: Address,
    amount: i128,
    fee_payment: i128,
) -> Result<(), Error>
```

##### `burn`

Allows token holders to burn their own tokens, permanently removing them from circulation.

```rust
pub fn burn(
    env: Env,
    token_address: Address,
    from: Address,
    amount: i128,
) -> Result<(), Error>
```

**Parameters:**

- `token_address`: Address of the token contract
- `from`: Address of the token holder burning tokens
- `amount`: Amount of tokens to burn (in smallest unit)

**Example:**

```rust
// Burn 1000 tokens (with 7 decimals)
factory.burn(
    &token_address,
    &user_address,
    &1000_0000000
);
```

##### `admin_burn`

Allows token admin to burn tokens from any address (clawback).

```rust
pub fn admin_burn(
    env: Env,
    token_address: Address,
    admin: Address,
    from: Address,
    amount: i128,
) -> Result<(), Error>
```

**Security Note:** Only the token creator can perform admin burns.

##### `burn_batch`

Burn tokens from multiple addresses in a single transaction.

```rust
pub fn burn_batch(
    env: Env,
    token_address: Address,
    burns: Vec<(Address, i128)>,
) -> Result<(), Error>
```

**Gas Optimization:** More efficient than multiple individual burns.

##### `update_fees`

Update fee structure (admin only).

```rust
pub fn update_fees(
    env: Env,
    admin: Address,
    base_fee: Option<i128>,
    metadata_fee: Option<i128>,
) -> Result<(), Error>
```

##### `get_state`

Get current factory state.

```rust
pub fn get_state(env: Env) -> FactoryState
```

##### `get_base_fee`

Get the current base fee for token deployment.

```rust
pub fn get_base_fee(env: Env) -> i128
```

Returns the base fee amount in stroops that must be paid for any token deployment, regardless of metadata inclusion.

##### `get_metadata_fee`

Get the current metadata fee for token deployment.

```rust
pub fn get_metadata_fee(env: Env) -> i128
```

Returns the additional fee amount in stroops that must be paid when deploying a token with metadata (IPFS URI).

##### `get_token_info`

Get information about a deployed token.

```rust
pub fn get_token_info(
    env: Env,
    index: u32
) -> Result<TokenInfo, Error>
```

#### Multi-Signature Admin Operations

Critical admin operations can be gated behind a configurable multi-sig approval system. A minimum number of authorized signers must approve a proposal before it executes.

##### `configure_multisig`

Set up the multi-sig system with a list of signers and an approval threshold (admin only).

```rust
pub fn configure_multisig(
    env: Env,
    admin: Address,
    signers: Vec<Address>,
    threshold: u32,
) -> Result<(), Error>
```

##### `propose_multisig_action`

Any authorized signer can create a proposal for an admin action.

```rust
pub fn propose_multisig_action(
    env: Env,
    proposer: Address,
    action: MultiSigAction,  // TransferAdmin | UpdateFees | PauseContract | UnpauseContract
    payload: Bytes,
) -> Result<u64, Error>  // returns proposal ID
```

**Payload encoding:**

| Action           | Payload                                                    |
| ---------------- | ---------------------------------------------------------- |
| `TransferAdmin`  | 32 bytes – new admin contract-id hash                      |
| `UpdateFees`     | 32 bytes – base_fee (i128 LE, 16 B) \|\| metadata_fee (i128 LE, 16 B) |
| `PauseContract`  | 0 bytes (empty)                                            |
| `UnpauseContract`| 0 bytes (empty)                                            |

##### `approve_multisig_proposal`

Approve a pending proposal. Automatically executes when the threshold is reached.

```rust
pub fn approve_multisig_proposal(
    env: Env,
    approver: Address,
    proposal_id: u64,
) -> Result<(), Error>
```

##### `execute_multisig_proposal`

Explicitly execute a proposal that has already reached the approval threshold.

```rust
pub fn execute_multisig_proposal(
    env: Env,
    executor: Address,
    proposal_id: u64,
) -> Result<(), Error>
```

##### `cancel_multisig_proposal`

Cancel a pending proposal (admin or original proposer only).

```rust
pub fn cancel_multisig_proposal(
    env: Env,
    canceller: Address,
    proposal_id: u64,
) -> Result<(), Error>
```

##### `get_multisig_config`

Returns the current multi-sig configuration, or `None` if not yet configured.

```rust
pub fn get_multisig_config(env: Env) -> Option<MultiSigConfig>
```

##### `get_multisig_proposal`

Returns a proposal by ID, or `None` if it does not exist.

```rust
pub fn get_multisig_proposal(env: Env, proposal_id: u64) -> Option<MultiSigProposal>
```

#### Error Codes

| Code | Error                      | Description                                                  |
| ---- | -------------------------- | ------------------------------------------------------------ |
| 1    | `InsufficientFee`          | Fee payment is below minimum                                 |
| 2    | `Unauthorized`             | Caller not authorized for action                             |
| 3    | `InvalidParameters`        | Invalid token parameters                                     |
| 4    | `TokenNotFound`            | Token not found in registry                                  |
| 5    | `MetadataAlreadySet`       | Metadata already set for token                               |
| 6    | `AlreadyInitialized`       | Factory already initialized                                  |
| 7    | `BurnAmountExceedsBalance` | Burn amount exceeds token balance                            |
| 8    | `BurnNotEnabled`           | Burn functionality not enabled                               |
| 9    | `InvalidBurnAmount`        | Burn amount is zero or negative                              |
| 54   | `MetadataNotSet`           | Metadata has never been set; call `set_token_metadata` first |

##### Multi-Sig Error Codes

| Code | Error                        | Description                                          |
| ---- | ---------------------------- | ---------------------------------------------------- |
| 72   | `MultiSigNotConfigured`      | Multi-sig has not been configured yet                |
| 73   | `MultiSigProposalNotFound`   | No proposal with the given ID                        |
| 74   | `MultiSigAlreadyApproved`    | Signer already approved this proposal                |
| 75   | `MultiSigProposalExecuted`   | Proposal has already been executed                   |
| 76   | `MultiSigProposalCancelled`  | Proposal has been cancelled                          |
| 77   | `MultiSigThresholdNotMet`    | Not enough approvals to execute                      |
| 78   | `NotASigner`                 | Caller is not in the authorized signer list          |
| 79   | `InvalidThreshold`           | Threshold is 0 or exceeds the number of signers      |

##### Vault Error Codes

These codes are reserved for vault lifecycle failures and are guaranteed to remain stable for downstream clients.

| Code | Error                 | Description                                   |
| ---- | --------------------- | --------------------------------------------- |
| 60   | `VaultNotFound`       | Referenced vault does not exist               |
| 61   | `VaultLocked`         | Unlock time or milestone has not been met     |
| 62   | `VaultAlreadyClaimed` | Vault funds have already been claimed         |
| 63   | `VaultCancelled`      | Vault was cancelled and is immutable          |
| 64   | `InvalidVaultConfig`  | Vault parameters failed validation            |
| 65   | `NothingToClaim`      | No claimable balance remains (vaults/streams) |

#### Events

##### `TokenBurned`

Emitted when tokens are burned.

**Data:**

- `token_address`: Address
- `from`: Address
- `amount`: i128
- `burned_by`: Address
- `timestamp`: u64
- `is_admin_burn`: bool

---

## 💻 Frontend Application

### Components

#### UI Components

Located in `frontend/src/components/UI/`:

- **Button**: Configurable button with variants and loading states
- **Input**: Form input with validation and error display
- **Card**: Content card with optional title
- **Spinner**: Loading spinner with size variants
- **Tooltip**: Contextual help tooltips
- **Modal**: Accessible modal dialogs
- **Toast**: Notification system
- **Skeleton**: Loading placeholders
- **ErrorBoundary**: Error handling wrapper

#### Layout Components

- **Header**: Application header with branding
- **Container**: Responsive content container

### Services

#### StellarService

Handles all Stellar network interactions.

```typescript
class StellarService {
  constructor(network: "testnet" | "mainnet");

  async deployToken(params: TokenDeployParams): Promise<DeploymentResult>;
  async mintTokens(
    tokenAddress: string,
    recipient: string,
    amount: string,
  ): Promise<string>;
  async getTokenInfo(tokenAddress: string): Promise<TokenInfo>;
  async getTransaction(hash: string): Promise<TransactionDetails>;
}
```

#### WalletService

Manages Freighter wallet connection.

```typescript
class WalletService {
  async connect(): Promise<string>;
  disconnect(): void;
  async signTransaction(xdr: string): Promise<string>;
  async getBalance(address: string): Promise<string>;
  isInstalled(): boolean;
}
```

#### IPFSService

Handles metadata upload to IPFS.

```typescript
class IPFSService {
  async uploadMetadata(
    image: File,
    description: string,
    tokenName: string,
  ): Promise<string>;
  async getMetadata(uri: string): Promise<TokenMetadata>;
}
```

### Hooks

#### useWallet

Manages wallet connection state.

```typescript
const {
  wallet, // WalletState
  connect, // () => Promise<void>
  disconnect, // () => void
  isConnecting, // boolean
  error, // string | null
} = useWallet();
```

#### useTokenDeploy

Manages token deployment process.

```typescript
const {
  deploy, // (params: TokenDeployParams) => Promise<DeploymentResult>
  isDeploying, // boolean
  status, // DeploymentStatus
  error, // AppError | null
} = useTokenDeploy();
```

#### useToast

Manages toast notifications.

```typescript
const {
  toasts, // ToastState[]
  success, // (message: string) => void
  error, // (message: string) => void
  info, // (message: string) => void
  warning, // (message: string) => void
} = useToast();
```

### Utilities

#### Validation

```typescript
// Validate Stellar address
isValidStellarAddress(address: string): boolean

// Validate token parameters
validateTokenParams(params): { valid: boolean; errors: Record<string, string> }

// Validate image file
isValidImageFile(file: File): { valid: boolean; error?: string }
```

#### Formatting

```typescript
// Format XLM amounts
formatXLM(amount: string | number): string

// Truncate addresses
truncateAddress(address: string, startChars?: number, endChars?: number): string

// Convert stroops to XLM
stroopsToXLM(stroops: number | string): number

// Convert XLM to stroops
xlmToStroops(xlm: number | string): number
```

---

## 🧪 Testing

### Quick Start

Use the unified test runner for all test categories:

```bash
# Fast mode (2-5 min) - Local development
./scripts/run-tests.sh -m fast

# Full mode (10-15 min) - PR validation
./scripts/run-tests.sh -m full

# Nightly mode (30-60 min) - Comprehensive
./scripts/run-tests.sh -m nightly
```

See [Test Runner Documentation](docs/TEST_RUNNER.md) for detailed usage.

### Running Tests Manually

```bash
# Frontend tests
cd frontend
npm test                 # Run all tests
npm run test:ui         # Run with UI
npm run test:coverage   # Generate coverage report

# Contract tests
cd contracts/token-factory
cargo test              # Run all tests
cargo test -- --nocapture  # Run with output
```

### Test Categories

#### Unit Tests

Tests individual functions and modules in isolation.

```bash
cargo test --lib --tests
```

#### Integration Tests

Tests interactions between components.

```bash
cargo test --test '*'
```

#### Property-Based Tests

Randomized testing for governance invariants:

- Monotonic vote totals
- Single-vote-per-address
- Execution preconditions
- Terminal state permanence
- Vote distribution consistency

```bash
cargo test --lib --profile ci
```

#### Benchmarks

Performance testing (nightly mode only).

```bash
cargo bench --no-run
```

#### Frontend Performance Monitoring

The frontend performance pipeline records bundle and Lighthouse metrics locally and can optionally publish sanitized custom events to New Relic.

```bash
cd frontend
npm run monitor
```

To enable the New Relic export path, set `NEW_RELIC_ACCOUNT_ID` and `NEW_RELIC_INSERT_KEY` before running the command. Optional overrides include `NEW_RELIC_INSIGHTS_URL`, `NEW_RELIC_APP_NAME`, and `NEW_RELIC_SOURCE`.

### Test Modes

| Mode        | Duration  | Tests               | Use Case              |
| ----------- | --------- | ------------------- | --------------------- |
| **Fast**    | 2-5 min   | Unit + Integration  | Local dev, pre-commit |
| **Full**    | 10-15 min | + Property tests    | PR validation, CI     |
| **Nightly** | 30-60 min | + Benchmarks + WASM | Release validation    |

### CI Integration

Tests run automatically on:

- **Push**: Fast mode
- **Pull Request**: Full mode
- **Schedule**: Nightly mode (2 AM UTC)

### Test Coverage

Current coverage: **>80%**

```bash
# Generate coverage report
cd frontend
npm run test:coverage

# View report
open coverage/index.html
```

---

## 🔄 CI/CD

### Continuous Integration

The project uses GitHub Actions for automated testing and validation. All checks must pass before code can be merged.

#### CI Pipeline

- **Rust Contract Tests**: Formatting, linting, tests, and WASM build
- **Frontend Tests**: Linting, tests, and production build
- **Security Audit**: Dependency vulnerability scanning
- **Spec Validation**: Ensures all spec files are complete

#### Running Checks Locally

Before pushing code, run the local CI validation:

```bash
./scripts/ci-check.sh
```

This runs all CI checks locally to catch issues early.

#### Setting Up Git Hooks

Enable pre-commit hooks to catch issues before committing:

```bash
git config core.hooksPath .githooks
```

The hook checks Rust formatting, frontend/backend lint, type-checking, Prettier formatting, secret detection, and conventional commit message format — scoped to staged files only for speed.

For more details, see [CI/CD Guide](CI_CD_GUIDE.md).

---

## 🚢 Deployment

### Smart Contract Deployment

#### Testnet

```bash
cd contracts/token-factory

# Build optimized WASM
cargo build --target wasm32-unknown-unknown --release
soroban contract optimize --wasm target/wasm32-unknown-unknown/release/token_factory.wasm

# Deploy
CONTRACT_ID=$(soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/token_factory.wasm \
  --network testnet \
  --source admin)

echo "Contract deployed: $CONTRACT_ID"

# Initialize
soroban contract invoke \
  --id $CONTRACT_ID \
  --network testnet \
  --source admin \
  -- initialize \
  --admin $(soroban keys address admin) \
  --treasury $(soroban keys address treasury) \
  --base_fee 70000000 \
  --metadata_fee 30000000
```

#### Mainnet

```bash
# Same as testnet but use --network mainnet
# Ensure you have funded mainnet accounts
```

### Frontend Deployment

#### Vercel (Recommended)

```bash
cd frontend

# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Production deployment
vercel --prod
```

#### Netlify

```bash
cd frontend

# Build
npm run build

# Deploy dist/ folder to Netlify
```

#### Environment Variables

Create `.env` file in `frontend/`:

```env
VITE_FACTORY_CONTRACT_ID=<your_contract_id>
VITE_NETWORK=testnet
VITE_IPFS_API_KEY=<your_pinata_api_key>
VITE_IPFS_API_SECRET=<your_pinata_api_secret>
```

---

## ⚙️ Configuration

### Stellar Network Configuration

Edit `frontend/src/config/stellar.ts`:

```typescript
export const STELLAR_CONFIG = {
  network: import.meta.env.VITE_NETWORK || "testnet",
  factoryContractId: import.meta.env.VITE_FACTORY_CONTRACT_ID || "",

  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  },

  mainnet: {
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    horizonUrl: "https://horizon.stellar.org",
    sorobanRpcUrl: "https://soroban-mainnet.stellar.org",
  },
};
```

### IPFS Configuration

Edit `frontend/src/config/ipfs.ts`:

```typescript
export const IPFS_CONFIG = {
  apiKey: import.meta.env.VITE_IPFS_API_KEY || "",
  apiSecret: import.meta.env.VITE_IPFS_API_SECRET || "",
  pinataApiUrl: "https://api.pinata.cloud",
  pinataGateway: "https://gateway.pinata.cloud/ipfs",
};
```

### Fee Structure

Default fees (in stroops, 1 XLM = 10,000,000 stroops):

| Tier     | Features         | Fee (XLM) | Fee (stroops) |
| -------- | ---------------- | --------- | ------------- |
| Basic    | Token deployment | 7         | 70,000,000    |
| Metadata | + IPFS metadata  | +3        | +30,000,000   |
| Total    | With metadata    | 10        | 100,000,000   |

Fees can be updated by factory admin using `update_fees` function.

---

## 📚 API Reference

### REST API (Coming Soon)

Currently, all interactions are direct with the blockchain via Stellar SDK.

### GraphQL API (Planned)

Future versions will include a GraphQL API for:

- Token discovery
- Analytics
- User profiles
- Transaction history

---

## 🤝 Contributing

We welcome contributions from the community! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

### How to Contribute

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes**
4. **Write/update tests**
5. **Ensure tests pass**: `npm test`
6. **Commit your changes**: `git commit -m 'feat: add amazing feature'`
7. **Push to branch**: `git push origin feature/amazing-feature`
8. **Open a Pull Request**

### Development Guidelines

- Follow existing code style
- Write TypeScript with strict mode
- Add JSDoc comments for public APIs
- Include unit tests for new features
- Update documentation as needed
- Maintain >80% code coverage

### Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: bug fix
docs: documentation changes
style: code style changes
refactor: code refactoring
test: test changes
chore: build/tooling changes
```

### Issue Labels

- `good first issue` - Great for newcomers
- `enhancement` - New feature
- `bug` - Something isn't working
- `documentation` - Documentation improvements
- `help wanted` - Extra attention needed

---

## 🗺️ Roadmap

### Phase 1: MVP (Current) ✅

- [x] Token Factory smart contract
- [x] Basic frontend UI
- [x] Wallet connection
- [x] Token deployment
- [x] Metadata upload
- [x] Transaction history
- [x] Testing infrastructure

### Phase 2: Enhanced Features (Q2 2026)

- [ ] Wallet integration (Freighter, Albedo, xBull)
- [ ] Stellar SDK integration
- [ ] IPFS integration
- [ ] Multi-step deployment form
- [ ] Real-time fee calculation
- [ ] Transaction monitoring
- [ ] Mobile optimization

### Phase 3: Advanced Features (Q3 2026)

- [ ] Batch token deployment
- [ ] Token templates
- [ ] Analytics dashboard
- [ ] Token discovery marketplace
- [ ] Social features
- [ ] Multi-language support

### Phase 4: Pro Features (Q4 2026)

- [ ] Clawback functionality
- [x] Multi-sig support
- [ ] Advanced token management
- [ ] API access
- [ ] White-label solutions
- [ ] Enterprise features

### Phase 5: Ecosystem (2027)

- [ ] Mobile apps (iOS/Android)
- [ ] Token launchpad
- [ ] Liquidity pools integration
- [ ] DEX integration
- [ ] NFT support
- [ ] DAO governance

---

## ❓ FAQ

### General

**Q: What is Nova Launch?**  
A: Nova Launch is a no-code platform for deploying custom tokens on the Stellar blockchain.

**Q: Do I need coding experience?**  
A: No! Nova Launch is designed for non-technical users.

**Q: What are the fees?**  
A: Base deployment is 7 XLM, with an additional 3 XLM for metadata.

**Q: Which networks are supported?**  
A: Both Stellar testnet (for testing) and mainnet (for production).
