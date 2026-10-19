/**
 * Global GraphQL complexity budget configuration (#2205).
 *
 * Kept separate from `tenantComplexityBudgetService` so the HTTP layer can
 * read the configured default without depending on the database-backed
 * service.
 */

export const DEFAULT_COMPLEXITY_BUDGET = 100;

/**
 * Global complexity budget for tenants without an override, from
 * GRAPHQL_MAX_COMPLEXITY. Malformed or non-positive values fall back to
 * DEFAULT_COMPLEXITY_BUDGET so the limit is never silently disabled.
 */
export function resolveDefaultComplexityBudget(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_COMPLEXITY_BUDGET;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(
      `[GraphQL] Invalid GRAPHQL_MAX_COMPLEXITY "${raw}" — falling back to default budget of ${DEFAULT_COMPLEXITY_BUDGET}`
    );
    return DEFAULT_COMPLEXITY_BUDGET;
  }
  return parsed;
}
