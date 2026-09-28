import { describe, expect, it } from "vitest";
import {
  compatibilityEnums,
  compatibilitySeedData,
  createCompatibilityHarness,
} from "./utils/seedIntegration";

const { ProposalStatus } = compatibilityEnums;

/**
 * Statuses that e2e/governance-lifecycle.spec.ts depends on being seeded.
 * If any of these go missing, the queue/execute e2e paths lose real data.
 */
const E2E_REQUIRED_STATUSES = [
  ProposalStatus.ACTIVE,
  ProposalStatus.PASSED,
  ProposalStatus.QUEUED,
  ProposalStatus.EXECUTED,
];

describe("seedIntegration governance lifecycle coverage", () => {
  it("seeds at least one proposal for every status the e2e suite exercises", async () => {
    const { prisma } = createCompatibilityHarness("legacy-populated");

    for (const status of E2E_REQUIRED_STATUSES) {
      const rows = await prisma.proposal.findMany({ where: { status } });
      expect(rows.length, `expected a seeded ${status} proposal`).toBeGreaterThan(0);
    }
  });

  it("seeds the queued proposal without an execution timestamp", async () => {
    const { prisma } = createCompatibilityHarness("legacy-populated");
    const [queued] = await prisma.proposal.findMany({
      where: { status: ProposalStatus.QUEUED },
    });

    expect(queued.executedAt).toBeNull();
  });

  it("seeds the executed proposal with a matching execution record", async () => {
    const { prisma } = createCompatibilityHarness("legacy-populated");
    const executed = compatibilitySeedData.legacy.lifecycleProposals.find(
      (proposal) => proposal.status === ProposalStatus.EXECUTED
    )!;

    const row = await prisma.proposal.findUnique({
      where: { proposalId: executed.proposalId },
      include: { executions: true },
    });

    expect(row?.executedAt).toEqual(executed.executedAt);
    expect(row?.executions).toHaveLength(1);
    expect(row?.executions[0].success).toBe(true);
  });

  it("uses unique proposal ids across all seeded proposals", () => {
    const ids = [
      compatibilitySeedData.legacy.proposal.proposalId,
      ...compatibilitySeedData.legacy.lifecycleProposals.map((p) => p.proposalId),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not seed lifecycle proposals in empty mode", async () => {
    const { prisma } = createCompatibilityHarness("empty");
    expect(await prisma.proposal.findMany()).toHaveLength(0);
  });
});
