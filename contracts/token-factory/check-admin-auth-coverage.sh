#!/usr/bin/env bash
#
# check-admin-auth-coverage.sh
#
# Verifies that every admin-gated function in the token-factory contract has a
# corresponding negative authorization test (i.e. a test proving that a
# non-admin caller is rejected).
#
# Admin-gated functions are detected by scanning `src/lib.rs` for functions that
# call `require_auth` on the stored admin address (e.g. `admin.require_auth()`
# or `Self::require_admin(...)`). For each such function, we require that at
# least one test in the test modules references the function name together with
# a rejection indicator (e.g. `should_panic`, `Unauthorized`, `NotAdmin`,
# `non_admin`, `non-admin`, `reject`, `forbidden`).
#
# Exits non-zero if any admin-gated function lacks a rejection test.
#
# See docs/admin-auth-testing.md for the documented pattern.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="${SCRIPT_DIR}"
LIB_FILE="${CONTRACT_DIR}/src/lib.rs"
TEST_DIR="${CONTRACT_DIR}/src"

if [[ ! -f "${LIB_FILE}" ]]; then
  echo "error: could not find ${LIB_FILE}" >&2
  exit 2
fi

# Collect all Rust source files that may contain tests.
mapfile -t TEST_FILES < <(find "${TEST_DIR}" -type f -name '*.rs' | sort)

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  echo "error: no Rust source files found under ${TEST_DIR}" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 1. Enumerate admin-gated functions in lib.rs.
#
# We look for `pub fn <name>(` declarations and, within the function body,
# a call to `require_auth` on an admin-like receiver. To keep the scan robust
# without a full parser, we walk the file line by line, tracking the current
# function name and brace depth, and flag the function if we see an admin auth
# call before the function closes.
# ---------------------------------------------------------------------------

ADMIN_AUTH_PATTERN='(admin|ADMIN|self\.admin|Self::admin)[^;]*\.require_auth\s*\('
ADMIN_HELPER_PATTERN='(require_admin|require_admin_auth|assert_admin|check_admin)\s*\('
FN_DECL_PATTERN='^[[:space:]]*(pub[[:space:]]+)?(async[[:space:]]+)?fn[[:space:]]+([A-Za-z0-9_]+)'

declare -a ADMIN_FUNCS=()
current_fn=""
depth=0
in_fn=0
fn_is_admin=0

while IFS= read -r line || [[ -n "${line}" ]]; do
  # Strip line comments to avoid false positives from documentation.
  stripped="${line%%//*}"

  if [[ ${in_fn} -eq 0 ]]; then
    if [[ "${stripped}" =~ ${FN_DECL_PATTERN} ]]; then
      current_fn="${BASH_REMATCH[3]}"
      in_fn=1
      fn_is_admin=0
      depth=0
    fi
  fi

  if [[ ${in_fn} -eq 1 ]]; then
    # Detect admin auth usage inside the function body.
    if [[ "${stripped}" =~ ${ADMIN_AUTH_PATTERN} ]] || [[ "${stripped}" =~ ${ADMIN_HELPER_PATTERN} ]]; then
      fn_is_admin=1
    fi

    # Track brace depth (approximate; ignores braces in strings/chars).
    opens="${stripped//[^\{]/}"
    closes="${stripped//[^\}]/}"
    depth=$(( depth + ${#opens} - ${#closes} ))

    if [[ ${depth} -le 0 && ${fn_is_admin} -eq 1 ]]; then
      ADMIN_FUNCS+=("${current_fn}")
      in_fn=0
      current_fn=""
      fn_is_admin=0
      depth=0
    elif [[ ${depth} -le 0 ]]; then
      in_fn=0
      current_fn=""
      fn_is_admin=0
      depth=0
    fi
  fi
done < "${LIB_FILE}"

# De-duplicate while preserving order.
if [[ ${#ADMIN_FUNCS[@]} -gt 0 ]]; then
  mapfile -t ADMIN_FUNCS < <(printf '%s\n' "${ADMIN_FUNCS[@]}" | awk '!seen[$0]++')
fi

if [[ ${#ADMIN_FUNCS[@]} -eq 0 ]]; then
  echo "check-admin-auth-coverage: no admin-gated functions detected in lib.rs"
  exit 0
fi

echo "check-admin-auth-coverage: detected ${#ADMIN_FUNCS[@]} admin-gated function(s):"
for fn in "${ADMIN_FUNCS[@]}"; do
  echo "  - ${fn}"
done
echo

# ---------------------------------------------------------------------------
# 2. For each admin-gated function, verify a rejection test exists.
# ---------------------------------------------------------------------------

REJECTION_PATTERN='(should_panic|Unauthorized|NotAdmin|NotAuthorized|non[_-]?admin|reject|forbidden|panic)'

missing=0
declare -a MISSING_FUNCS=()

for fn in "${ADMIN_FUNCS[@]}"; do
  found=0
  for test_file in "${TEST_FILES[@]}"; do
    # Skip the contract source itself when looking for tests, unless it
    # contains an inline #[cfg(test)] module (common in Soroban contracts).
    if [[ "${test_file}" == "${LIB_FILE}" ]] && ! grep -q '#\[cfg(test)\]' "${test_file}"; then
      continue
    fi

    # Look for a test function that references this admin function name and
    # also contains a rejection indicator. We search within the test file for
    # a `fn <something>` block whose name or body mentions the admin function
    # and a rejection marker.
    if grep -Eq "fn[[:space:]]+[A-Za-z0-9_]*${fn}[A-Za-z0-9_]*[[:space:]]*\(" "${test_file}" 2>/dev/null; then
      # Extract the test function body region (from the fn decl to the next
      # top-level `fn` or EOF) and check for a rejection indicator.
      if awk -v fnpat="${fn}" '
        BEGIN { in_test = 0; depth = 0 }
        {
          if (!in_test && $0 ~ ("fn[[:space:]]+[A-Za-z0-9_]*" fnpat "[A-Za-z0-9_]*[[:space:]]*\\(")) {
            in_test = 1
          }
          if (in_test) {
            print
            opens = gsub(/\{/, "{")
            closes = gsub(/\}/, "}")
            depth += opens - closes
            if (depth <= 0 && opens + closes > 0) { exit }
          }
        }
      ' "${test_file}" | grep -Eq "${REJECTION_PATTERN}"; then
        found=1
        break
      fi
    fi
  done

  if [[ ${found} -eq 1 ]]; then
    echo "  OK    ${fn}"
  else
    echo "  MISSING rejection test for admin function: ${fn}"
    MISSING_FUNCS+=("${fn}")
    missing=$((missing + 1))
  fi
done

echo

if [[ ${missing} -gt 0 ]]; then
  echo "check-admin-auth-coverage: FAILED — ${missing} admin-gated function(s) lack a negative authorization test:" >&2
  for fn in "${MISSING_FUNCS[@]}"; do
    echo "  - ${fn}" >&2
  done
  echo >&2
  echo "Add a test that calls each function as a non-admin and asserts it is rejected." >&2
  echo "See docs/admin-auth-testing.md for the documented pattern." >&2
  exit 1
fi

echo "check-admin-auth-coverage: PASSED — every admin-gated function has a rejection test."
exit 0