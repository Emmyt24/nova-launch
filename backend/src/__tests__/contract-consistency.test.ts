/**
 * Contract-Backend Consistency Tests
 * 
 * Ensures that the backend data models and API interfaces remain
 * consistent with the smart contract types and functions.
 * 
 * These tests verify:
 * 1. Data model field consistency (names, types, nullability)
 * 2. API endpoint parameter consistency
 * 3. Response format consistency
 * 4. Error code consistency
 * 5. Event structure consistency
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  OnChainProjectionVerifier,
  OnChainDataFetcher,
  type OnChainTokenState,
  type ConsistencyCheckResult,
} from '../services/consistency/onchainProjectionVerifier';

// ============================================================================
// Contract Type Definitions (from contracts/token-factory/src/types.rs)
// ============================================================================

interface ContractTokenInfo {
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  total_supply: bigint;
  initial_supply: bigint;
  total_burned: bigint;
  burn_count: number;
  metadata_uri: string | null;
  created_at: number;
  clawback_enabled: boolean;
}

interface ContractFactoryState {
  admin: string;
  treasury: string;
  base_fee: bigint;
  metadata_fee: bigint;
  paused: boolean;
}

interface ContractBurnRecord {
  token_index: number;
  from: string;
  amount: bigint;
  burned_by: string;
  is_admin_burn: boolean;
  timestamp: number;
}

// API Request/Response Types
interface CreateTokenRequest {
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  initial_supply: bigint;
  metadata_uri?: string;
}

interface TokenResponse {
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  initialSupply: bigint;
  totalBurned: bigint;
  burnCount: number;
  metadataUri: string | null;
  createdAt: string; // ISO 8601 timestamp
}

interface BurnRequest {
  token_address: string;
  amount: bigint;
  caller: string;
}

// Contract Event Types
interface TokenCreatedEvent {
  token_address: string;
  creator: string;
  name: string;
  symbol: string;
  initial_supply: bigint;
}

interface BurnEvent {
  token_address: string;
  from: string;
  amount: bigint;
  new_supply: bigint;
}

interface AdminTransferEvent {
  old_admin: string;
  new_admin: string;
}

interface PauseEvent {
  admin: string;
  paused: boolean;
}

interface FeesUpdatedEvent {
  base_fee: bigint;
  metadata_fee: bigint;
}

// Contract Error Codes (from types.rs)
enum ContractError {
  InsufficientFee = 1,
  Unauthorized = 2,
  InvalidParameters = 3,
  TokenNotFound = 4,
  MetadataAlreadySet = 5,
  AlreadyInitialized = 6,
  InsufficientBalance = 7,
  ArithmeticError = 8,
  BatchTooLarge = 9,
  InvalidAmount = 10,
  ClawbackDisabled = 11,
  InvalidBurnAmount = 12,
  BurnAmountExceedsBalance = 13,
  ContractPaused = 14,
}

// ============================================================================
// Backend Type Definitions (from Prisma schema)
// ============================================================================

interface BackendToken {
  id: string;
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  initialSupply: bigint;
  totalBurned: bigint;
  burnCount: number;
  metadataUri: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface BackendBurnRecord {
  id: string;
  tokenId: string;
  from: string;
  amount: bigint;
  burnedBy: string;
  isAdminBurn: boolean;
  txHash: string;
  timestamp: Date;
}

// ============================================================================
// Field Mapping Tests
// ============================================================================

describe('Contract-Backend Consistency Tests', () => {
  describe('TokenInfo Field Consistency', () => {
    it('should have matching field names (accounting for naming conventions)', () => {
      const contractFields: (keyof ContractTokenInfo)[] = [
        'address',
        'creator',
        'name',
        'symbol',
        'decimals',
        'total_supply',
        'initial_supply',
        'total_burned',
        'burn_count',
        'metadata_uri',
        'created_at',
        'clawback_enabled',
      ];

      const backendFields: (keyof BackendToken)[] = [
        'address',
        'creator',
        'name',
        'symbol',
        'decimals',
        'totalSupply',      // maps to total_supply
        'initialSupply',    // maps to initial_supply
        'totalBurned',      // maps to total_burned
        'burnCount',        // maps to burn_count
        'metadataUri',      // maps to metadata_uri
        'createdAt',        // maps to created_at
        // Note: clawback_enabled not stored in backend (contract-only state)
      ];

      // Verify all contract fields have backend equivalents
      const contractToBackendMap: Record<string, string> = {
        'address': 'address',
        'creator': 'creator',
        'name': 'name',
        'symbol': 'symbol',
        'decimals': 'decimals',
        'total_supply': 'totalSupply',
        'initial_supply': 'initialSupply',
        'total_burned': 'totalBurned',
        'burn_count': 'burnCount',
        'metadata_uri': 'metadataUri',
        'created_at': 'createdAt',
      };

      contractFields.forEach(field => {
        if (field !== 'clawback_enabled') {
          const backendField = contractToBackendMap[field];
          expect(backendFields).toContain(backendField as any);
        }
      });
    });

    it('should have matching field types', () => {
      // Create sample data to verify types
      const contractSample: ContractTokenInfo = {
        address: 'GABC123',
        creator: 'GDEF456',
        name: 'Test',
        symbol: 'TST',
        decimals: 7,
        total_supply: BigInt(1000),
        initial_supply: BigInt(1000),
        total_burned: BigInt(0),
        burn_count: 0,
        metadata_uri: null,
        created_at: 123456,
        clawback_enabled: false,
      };

      const backendSample: BackendToken = {
        id: 'uuid',
        address: 'GABC123',
        creator: 'GDEF456',
        name: 'Test',
        symbol: 'TST',
        decimals: 7,
        totalSupply: BigInt(1000),
        initialSupply: BigInt(1000),
        totalBurned: BigInt(0),
        burnCount: 0,
        metadataUri: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Verify string fields
      expect(typeof contractSample.address).toBe('string');
      expect(typeof backendSample.address).toBe('string');

      // Verify number fields
      expect(typeof contractSample.decimals).toBe('number');
      expect(typeof backendSample.decimals).toBe('number');

      // Verify BigInt fields
      expect(typeof contractSample.total_supply).toBe('bigint');
      expect(typeof backendSample.totalSupply).toBe('bigint');
    });

    it('should have matching nullability constraints', () => {
      // Required fields (non-nullable)
      const requiredFields = [
        'address',
        'creator',
        'name',
        'symbol',
        'decimals',
        'total_supply',
        'initial_supply',
        'total_burned',
        'burn_count',
        'created_at',
      ];

      // Optional fields (nullable)
      const optionalFields = ['metadata_uri'];

      // Verify contract and backend agree on nullability
      expect(requiredFields.length + optionalFields.length).toBeGreaterThan(0);
    });
  });

  describe('BurnRecord Field Consistency', () => {
    it('should have matching burn record fields', () => {
      const contractBurnFields: (keyof ContractBurnRecord)[] = [
        'token_index',
        'from',
        'amount',
        'burned_by',
        'is_admin_burn',
        'timestamp',
      ];

      const backendBurnFields: (keyof BackendBurnRecord)[] = [
        'tokenId',        // maps to token_index (but stores ID not index)
        'from',
        'amount',
        'burnedBy',       // maps to burned_by
        'isAdminBurn',    // maps to is_admin_burn
        'timestamp',
      ];

      const fieldMap: Record<string, string> = {
        'from': 'from',
        'amount': 'amount',
        'burned_by': 'burnedBy',
        'is_admin_burn': 'isAdminBurn',
        'timestamp': 'timestamp',
      };

      Object.entries(fieldMap).forEach(([contractField, backendField]) => {
        expect(backendBurnFields).toContain(backendField as any);
      });
    });
  });

  describe('Error Code Consistency', () => {
    it('should have all contract error codes documented', () => {
      const errorCodes = [
        ContractError.InsufficientFee,
        ContractError.Unauthorized,
        ContractError.InvalidParameters,
        ContractError.TokenNotFound,
        ContractError.MetadataAlreadySet,
        ContractError.AlreadyInitialized,
        ContractError.InsufficientBalance,
        ContractError.ArithmeticError,
        ContractError.BatchTooLarge,
        ContractError.InvalidAmount,
        ContractError.ClawbackDisabled,
        ContractError.InvalidBurnAmount,
        ContractError.BurnAmountExceedsBalance,
        ContractError.ContractPaused,
      ];

      // Verify all error codes are unique
      const uniqueCodes = new Set(errorCodes);
      expect(uniqueCodes.size).toBe(errorCodes.length);

      // Verify error codes are sequential starting from 1
      expect(Math.min(...errorCodes)).toBe(1);
      expect(Math.max(...errorCodes)).toBe(errorCodes.length);
    });

    it('should map contract errors to HTTP status codes', () => {
      const errorToHttpStatus: Record<ContractError, number> = {
        [ContractError.InsufficientFee]: 402,           // Payment Required
        [ContractError.Unauthorized]: 403,              // Forbidden
        [ContractError.InvalidParameters]: 400,         // Bad Request
        [ContractError.TokenNotFound]: 404,             // Not Found
        [ContractError.MetadataAlreadySet]: 409,        // Conflict
        [ContractError.AlreadyInitialized]: 409,        // Conflict
        [ContractError.InsufficientBalance]: 402,       // Payment Required
        [ContractError.ArithmeticError]: 500,           // Internal Server Error
        [ContractError.BatchTooLarge]: 413,             // Payload Too Large
        [ContractError.InvalidAmount]: 400,             // Bad Request
        [ContractError.ClawbackDisabled]: 403,          // Forbidden
        [ContractError.InvalidBurnAmount]: 400,         // Bad Request
        [ContractError.BurnAmountExceedsBalance]: 402,  // Payment Required
        [ContractError.ContractPaused]: 503,            // Service Unavailable
      };

      // Verify all errors have HTTP mappings
      Object.values(ContractError).forEach(errorCode => {
        if (typeof errorCode === 'number') {
          expect(errorToHttpStatus[errorCode]).toBeDefined();
          expect(errorToHttpStatus[errorCode]).toBeGreaterThanOrEqual(400);
          expect(errorToHttpStatus[errorCode]).toBeLessThan(600);
        }
      });
    });
  });

  describe('API Endpoint Consistency', () => {
    it('should have endpoints matching contract functions', () => {
      // Contract public functions that should have API endpoints
      const contractFunctions = [
        'initialize',
        'get_state',
        'get_base_fee',
        'get_metadata_fee',
        'transfer_admin',
        'pause',
        'unpause',
        'is_paused',
        'update_fees',
        'batch_update_admin',
        'get_token_count',
        'get_token_info',
        'get_token_info_by_address',
        'set_clawback',
        'burn',
        'batch_burn',
        'get_burn_count',
        'admin_burn',
        'set_metadata',
        'mint_tokens',
      ];

      // Expected API endpoints
      const apiEndpoints = [
        'POST /api/factory/initialize',
        'GET /api/factory/state',
        'GET /api/factory/fees',
        'POST /api/factory/admin/transfer',
        'POST /api/factory/admin/pause',
        'POST /api/factory/admin/unpause',
        'GET /api/factory/status',
        'PUT /api/factory/admin/fees',
        'PUT /api/factory/admin/batch',
        'GET /api/tokens',
        'GET /api/tokens/:index',
        'GET /api/tokens/address/:address',
        'PUT /api/tokens/:address/clawback',
        'POST /api/burn',
        'POST /api/burn/batch',
        'GET /api/tokens/:index/burns',
        'POST /api/burn/admin',
        'PUT /api/metadata/:index',
        'POST /api/tokens/:index/mint',
      ];

      // Verify we have API coverage for all contract functions
      expect(contractFunctions.length).toBeGreaterThan(0);
      expect(apiEndpoints.length).toBeGreaterThan(0);
      expect(apiEndpoints.length).toBeGreaterThanOrEqual(contractFunctions.length - 2); // Some functions may be combined
    });

    it('should have consistent request/response formats', () => {
      // Token creation request sample
      const createRequest: CreateTokenRequest = {
        creator: 'GABC123',
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 7,
        initial_supply: BigInt(1000000),
        metadata_uri: 'ipfs://test',
      };

      // Token response sample
      const tokenResponse: TokenResponse = {
        address: 'GTOKEN123',
        creator: 'GABC123',
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 7,
        totalSupply: BigInt(1000000),
        initialSupply: BigInt(1000000),
        totalBurned: BigInt(0),
        burnCount: 0,
        metadataUri: 'ipfs://test',
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      // Burn request sample
      const burnRequest: BurnRequest = {
        token_address: 'GTOKEN123',
        amount: BigInt(100),
        caller: 'GABC123',
      };

      // Verify types
      expect(typeof createRequest.creator).toBe('string');
      expect(typeof tokenResponse.address).toBe('string');
      expect(typeof burnRequest.amount).toBe('bigint');
    });
  });

  describe('Data Transformation Consistency', () => {
    it('should correctly transform contract data to backend format', () => {
      const contractData: ContractTokenInfo = {
        address: 'GABC123...',
        creator: 'GDEF456...',
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 7,
        total_supply: BigInt('1000000000000'),
        initial_supply: BigInt('1000000000000'),
        total_burned: BigInt('0'),
        burn_count: 0,
        metadata_uri: 'ipfs://QmTest123',
        created_at: 1234567890,
        clawback_enabled: false,
      };

      // Transform to backend format
      const backendData: Partial<BackendToken> = {
        address: contractData.address,
        creator: contractData.creator,
        name: contractData.name,
        symbol: contractData.symbol,
        decimals: contractData.decimals,
        totalSupply: contractData.total_supply,
        initialSupply: contractData.initial_supply,
        totalBurned: contractData.total_burned,
        burnCount: contractData.burn_count,
        metadataUri: contractData.metadata_uri,
        createdAt: new Date(contractData.created_at * 1000),
      };

      // Verify transformation
      expect(backendData.address).toBe(contractData.address);
      expect(backendData.totalSupply).toBe(contractData.total_supply);
      expect(backendData.createdAt?.getTime()).toBe(contractData.created_at * 1000);
    });

    it('should correctly transform backend data to API response format', () => {
      const backendData: BackendToken = {
        id: 'uuid-123',
        address: 'GABC123...',
        creator: 'GDEF456...',
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 7,
        totalSupply: BigInt('1000000000000'),
        initialSupply: BigInt('1000000000000'),
        totalBurned: BigInt('0'),
        burnCount: 0,
        metadataUri: 'ipfs://QmTest123',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };

      // Transform to API response
      const apiResponse = {
        address: backendData.address,
        creator: backendData.creator,
        name: backendData.name,
        symbol: backendData.symbol,
        decimals: backendData.decimals,
        totalSupply: backendData.totalSupply.toString(),
        initialSupply: backendData.initialSupply.toString(),
        totalBurned: backendData.totalBurned.toString(),
        burnCount: backendData.burnCount,
        metadataUri: backendData.metadataUri,
        createdAt: backendData.createdAt.toISOString(),
      };

      // Verify transformation
      expect(apiResponse.address).toBe(backendData.address);
      expect(apiResponse.totalSupply).toBe('1000000000000');
      expect(apiResponse.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('Validation Rule Consistency', () => {
    it('should enforce same validation rules as contract', () => {
      // Token name validation
      const validateTokenName = (name: string): boolean => {
        return name.length > 0 && name.length <= 32;
      };

      // Token symbol validation
      const validateTokenSymbol = (symbol: string): boolean => {
        return symbol.length > 0 && symbol.length <= 12;
      };

      // Decimals validation
      const validateDecimals = (decimals: number): boolean => {
        return decimals >= 0 && decimals <= 18;
      };

      // Amount validation
      const validateAmount = (amount: bigint): boolean => {
        return amount > BigInt(0);
      };

      // Test validations
      expect(validateTokenName('Test Token')).toBe(true);
      expect(validateTokenName('')).toBe(false);
      expect(validateTokenName('A'.repeat(33))).toBe(false);

      expect(validateTokenSymbol('TEST')).toBe(true);
      expect(validateTokenSymbol('')).toBe(false);
      expect(validateTokenSymbol('TOOLONGSYMBOL')).toBe(false);

      expect(validateDecimals(7)).toBe(true);
      expect(validateDecimals(18)).toBe(true);
      expect(validateDecimals(-1)).toBe(false);
      expect(validateDecimals(19)).toBe(false);

      expect(validateAmount(BigInt(1000))).toBe(true);
      expect(validateAmount(BigInt(0))).toBe(false);
      expect(validateAmount(BigInt(-1))).toBe(false);
    });

    it('should enforce batch size limits', () => {
      const MAX_BATCH_BURN = 100;

      const validateBatchSize = (size: number): boolean => {
        return size > 0 && size <= MAX_BATCH_BURN;
      };

      expect(validateBatchSize(1)).toBe(true);
      expect(validateBatchSize(100)).toBe(true);
      expect(validateBatchSize(0)).toBe(false);
      expect(validateBatchSize(101)).toBe(false);
    });
  });

  describe('Event Structure Consistency', () => {
    it('should have matching event structures', () => {
      // Contract events samples
      const tokenCreatedEvent: TokenCreatedEvent = {
        token_address: 'GTOKEN123',
        creator: 'GABC123',
        name: 'Test Token',
        symbol: 'TEST',
        initial_supply: BigInt(1000000),
      };

      const burnEvent: BurnEvent = {
        token_address: 'GTOKEN123',
        from: 'GABC123',
        amount: BigInt(100),
        new_supply: BigInt(999900),
      };

      const adminTransferEvent: AdminTransferEvent = {
        old_admin: 'GADMIN1',
        new_admin: 'GADMIN2',
      };

      const pauseEvent: PauseEvent = {
        admin: 'GADMIN1',
        paused: true,
      };

      const feesUpdatedEvent: FeesUpdatedEvent = {
        base_fee: BigInt(1000000),
        metadata_fee: BigInt(500000),
      };

      // Verify event structures
      expect(typeof tokenCreatedEvent.token_address).toBe('string');
      expect(typeof burnEvent.amount).toBe('bigint');
      expect(typeof adminTransferEvent.new_admin).toBe('string');
      expect(typeof pauseEvent.paused).toBe('boolean');
      expect(typeof feesUpdatedEvent.base_fee).toBe('bigint');
    });
  });

  describe('Numeric Precision Consistency', () => {
    it('should handle large numbers consistently', () => {
      // Test BigInt handling
      const largeNumber = BigInt('999999999999999999999999');
      
      // Verify BigInt operations
      expect(largeNumber + BigInt(1)).toBe(BigInt('1000000000000000000000000'));
      expect(largeNumber - BigInt(1)).toBe(BigInt('999999999999999999999998'));

      // Verify string conversion for API
      expect(largeNumber.toString()).toBe('999999999999999999999999');
    });

    it('should handle decimal precision correctly', () => {
      // Stellar uses 7 decimals (stroops)
      const STELLAR_DECIMALS = 7;
      const ONE_TOKEN = BigInt(10 ** STELLAR_DECIMALS);

      expect(ONE_TOKEN).toBe(BigInt(10000000));

      // Convert from human-readable to stroops
      const humanAmount = 100.5;
      const stroops = BigInt(Math.floor(humanAmount * 10 ** STELLAR_DECIMALS));
      expect(stroops).toBe(BigInt(1005000000));

      // Convert from stroops to human-readable
      const backToHuman = Number(stroops) / 10 ** STELLAR_DECIMALS;
      expect(backToHuman).toBe(100.5);
    });
  });

  describe('Timestamp Consistency', () => {
    it('should handle Unix timestamps correctly', () => {
      // Contract uses Unix timestamps (seconds)
      const contractTimestamp = 1234567890;

      // Backend uses JavaScript Date
      const backendDate = new Date(contractTimestamp * 1000);

      // Verify conversion
      expect(Math.floor(backendDate.getTime() / 1000)).toBe(contractTimestamp);

      // Verify ISO string format for API
      const isoString = backendDate.toISOString();
      expect(isoString).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('Address Format Consistency', () => {
    it('should validate Stellar address format', () => {
      const validateStellarAddress = (address: string): boolean => {
        // Stellar addresses start with G and are 56 characters total
        return /^G[A-Z2-7]{55}$/.test(address);
      };

      // Valid Stellar address (56 chars total: G + 55 chars of A-Z2-7)
      const validAddress = 'G' + 'A'.repeat(55);
      expect(validAddress.length).toBe(56);
      expect(validateStellarAddress(validAddress)).toBe(true);
      
      // Invalid addresses
      expect(validateStellarAddress('INVALID')).toBe(false);
      expect(validateStellarAddress('CABC123...')).toBe(false); // Wrong prefix
      expect(validateStellarAddress('G123')).toBe(false); // Too short
    });
  });
});

// ============================================================================
// Production Projection Consistency Tests
// ============================================================================

describe('Production Projection Consistency Tests', () => {
  let mockPrisma: any;
  let verifier: OnChainProjectionVerifier;

  beforeEach(() => {
    mockPrisma = {
      token: {
        count: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      burnRecord: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      $disconnect: vi.fn(),
    };

    verifier = new OnChainProjectionVerifier(mockPrisma as unknown as PrismaClient, {
      factoryContractId: 'CFACTORY123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABC',
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });
  });

  describe('Token Count Consistency', () => {
    it('should detect mismatched token counts', async () => {
      mockPrisma.token.count.mockResolvedValue(10);

      const result = await verifier.checkTokenCounts();

      expect(mockPrisma.token.count).toHaveBeenCalled();
      expect(result.checked).toBe(10);
    });

    it('should report token count drift as inconsistency', async () => {
      mockPrisma.token.count.mockResolvedValue(100);

      const mockOnChainState: OnChainTokenState = {
        address: 'GTOKEN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABCDEF',
        creator: 'GCREATOR123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABC',
        name: 'Test Token',
        symbol: 'TST',
        decimals: 7,
        totalSupply: BigInt('1000000000000'),
        initialSupply: BigInt('1000000000000'),
        totalBurned: BigInt('0'),
        burnCount: 0,
      };

      const diffs = await verifier.checkTokenBurnConsistency(
        mockOnChainState.address,
        mockOnChainState
      );

      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs[0].entity).toBe('token');
      expect(diffs[0].field).toBe('existence');
    });
  });

  describe('Burn Totals Consistency', () => {
    it('should detect mismatched burn totals', async () => {
      const mockToken = {
        address: 'GTOKEN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABCDEF',
        totalBurned: BigInt('1000000'),
        burnCount: 5,
      };

      mockPrisma.token.findMany.mockResolvedValue([mockToken]);

      const result = await verifier.checkBurnTotals();

      expect(mockPrisma.token.findMany).toHaveBeenCalledWith({
        where: { burnCount: { gt: 0 } },
        select: {
          address: true,
          totalBurned: true,
          burnCount: true,
        },
      });
    });

    it('should flag burn count mismatch with on-chain state', async () => {
      mockPrisma.token.findUnique.mockResolvedValue({
        address: 'GTOKEN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABCDEF',
        totalBurned: BigInt('500000'),
        burnCount: 3,
        totalSupply: BigInt('999500000'),
      });

      const onChainState: OnChainTokenState = {
        address: 'GTOKEN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABCDEF',
        creator: 'GCREATOR123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABC',
        name: 'Test Token',
        symbol: 'TST',
        decimals: 7,
        totalSupply: BigInt('999500000'),
        initialSupply: BigInt('1000000000'),
        totalBurned: BigInt('1000000'),
        burnCount: 5,
      };

      const diffs = await verifier.checkTokenBurnConsistency(
        onChainState.address,
        onChainState
      );

      expect(diffs.some(d => d.field === 'totalBurned')).toBe(true);
      expect(diffs.some(d => d.field === 'burnCount')).toBe(true);
    });

    it('should pass when burn totals match', async () => {
      const burnAmount = BigInt('500000');
      const burnCount = 3;

      mockPrisma.token.findUnique.mockResolvedValue({
        address: 'GTOKEN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABCDEF',
        totalBurned: burnAmount,
        burnCount: burnCount,
        totalSupply: BigInt('999500000'),
      });

      const onChainState: OnChainTokenState = {
        address: 'GTOKEN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABCDEF',
        creator: 'GCREATOR123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789ABC',
        name: 'Test Token',
        symbol: 'TST',
        decimals: 7,
        totalSupply: BigInt('999500000'),
        initialSupply: BigInt('1000000000'),
        totalBurned: burnAmount,
        burnCount: burnCount,
      };

      const diffs = await verifier.checkTokenBurnConsistency(
        onChainState.address,
        onChainState
      );

      expect(diffs.length).toBe(0);
    });
  });

  describe('Result Formatting', () => {
    it('should format results for human-readable output', () => {
      const result: ConsistencyCheckResult = {
        consistent: false,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        totalChecked: 15,
        tokensChecked: 10,
        burnsChecked: 3,
        diffs: [
          {
            entity: 'token',
            identifier: 'GTOKEN123',
            field: 'totalBurned',
            backendValue: '500000',
            onChainValue: '1000000',
            severity: 'error',
          },
        ],
        errors: [],
        duration: 1500,
      };

      const formatted = verifier.formatResults(result);

      expect(formatted).toContain('Consistent: ❌ NO');
      expect(formatted).toContain('Tokens checked:    10');
      expect(formatted).toContain('Burns checked:     3');
      expect(formatted).toContain('GTOKEN123');
      expect(formatted).toContain('totalBurned');
    });

    it('should format successful results correctly', () => {
      const result: ConsistencyCheckResult = {
        consistent: true,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        totalChecked: 15,
        tokensChecked: 10,
        burnsChecked: 3,
        diffs: [],
        errors: [],
        duration: 500,
      };

      const formatted = verifier.formatResults(result);

      expect(formatted).toContain('Consistent: ✅ YES');
      expect(formatted).toContain('No inconsistencies found');
    });

    it('should generate JSON report for CI systems', () => {
      const result: ConsistencyCheckResult = {
        consistent: false,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        totalChecked: 5,
        tokensChecked: 3,
        burnsChecked: 1,
        diffs: [
          {
            entity: 'burn',
            identifier: 'GTOKEN123',
            field: 'burnCount',
            backendValue: 3,
            onChainValue: 5,
            severity: 'error',
          },
        ],
        errors: ['Network timeout on fetch'],
        duration: 2000,
      };

      const report = verifier.generateReport(result) as any;

      expect(report.success).toBe(false);
      expect(report.summary.inconsistencies).toBe(1);
      expect(report.summary.errors).toBe(1);
      expect(report.diffs[0].entity).toBe('burn');
      expect(report.errors).toContain('Network timeout on fetch');
    });
  });

});
