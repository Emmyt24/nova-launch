import axios from "axios";
import {
  calculateBackoffDelay,
  isRetryableError,
  sleep,
  RetryConfig,
} from "../stellar-service-integration/rate-limiter";

export class ContractAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractAddressError";
  }
}

// Stellar base32 alphabet (RFC 4648 without padding)
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Buffer {
  const chars = s.toUpperCase();
  const output: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of chars) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) {
      throw new ContractAddressError(
        `Invalid base32 character in contract ID: "${char}"`
      );
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

function calculateCrc16XModem(data: Buffer): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc << 1;
      if (crc & 0x10000) {
        crc = (crc ^ 0x1021) & 0xffff;
      } else {
        crc = crc & 0xffff;
      }
    }
  }
  return crc;
}

/**
 * Decodes a Soroban contract StrKey (C... 56 chars) to the 32-byte hash.
 * The CONTRACT strkey version byte is 0x10 (= 2 << 3).
 */
function decodeContractStrkey(contractId: string): Buffer {
  const decoded = base32Decode(contractId); // 35 bytes: version + 32-byte hash + 2-byte CRC
  if (decoded.length < 35) {
    throw new ContractAddressError(
      `Contract ID decoded to fewer bytes than expected: ${contractId}`
    );
  }
  // Version byte for CONTRACT = 2 << 3 = 0x10
  if (decoded[0] !== 0x10) {
    throw new ContractAddressError(
      `Contract ID has unexpected version byte 0x${decoded[0].toString(16)}: ${contractId}`
    );
  }

  // Verify CRC16-XModem checksum (last 2 bytes)
  const dataToCheck = decoded.slice(0, 33); // version + 32-byte hash
  const storedCrc = decoded.readUInt16BE(33);
  const computedCrc = calculateCrc16XModem(dataToCheck);

  if (storedCrc !== computedCrc) {
    throw new ContractAddressError(
      `Contract ID has invalid CRC checksum: ${contractId}`
    );
  }

  return decoded.slice(1, 33);
}

/**
 * Constructs the XDR-encoded LedgerKey for a Soroban contract's persistent
 * instance data entry, used with the Soroban RPC getLedgerEntries method.
 *
 * XDR layout (48 bytes):
 *   uint32 type          = 7   (LedgerEntryType::CONTRACT_DATA)
 *   uint32 addrType      = 1   (SCAddressType::SC_ADDRESS_TYPE_CONTRACT)
 *   bytes[32] hash            (32-byte contract hash)
 *   uint32 keyType       = 20  (SCValType::SCV_LEDGER_KEY_CONTRACT_INSTANCE)
 *   uint32 durability    = 1   (ContractDataDurability::PERSISTENT)
 */
function buildContractDataLedgerKey(contractHash: Buffer): Buffer {
  const buf = Buffer.alloc(48);
  let off = 0;
  buf.writeUInt32BE(7, off);
  off += 4; // CONTRACT_DATA
  buf.writeUInt32BE(1, off);
  off += 4; // SC_ADDRESS_TYPE_CONTRACT
  contractHash.copy(buf, off);
  off += 32;
  buf.writeUInt32BE(20, off);
  off += 4; // SCV_LEDGER_KEY_CONTRACT_INSTANCE
  buf.writeUInt32BE(1, off); // PERSISTENT
  return buf;
}

const VALIDATOR_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffFactor: 2,
  jitterFactor: 0.1,
};

/**
 * Verifies that the given Soroban contract exists on the active network by
 * calling the Soroban RPC getLedgerEntries endpoint.
 *
 * Retries on transient network failures with exponential backoff.
 * Throws ContractAddressError immediately on a format error or missing contract.
 */
export async function validateContractOnNetwork(
  contractId: string,
  sorobanRpcUrl: string,
  network: string,
  retryConfig: RetryConfig = VALIDATOR_RETRY_CONFIG
): Promise<void> {
  let contractHash: Buffer;
  try {
    contractHash = decodeContractStrkey(contractId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ContractAddressError(
      `FACTORY_CONTRACT_ID "${contractId}" cannot be decoded — ${msg}. ` +
        `Ensure it is a valid 56-character Soroban contract ID for ` +
        `STELLAR_NETWORK="${network}".`
    );
  }

  const ledgerKey = buildContractDataLedgerKey(contractHash);
  const base64Key = ledgerKey.toString("base64");

  let lastError: unknown;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      const response = await axios.post(
        sorobanRpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getLedgerEntries",
          params: { keys: [base64Key] },
        },
        {
          timeout: 10000,
          headers: { "Content-Type": "application/json" },
        }
      );

      const entries = response.data?.result?.entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new ContractAddressError(
          `Contract "${contractId}" was not found on STELLAR_NETWORK="${network}" ` +
            `(Soroban RPC: ${sorobanRpcUrl}). ` +
            `Verify the contract is deployed and FACTORY_CONTRACT_ID matches ` +
            `the active environment.`
        );
      }

      return; // contract confirmed on network
    } catch (error) {
      if (error instanceof ContractAddressError) throw error;

      lastError = error;

      if (!isRetryableError(error) || attempt === retryConfig.maxAttempts) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new ContractAddressError(
          `Failed to verify contract "${contractId}" on STELLAR_NETWORK="${network}" ` +
            `after ${attempt} attempt(s): ${msg}`
        );
      }

      const delay = calculateBackoffDelay(attempt, retryConfig);
      await sleep(delay);
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ContractAddressError(
    `Failed to verify contract "${contractId}" on STELLAR_NETWORK="${network}" ` +
      `after ${retryConfig.maxAttempts} attempts: ${msg}`
  );
}
