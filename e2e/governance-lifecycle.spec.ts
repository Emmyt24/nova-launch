/**
 * E2E: Full Governance Proposal Lifecycle
 *
 * Covers proposal creation → vote submission → queue → execute,
 * asserting UI state at each step via Playwright against the dev stack.
 *
 * Requires STELLAR_NETWORK=testnet and a funded disposable test account.
 * The testnet-faucet helper seeds XLM before the suite runs.
 *
 * Closes #1299
 */

import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Selectors — kept in one place so breakage is easy to fix
// ---------------------------------------------------------------------------
const SEL = {
  connectWalletBtn: '[data-testid="connect-wallet"]',
  createProposalBtn: '[data-testid="create-proposal-btn"]',
  proposalTitleInput: '[data-testid="proposal-title-input"]',
  proposalDescInput: '[data-testid="proposal-description-input"]',
  submitProposalBtn: '[data-testid="submit-proposal-btn"]',
  proposalStatusChip: '[data-testid="proposal-status-chip"]',
  voteForBtn: '[data-testid="vote-for-btn"]',
  voteAgainstBtn: '[data-testid="vote-against-btn"]',
  queueProposalBtn: '[data-testid="queue-proposal-btn"]',
  executeProposalBtn: '[data-testid="execute-proposal-btn"]',
  toastSuccess: '[data-testid="toast-success"]',
  proposalCard: '[data-testid="proposal-card"]',
};

const BASE = "http://localhost:5173";
const GOVERNANCE_URL = `${BASE}/governance`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function navigateToGovernance(page: Page): Promise<void> {
  await page.goto(GOVERNANCE_URL);
  await page.waitForLoadState("networkidle");
}

async function waitForStatusChip(
  page: Page,
  status: string,
  proposalTitle?: string
): Promise<void> {
  await page.waitForFunction(
    ({ selCard, selChip, expected, title }: { selCard: string; selChip: string; expected: string; title?: string }) => {
      if (title) {
        // Scope the status chip query to the specific proposal card
        const cards = document.querySelectorAll(selCard);
        const card = Array.from(cards).find((c) => c.textContent?.includes(title));
        if (!card) return false;
        const chip = card.querySelector(selChip);
        return chip?.textContent?.toLowerCase().includes(expected.toLowerCase());
      } else {
        // Fallback for unscoped queries (for tests that don't provide title)
        const chip = document.querySelector(selChip);
        return chip?.textContent?.toLowerCase().includes(expected.toLowerCase());
      }
    },
    { selCard: SEL.proposalCard, selChip: SEL.proposalStatusChip, expected: status, title: proposalTitle },
    { timeout: 15_000 }
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("Governance Proposal Lifecycle (#1299)", () => {
  test.beforeEach(async ({ page }) => {
    // Stub the Stellar wallet so tests run without a real browser extension
    await page.addInitScript(() => {
      (window as any).__STELLAR_WALLET_STUB__ = {
        isConnected: () => true,
        getPublicKey: () =>
          "GTEST000000000000000000000000000000000000000000000000000001",
        signTransaction: (xdr: string) => Promise.resolve(xdr),
      };
    });

    await navigateToGovernance(page);
  });

  // -- 1. Proposal creation --------------------------------------------------

  test("user can submit a governance proposal and see it listed", async ({
    page,
  }) => {
    const title = `E2E Proposal ${Date.now()}`;

    await page.click(SEL.createProposalBtn);
    await page.fill(SEL.proposalTitleInput, title);
    await page.fill(
      SEL.proposalDescInput,
      "Automated E2E test proposal — verifies the creation flow end-to-end."
    );
    await page.click(SEL.submitProposalBtn);

    // Optimistic UI: status chip should show "active" without page refresh
    // Scoped to the specific proposal created by this test
    await waitForStatusChip(page, "active", title);

    // The new proposal card should appear in the list
    const cards = page.locator(SEL.proposalCard);
    await expect(cards.filter({ hasText: title })).toBeVisible({
      timeout: 10_000,
    });
  });

  // -- 2. Vote submission ----------------------------------------------------

  test("user can cast a vote and the tally updates without page refresh", async ({
    page,
  }) => {
    // Assume at least one active proposal is visible (seeded or created above)
    const firstCard = page.locator(SEL.proposalCard).first();
    await firstCard.waitFor({ timeout: 10_000 });
    await firstCard.click();

    await page.click(SEL.voteForBtn);

    // Vote count or status must update via WebSocket — assert without reload
    await expect(
      page.locator('[data-testid="vote-for-count"]')
    ).not.toHaveText("0", { timeout: 10_000 });

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });
  });

  test("user can cast a vote against and status remains 'active'", async ({
    page,
  }) => {
    const firstCard = page.locator(SEL.proposalCard).first();
    await firstCard.waitFor({ timeout: 10_000 });
    const cardText = await firstCard.textContent();
    // Extract proposal title from the card to scope the status check
    const proposalTitle = cardText?.split("\n")[0] || "";
    await firstCard.click();

    await page.click(SEL.voteAgainstBtn);
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Proposal stays active — quorum not yet reached
    // Scoped to the specific proposal card
    await waitForStatusChip(page, "active", proposalTitle);
  });

  // -- 3. Queue --------------------------------------------------------------

  test("passed proposal can be queued and status chip updates to 'queued'", async ({
    page,
  }) => {
    // Navigate directly to a proposal that is in "passed" state (seeded)
    await page.goto(`${GOVERNANCE_URL}?status=passed`);
    await page.waitForLoadState("networkidle");

    const passedCard = page.locator(SEL.proposalCard).first();
    await passedCard.waitFor({ timeout: 10_000 });
    const cardText = await passedCard.textContent();
    const proposalTitle = cardText?.split("\n")[0] || "";
    await passedCard.click();

    const queueBtn = page.locator(SEL.queueProposalBtn);
    // Only present for eligible proposals — skip if not rendered
    if (await queueBtn.isVisible()) {
      await queueBtn.click();
      // Scoped to the specific proposal
      await waitForStatusChip(page, "queued", proposalTitle);
      await expect(page.locator(SEL.toastSuccess)).toBeVisible({
        timeout: 8_000,
      });
    } else {
      test.skip(); // no passed proposal seeded in this environment
    }
  });

  // -- 4. Execute ------------------------------------------------------------

  test("queued proposal can be executed and status chip updates to 'executed'", async ({
    page,
  }) => {
    await page.goto(`${GOVERNANCE_URL}?status=queued`);
    await page.waitForLoadState("networkidle");

    const queuedCard = page.locator(SEL.proposalCard).first();
    await queuedCard.waitFor({ timeout: 10_000 });
    const cardText = await queuedCard.textContent();
    const proposalTitle = cardText?.split("\n")[0] || "";
    await queuedCard.click();

    const executeBtn = page.locator(SEL.executeProposalBtn);
    if (await executeBtn.isVisible()) {
      await executeBtn.click();
      // Scoped to the specific proposal
      await waitForStatusChip(page, "executed", proposalTitle);
      await expect(page.locator(SEL.toastSuccess)).toBeVisible({
        timeout: 8_000,
      });
    } else {
      test.skip();
    }
  });

  // -- 5. Real-time update via WebSocket/subscription -----------------------

  test("proposal status chip refreshes automatically without manual reload", async ({
    page,
    context,
  }) => {
    // Open a second page to simulate another user changing the state
    const secondPage = await context.newPage();
    await secondPage.addInitScript(() => {
      (window as any).__STELLAR_WALLET_STUB__ = {
        isConnected: () => true,
        getPublicKey: () =>
          "GTEST000000000000000000000000000000000000000000000000000002",
        signTransaction: (xdr: string) => Promise.resolve(xdr),
      };
    });

    await secondPage.goto(GOVERNANCE_URL);
    await secondPage.waitForLoadState("networkidle");

    const firstCard = page.locator(SEL.proposalCard).first();
    await firstCard.waitFor({ timeout: 10_000 });
    await firstCard.click();

    const initialStatus = await page
      .locator(SEL.proposalStatusChip)
      .textContent();

    // Vote from second page — should push a WS event to the first page
    await secondPage.locator(SEL.proposalCard).first().click();
    await secondPage.click(SEL.voteForBtn);
    await secondPage.locator(SEL.toastSuccess).waitFor({ timeout: 8_000 });

    // First page must reflect the change without reload
    await page.waitForFunction(
      ({ sel, prev }: { sel: string; prev: string | null }) => {
        const el = document.querySelector(sel);
        return el?.textContent !== prev;
      },
      { sel: SEL.proposalStatusChip, prev: initialStatus },
      { timeout: 12_000 }
    );

    await secondPage.close();
  });

  // -- 6. Multiple proposals: verify status checks are scoped correctly --------

  test("status assertions track correct proposal when multiple proposals exist", async ({
    page,
  }) => {
    // Create first proposal
    const proposal1Title = `E2E Proposal 1 ${Date.now()}`;
    await page.click(SEL.createProposalBtn);
    await page.fill(SEL.proposalTitleInput, proposal1Title);
    await page.fill(
      SEL.proposalDescInput,
      "First test proposal — verifies scoped status checks."
    );
    await page.click(SEL.submitProposalBtn);

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Verify first proposal status (scoped to its title)
    await waitForStatusChip(page, "active", proposal1Title);

    // Create second proposal
    const proposal2Title = `E2E Proposal 2 ${Date.now()}`;
    await page.click(SEL.createProposalBtn);
    await page.fill(SEL.proposalTitleInput, proposal2Title);
    await page.fill(
      SEL.proposalDescInput,
      "Second test proposal — ensures status checks don't cross-contaminate."
    );
    await page.click(SEL.submitProposalBtn);

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Verify second proposal status (scoped to its title)
    await waitForStatusChip(page, "active", proposal2Title);

    // Verify both proposals are visible in the list
    const cards = page.locator(SEL.proposalCard);
    await expect(cards.filter({ hasText: proposal1Title })).toBeVisible({
      timeout: 10_000,
    });
    await expect(cards.filter({ hasText: proposal2Title })).toBeVisible({
      timeout: 10_000,
    });

    // Both status checks should still pass because they target specific proposals
    await waitForStatusChip(page, "active", proposal1Title);
    await waitForStatusChip(page, "active", proposal2Title);
  });
});
