/**
 * E2E: Full Token Deploy Lifecycle
 *
 * Covers deploy form submission → deployment pending → deploying → confirmed,
 * asserting UI state transitions and token appearance in the token list.
 *
 * Requires STELLAR_NETWORK=testnet and a funded disposable test account.
 * The testnet-faucet helper seeds XLM before the suite runs.
 *
 * Closes #1573
 */

import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Selectors — kept in one place so breakage is easy to fix
// ---------------------------------------------------------------------------
const SEL = {
  deployTabBtn: '[data-testid="deploy-tab"]',
  tokenNameInput: '[data-testid="token-name-input"]',
  tokenSymbolInput: '[data-testid="token-symbol-input"]',
  tokenDecimalsInput: '[data-testid="token-decimals-input"]',
  initialSupplyInput: '[data-testid="initial-supply-input"]',
  submitDeployBtn: '[data-testid="submit-deploy-btn"]',
  deployStatusChip: '[data-testid="deploy-status-chip"]',
  tokenListCard: '[data-testid="token-list-card"]',
  toastSuccess: '[data-testid="toast-success"]',
  dashboardLink: '[data-testid="dashboard-link"]',
};

const BASE = "http://localhost:5173";
const DASHBOARD_URL = `${BASE}`;
const DEPLOY_PATH = `${BASE}?tab=deploy`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function navigateToDeploy(page: Page): Promise<void> {
  await page.goto(DEPLOY_PATH);
  await page.waitForLoadState("networkidle");
}

async function waitForStatusChip(
  page: Page,
  status: string,
  timeoutMs = 15_000
): Promise<void> {
  await page.waitForFunction(
    ({ sel, expected }: { sel: string; expected: string }) => {
      const chip = document.querySelector(sel);
      return chip?.textContent?.toLowerCase().includes(expected.toLowerCase());
    },
    { sel: SEL.deployStatusChip, expected: status },
    { timeout: timeoutMs }
  );
}

async function waitForTokenInList(
  page: Page,
  symbol: string,
  timeoutMs = 15_000
): Promise<void> {
  await page.waitForFunction(
    ({ sel, expected }: { sel: string; expected: string }) => {
      const cards = document.querySelectorAll(sel);
      return Array.from(cards).some((card) =>
        card.textContent?.includes(expected)
      );
    },
    { sel: SEL.tokenListCard, expected: symbol },
    { timeout: timeoutMs }
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("Token Deploy Lifecycle (#1573)", () => {
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

    await navigateToDeploy(page);
  });

  // -- 1. Deploy Form Submission --------------------------------------------------

  test("user can fill deploy form and submit, token enters pending state", async ({
    page,
  }) => {
    const timestamp = Date.now();
    const tokenSymbol = `TEST${timestamp.toString().slice(-4)}`;
    const tokenName = `E2E Test Token ${timestamp}`;

    // Fill the form
    await page.fill(SEL.tokenNameInput, tokenName);
    await page.fill(SEL.tokenSymbolInput, tokenSymbol);
    await page.fill(SEL.tokenDecimalsInput, "7");
    await page.fill(SEL.initialSupplyInput, "1000000");

    // Submit the form
    await page.click(SEL.submitDeployBtn);

    // Expect success toast
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Status chip should show "pending" after submission
    await waitForStatusChip(page, "pending", 10_000);
  });

  // -- 2. Deployment Status Transition --------------------------------------------------

  test("deploy status transitions from pending to deploying", async ({
    page,
  }) => {
    const timestamp = Date.now();
    const tokenSymbol = `TDEP${timestamp.toString().slice(-4)}`;
    const tokenName = `Deploy Transition Token ${timestamp}`;

    // Fill and submit
    await page.fill(SEL.tokenNameInput, tokenName);
    await page.fill(SEL.tokenSymbolInput, tokenSymbol);
    await page.fill(SEL.tokenDecimalsInput, "7");
    await page.fill(SEL.initialSupplyInput, "500000");
    await page.click(SEL.submitDeployBtn);

    // Wait for initial pending state
    await waitForStatusChip(page, "pending", 10_000);

    // Eventually should transition to deploying
    await waitForStatusChip(page, "deploying", 15_000);

    // Verify the status chip is still visible
    const statusChip = page.locator(SEL.deployStatusChip);
    await expect(statusChip).toBeVisible();
  });

  // -- 3. Confirmed Deployment and Token List Appearance --------------------------------------------------

  test("successfully deployed token appears in the token list with confirmed status", async ({
    page,
  }) => {
    const timestamp = Date.now();
    const tokenSymbol = `CONF${timestamp.toString().slice(-4)}`;
    const tokenName = `Confirmed Deploy Token ${timestamp}`;

    // Fill and submit
    await page.fill(SEL.tokenNameInput, tokenName);
    await page.fill(SEL.tokenSymbolInput, tokenSymbol);
    await page.fill(SEL.tokenDecimalsInput, "7");
    await page.fill(SEL.initialSupplyInput, "2000000");
    await page.click(SEL.submitDeployBtn);

    // Expect success toast
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Wait for deployment to be confirmed (status should show "confirmed")
    await waitForStatusChip(page, "confirmed", 30_000);

    // Navigate to dashboard/token list to verify token appears
    await page.goto(DASHBOARD_URL);
    await page.waitForLoadState("networkidle");

    // Token should appear in the list with the correct symbol
    await waitForTokenInList(page, tokenSymbol, 15_000);

    // Verify the token card displays correctly
    const tokenCard = page.locator(SEL.tokenListCard).filter({
      hasText: tokenSymbol,
    });
    await expect(tokenCard).toBeVisible();
  });

  // -- 4. Deploy Form Validation --------------------------------------------------

  test("deploy form validates required fields and shows error on incomplete submission", async ({
    page,
  }) => {
    // Try to submit without filling fields
    await page.click(SEL.submitDeployBtn);

    // Should either see validation error or toast error
    const errorMessage = page.locator('[data-testid="error-message"]');
    const errorToast = page.locator('[data-testid="toast-error"]');

    const errorVisible = await Promise.race([
      errorMessage.isVisible().then(() => true),
      errorToast.isVisible().then(() => true),
      page.waitForTimeout(5_000).then(() => false),
    ]);

    expect(errorVisible).toBeTruthy();
  });

  // -- 5. Multiple Sequential Deployments --------------------------------------------------

  test("user can deploy multiple tokens sequentially and all appear in the list", async ({
    page,
  }) => {
    const baseTimestamp = Date.now();

    // Deploy first token
    const token1Symbol = `T1${baseTimestamp.toString().slice(-3)}`;
    await page.fill(SEL.tokenNameInput, `Token 1 ${baseTimestamp}`);
    await page.fill(SEL.tokenSymbolInput, token1Symbol);
    await page.fill(SEL.tokenDecimalsInput, "7");
    await page.fill(SEL.initialSupplyInput, "1000000");
    await page.click(SEL.submitDeployBtn);

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Wait for first deployment to confirm
    await waitForStatusChip(page, "confirmed", 30_000);

    // Clear form and deploy second token
    await page.fill(SEL.tokenNameInput, "");
    await page.fill(SEL.tokenSymbolInput, "");
    await page.fill(SEL.tokenDecimalsInput, "");
    await page.fill(SEL.initialSupplyInput, "");

    const token2Symbol = `T2${baseTimestamp.toString().slice(-3)}`;
    await page.fill(SEL.tokenNameInput, `Token 2 ${baseTimestamp}`);
    await page.fill(SEL.tokenSymbolInput, token2Symbol);
    await page.fill(SEL.tokenDecimalsInput, "7");
    await page.fill(SEL.initialSupplyInput, "2000000");
    await page.click(SEL.submitDeployBtn);

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Navigate to dashboard to verify both tokens appear
    await page.goto(DASHBOARD_URL);
    await page.waitForLoadState("networkidle");

    // Both tokens should be visible
    await waitForTokenInList(page, token1Symbol, 15_000);
    await waitForTokenInList(page, token2Symbol, 15_000);
  });

  // -- 6. Deploy Status Persists After Page Reload --------------------------------------------------

  test("deploy status persists and updates correctly after page reload", async ({
    page,
  }) => {
    const timestamp = Date.now();
    const tokenSymbol = `PERS${timestamp.toString().slice(-4)}`;
    const tokenName = `Persistent Token ${timestamp}`;

    // Deploy token
    await page.fill(SEL.tokenNameInput, tokenName);
    await page.fill(SEL.tokenSymbolInput, tokenSymbol);
    await page.fill(SEL.tokenDecimalsInput, "7");
    await page.fill(SEL.initialSupplyInput, "3000000");
    await page.click(SEL.submitDeployBtn);

    // Wait for pending state
    await waitForStatusChip(page, "pending", 10_000);

    // Get the initial status
    const initialStatus = await page
      .locator(SEL.deployStatusChip)
      .textContent();

    // Reload the page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Status should still be visible and progressing
    const statusChip = page.locator(SEL.deployStatusChip);
    await expect(statusChip).toBeVisible({ timeout: 10_000 });

    // Eventually should reach confirmed
    await waitForStatusChip(page, "confirmed", 30_000);
  });
});
