#!/usr/bin/env node

/**
 * Extract Contract Interface Snapshot
 *
 * Parses contracts/token-factory/src/lib.rs and generates a stable JSON interface
 * snapshot. This snapshot captures:
 * - All public function names
 * - Parameter order and types (extracted from source)
 * - Return types (when parseable)
 *
 * Output: build/contract-interface.snapshot.json
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const LIB_RS = path.join(PROJECT_ROOT, "contracts/token-factory/src/lib.rs");
const OUTPUT_FILE = path.join(
  PROJECT_ROOT,
  "build/contract-interface.snapshot.json",
);

// Ensure output directory exists
if (!fs.existsSync(path.dirname(OUTPUT_FILE))) {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
}

// ============================================================================
// Parse lib.rs and extract function signatures
// ============================================================================

function extractFunctionSignatures() {
  const src = fs.readFileSync(LIB_RS, "utf-8");
  const functions = [];

  // Match public function signatures with their parameters
  // Pattern: pub fn name(params) -> ReturnType
  const functionRegex =
    /pub\s+fn\s+([a-z_]+)\s*\(\s*([^)]*?)\s*\)\s*(?:->\s*([^{;]+?))?\s*[{;]/g;

  let match;
  while ((match = functionRegex.exec(src)) !== null) {
    const [fullMatch, name, paramsStr, returnType] = match;

    // Parse parameters
    const params = parseParameters(paramsStr);

    functions.push({
      name,
      params,
      returnType: returnType ? returnType.trim() : null,
      lineNumber: src.substring(0, match.index).split("\n").length,
    });
  }

  return functions;
}

/**
 * Parse function parameters into structured format
 * Handles: Env, Address, i128, u32, bool, String, Bytes, Vec<T>, etc.
 */
function parseParameters(paramsStr) {
  if (!paramsStr.trim()) return [];

  const params = [];
  const paramParts = splitParameters(paramsStr);

  for (const part of paramParts) {
    const part_trim = part.trim();
    if (!part_trim) continue;

    // Match: name: Type or just: Type
    const match = part_trim.match(/^(\w+)\s*:\s*(.+)$/);
    if (match) {
      const [, name, type] = match;
      params.push({
        name,
        type: type.trim(),
        order: params.length,
      });
    } else {
      // Just a type (shouldn't happen in valid Rust, but handle it)
      params.push({
        name: null,
        type: part_trim,
        order: params.length,
      });
    }
  }

  return params;
}

/**
 * Smart parameter splitting that handles nested angle brackets
 * e.g. "Vec<TokenCreationParams>, String" -> ["Vec<TokenCreationParams>", "String"]
 */
function splitParameters(paramsStr) {
  const result = [];
  let current = "";
  let depth = 0;

  for (const char of paramsStr) {
    if (char === "<") depth++;
    else if (char === ">") depth--;
    else if (char === "," && depth === 0) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current) result.push(current);
  return result;
}

// ============================================================================
// Format and validate snapshot
// ============================================================================

function createSnapshot(functions) {
  // Group by function name to detect duplicates
  const byName = {};
  functions.forEach((fn) => {
    if (!byName[fn.name]) byName[fn.name] = [];
    byName[fn.name].push(fn);
  });

  // Detect overloads (shouldn't exist in Soroban contracts, but log it)
  const overloaded = Object.entries(byName)
    .filter(([, fns]) => fns.length > 1)
    .map(([name]) => name);

  if (overloaded.length > 0) {
    console.warn(
      `⚠️  Overloaded functions detected (unexpected): ${overloaded.join(", ")}`,
    );
  }

  // Sort functions by name for stable output
  const sortedFns = Object.values(byName)
    .map((variants) => variants[0]) // Take first variant (or could merge)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: "1.0",
    timestamp: new Date().toISOString(),
    contractPath: "contracts/token-factory/src/lib.rs",
    functionCount: sortedFns.length,
    functions: sortedFns.map((fn) => ({
      name: fn.name,
      paramCount: fn.params.length,
      params: fn.params.map((p) => ({
        order: p.order,
        name: p.name,
        type: p.type,
      })),
      returnType: fn.returnType,
      source: {
        line: fn.lineNumber,
      },
    })),
  };
}

// ============================================================================
// Main
// ============================================================================

function main() {
  try {
    console.log(`📖 Extracting contract interface from: ${LIB_RS}`);

    if (!fs.existsSync(LIB_RS)) {
      console.error(`❌ lib.rs not found: ${LIB_RS}`);
      process.exit(1);
    }

    const functions = extractFunctionSignatures();
    console.log(`✅ Found ${functions.length} public functions`);

    const snapshot = createSnapshot(functions);
    const json = JSON.stringify(snapshot, null, 2);

    fs.writeFileSync(OUTPUT_FILE, json);
    console.log(`✅ Snapshot written to: ${OUTPUT_FILE}`);
    console.log(`   Size: ${(json.length / 1024).toFixed(2)} KB`);
    console.log(`   Functions: ${snapshot.functionCount}`);

    // Print summary of exported functions for verification
    console.log("\n📋 Exported functions:");
    snapshot.functions.slice(0, 10).forEach((fn) => {
      const params = fn.params.map((p) => `${p.name}: ${p.type}`).join(", ");
      console.log(`   • ${fn.name}(${params})`);
    });
    if (snapshot.functions.length > 10) {
      console.log(`   ... and ${snapshot.functions.length - 10} more`);
    }

    // Verify that the interface includes functions required by recent features:
    // - Fee quote view function (#2244)
    // - Admin TTL bump function (#2242)
    // - Allowlist management functions (#2245)
    const requiredFunctions = [
      "quote_creation_fee",
      "bump_ttl",
      "set_allowlist_mode",
      "add_to_allowlist",
      "remove_from_allowlist",
    ];
    const exportedNames = new Set(snapshot.functions.map((fn) => fn.name));
    const missing = requiredFunctions.filter((name) => !exportedNames.has(name));

    if (missing.length > 0) {
      console.warn(
        `⚠️  Expected interface functions not found: ${missing.join(", ")}`,
      );
    } else {
      console.log(
        `✅ Verified feature functions present: ${requiredFunctions.join(", ")}`,
      );
    }
  } catch (error) {
    console.error("❌ Error extracting interface:", error.message);
    process.exit(1);
  }
}

main();
