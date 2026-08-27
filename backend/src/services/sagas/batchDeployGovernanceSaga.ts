/**
 * Batch-deploy-plus-governance-registration saga.
 *
 * The first real saga run through `SagaCoordinator` (#1621). Models the
 * two-step, cross-contract operation that previously had no all-or-nothing
 * guarantee: deploying a batch of tokens on-chain, then registering each
 * deployed token for governance participation. A failure in the second step
 * must not leave a token deployed but permanently unregistered — it must be
 * compensated (in reverse order) so the whole operation is undone.
 *
 * Importing this module registers the saga definition against the shared
 * `sagaCoordinator` singleton as a side effect (see `backend/src/index.ts`).
 *
 * Issue: #1621
 */

import { PrismaClient } from "@prisma/client";
import { SagaDefinition, SagaResult } from "../sagaCoordinator";
import sagaCoordinator from "../sagaCoordinator";
import { callStellarDeploy, TokenDeployInput } from "../batchTokenDeployService";
import { eventBus } from "../eventBus";

export const BATCH_DEPLOY_GOVERNANCE_SAGA_TYPE = "batch_deploy_with_governance_registration";

export interface BatchDeployGovernanceContext {
  inputs: TokenDeployInput[];
  deployedTokenIds?: string[];
  deployedAddresses?: string[];
}

/**
 * Builds the saga definition. Exported (rather than only registered as a
 * side effect) so callers/tests can construct one against an injected
 * Prisma client instead of the module-level default.
 */
export function createBatchDeployGovernanceSaga(
  prismaClient: PrismaClient,
): SagaDefinition<BatchDeployGovernanceContext> {
  return {
    sagaType: BATCH_DEPLOY_GOVERNANCE_SAGA_TYPE,
    steps: [
      {
        name: "deploy_tokens",
        async execute(context) {
          // On-chain calls first (mirrors batchTokenDeployService's fail-fast
          // ordering) — no DB writes happen until every call succeeds.
          const stellarResults = [];
          for (const input of context.inputs) {
            stellarResults.push(await callStellarDeploy(input));
          }

          const createdTokens = await prismaClient.$transaction(
            context.inputs.map((input, i) => {
              const supply = BigInt(input.initialSupply);
              return prismaClient.token.create({
                data: {
                  address: stellarResults[i].address,
                  creator: input.creator,
                  name: input.name,
                  symbol: input.symbol,
                  decimals: input.decimals,
                  totalSupply: supply,
                  initialSupply: supply,
                  totalBurned: BigInt(0),
                  burnCount: 0,
                  metadataUri: input.metadataUri ?? null,
                },
              });
            }),
          );

          for (const token of createdTokens) {
            // Fire-and-forget: event failures must not roll back a successful step.
            eventBus
              .publish("token.deployed", {
                tokenId: token.id,
                address: token.address,
                creator: token.creator,
                name: token.name,
                symbol: token.symbol,
                decimals: token.decimals,
                initialSupply: token.initialSupply.toString(),
                metadataUri: token.metadataUri,
              })
              .catch((err) => console.error("[batchDeployGovernanceSaga] event emission failed:", err));
          }

          return {
            deployedTokenIds: createdTokens.map((t) => t.id),
            deployedAddresses: createdTokens.map((t) => t.address),
          } satisfies Partial<BatchDeployGovernanceContext>;
        },
        async compensate(context) {
          const tokenIds = context.deployedTokenIds ?? [];
          if (tokenIds.length === 0) return;
          // Idempotent: deleting an already-deleted (or never-created) id set is a no-op.
          await prismaClient.token.deleteMany({ where: { id: { in: tokenIds } } });
        },
      },
      {
        name: "register_governance",
        async execute(context) {
          const tokenIds = context.deployedTokenIds ?? [];
          await prismaClient.$transaction(
            tokenIds.map((tokenId) =>
              prismaClient.tokenGovernanceRegistration.upsert({
                where: { tokenId },
                create: { tokenId },
                update: {},
              }),
            ),
          );
        },
        async compensate(context) {
          const tokenIds = context.deployedTokenIds ?? [];
          if (tokenIds.length === 0) return;
          // Idempotent: deleteMany over an already-undone set is a no-op.
          await prismaClient.tokenGovernanceRegistration.deleteMany({
            where: { tokenId: { in: tokenIds } },
          });
        },
      },
    ],
  };
}

sagaCoordinator.registerSaga(createBatchDeployGovernanceSaga(new PrismaClient()));

/** Runs the batch-deploy-plus-governance-registration saga for the given token inputs. */
export async function deployTokensWithGovernanceRegistration(
  inputs: TokenDeployInput[],
): Promise<SagaResult<BatchDeployGovernanceContext>> {
  return sagaCoordinator.run(BATCH_DEPLOY_GOVERNANCE_SAGA_TYPE, { inputs });
}
