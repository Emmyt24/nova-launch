import { PrismaClient } from "@prisma/client";
import type { TenantContext } from "../middleware/tenancy";

const prisma = new PrismaClient();

const DEFAULT_COMPLEXITY_BUDGET = 100;

export interface TenantComplexityBudget {
  tenantId: string;
  complexityBudget: number;
}

/**
 * Service for managing per-tenant GraphQL query complexity budget overrides.
 * Allows fine-tuning complexity limits for individual tenants beyond the
 * global default, preventing legitimate heavy-usage tenants from being blocked
 * while protecting smaller tenants from abuse.
 */
export class TenantComplexityBudgetService {
  /**
   * In-memory cache of tenant complexity budgets to avoid database queries
   * on every GraphQL operation. Cache is invalidated when a budget is updated.
   */
  private static budgetCache = new Map<string, number>();

  /**
   * Get the complexity budget for a tenant.
   * Returns the tenant-specific override if set, otherwise the global default.
   *
   * @param tenant - The tenant context containing the tenant ID
   * @returns The complexity budget for the tenant
   */
  async getBudgetForTenant(tenant: TenantContext | undefined | null): Promise<number> {
    if (!tenant || !tenant.id) {
      return DEFAULT_COMPLEXITY_BUDGET;
    }

    // Check cache first
    if (TenantComplexityBudgetService.budgetCache.has(tenant.id)) {
      return TenantComplexityBudgetService.budgetCache.get(tenant.id)!;
    }

    // Query database for override
    const override = await prisma.tenantComplexityBudget.findUnique({
      where: { tenantId: tenant.id },
    });

    const budget = override?.complexityBudget ?? DEFAULT_COMPLEXITY_BUDGET;
    TenantComplexityBudgetService.budgetCache.set(tenant.id, budget);
    return budget;
  }

  /**
   * Set a complexity budget override for a tenant.
   *
   * @param tenantId - The tenant ID
   * @param complexityBudget - The new complexity budget (must be positive)
   * @returns The updated budget override
   */
  async setBudget(tenantId: string, complexityBudget: number): Promise<TenantComplexityBudget> {
    if (complexityBudget <= 0) {
      throw new Error("Complexity budget must be positive");
    }

    const updated = await prisma.tenantComplexityBudget.upsert({
      where: { tenantId },
      update: { complexityBudget },
      create: { tenantId, complexityBudget },
    });

    // Invalidate cache for this tenant
    TenantComplexityBudgetService.budgetCache.delete(tenantId);

    return {
      tenantId: updated.tenantId,
      complexityBudget: updated.complexityBudget,
    };
  }

  /**
   * Reset a tenant's complexity budget to the global default by deleting the override.
   *
   * @param tenantId - The tenant ID
   */
  async resetBudget(tenantId: string): Promise<void> {
    await prisma.tenantComplexityBudget.delete({
      where: { tenantId },
    }).catch(() => {
      // Silently ignore if the override doesn't exist
    });

    // Invalidate cache for this tenant
    TenantComplexityBudgetService.budgetCache.delete(tenantId);
  }

  /**
   * List all active budget overrides.
   *
   * @param limit - Maximum number of results to return
   * @param offset - Pagination offset
   * @returns Array of tenant complexity budgets
   */
  async listOverrides(limit: number = 100, offset: number = 0): Promise<TenantComplexityBudget[]> {
    const overrides = await prisma.tenantComplexityBudget.findMany({
      take: limit,
      skip: offset,
    });

    return overrides.map(o => ({
      tenantId: o.tenantId,
      complexityBudget: o.complexityBudget,
    }));
  }

  /**
   * Clear the in-memory cache. Useful for testing or when cache invalidation
   * is needed outside the normal update/delete flow.
   */
  clearCache(): void {
    TenantComplexityBudgetService.budgetCache.clear();
  }
}

export const tenantComplexityBudgetService = new TenantComplexityBudgetService();
