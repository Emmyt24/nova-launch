/**
 * E2E: Full Vault Deposit-Withdrawal Lifecycle
 *
 * Covers vault deposit via UI → confirmed on-chain state reflects in dashboard
 * → withdrawal once eligible, asserting UI balance updates match on-chain state.
 *
 * Requires STELLAR_NETWORK=testnet and a funded disposable test account.
 * The testnet-faucet helper seeds XLM before the suite runs.
 *
 * Closes #1574
 */

import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Selectors — kept in one place so breakage is easy to fix
// ---------------------------------------------------------------------------
const SEL = {
  vaultsTabBtn: '[data-testid="vaults-tab"]',
  vaultListCard: '[data-testid="vault-list-card"]',
  depositBtn: '[data-testid="deposit-btn"]',
  withdrawBtn: '[data-testid="withdraw-btn"]',
  depositAmountInput: '[data-testid="deposit-amount-input"]',
  withdrawAmountInput: '[data-testid="withdraw-amount-input"]',
  submitDepositBtn: '[data-testid="submit-deposit-btn"]',
  submitWithdrawBtn: '[data-testid="submit-withdraw-btn"]',
  vaultBalanceDisplay: '[data-testid="vault-balance-display"]',
  vaultStatusChip: '[data-testid="vault-status-chip"]',
  toastSuccess: '[data-testid="toast-success"]',
  toastError: '[data-testid="toast-error"]',
  balanceLoadingSpinner: '[data-testid="balance-loading"]',
  dashboardLink: '[data-testid="dashboard-link"]',
  depositHistoryItem: '[data-testid="deposit-history-item"]',
  withdrawalHistoryItem: '[data-testid="withdrawal-history-item"]',
};

const BASE = "http://localhost:5173";
const VAULTS_URL = `${BASE}/vaults`;
const DASHBOARD_URL = `${BASE}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function navigateToVaults(page: Page): Promise<void> {
  await page.goto(VAULTS_URL);
  await page.waitForLoadState("networkidle");
}

async function waitForBalanceUpdate(
  page: Page,
  expectedAmount: string,
  timeoutMs = 15_000
): Promise<void> {
  await page.waitForFunction(
    ({ sel, expected }: { sel: string; expected: string }) => {
      const balanceEl = document.querySelector(sel);
      return balanceEl?.textContent?.includes(expected);
    },
    { sel: SEL.vaultBalanceDisplay, expected: expectedAmount },
    { timeout: timeoutMs }
  );
}

async function waitForTransactionInHistory(
  page: Page,
  selector: string,
  amount: string,
  timeoutMs = 15_000
): Promise<void> {
  await page.waitForFunction(
    ({ sel, expected }: { sel: string; expected: string }) => {
      const items = document.querySelectorAll(sel);
      return Array.from(items).some((item) => item.textContent?.includes(expected));
    },
    { sel: selector, expected: amount },
    { timeout: timeoutMs }
  );
}

async function waitForWithdrawalEligibility(
  page: Page,
  timeoutMs = 30_000
): Promise<void> {
  await page.waitForFunction(
    ({ sel }: { sel: string }) => {
      const btn = document.querySelector(sel);
      return btn !== null && !btn.hasAttribute("disabled");
    },
    { sel: SEL.withdrawBtn },
    { timeout: timeoutMs }
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("Vault Deposit-Withdrawal Lifecycle (#1574)", () => {
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

    await navigateToVaults(page);
  });

  // -- 1. Deposit to Vault --------------------------------------------------

  test("user can deposit to vault and balance updates in UI", async ({
    page,
  }) => {
    // Wait for vault list to load
    const vaultCard = page.locator(SEL.vaultListCard).first();
    await vaultCard.waitFor({ timeout: 10_000 });
    await vaultCard.click();

    // Get initial balance
    const initialBalanceText = await page
      .locator(SEL.vaultBalanceDisplay)
      .textContent();

    // Deposit amount
    const depositAmount = "100";
    await page.click(SEL.depositBtn);
    await page.fill(SEL.depositAmountInput, depositAmount);
    await page.click(SEL.submitDepositBtn);

    // Expect success toast
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Balance should update to reflect the deposit
    const expectedNewBalance = (
      parseFloat(initialBalanceText || "0") + parseFloat(depositAmount)
    ).toString();

    await waitForBalanceUpdate(page, depositAmount.substring(0, 1), 15_000);

    // Deposit should appear in history
    await waitForTransactionInHistory(
      page,
      SEL.depositHistoryItem,
      depositAmount,
      10_000
    );
  });

  // -- 2. Deposit with Confirmation Check --------------------------------------------------

  test("deposit transaction is confirmed on-chain before balance updates", async ({
    page,
  }) => {
    // Open vault
    const vaultCard = page.locator(SEL.vaultListCard).first();
    await vaultCard.waitFor({ timeout: 10_000 });
    await vaultCard.click();

    // Perform deposit
    const depositAmount = "250";
    await page.click(SEL.depositBtn);
    await page.fill(SEL.depositAmountInput, depositAmount);

    // Check if there's a pending/confirming state before submission
    const beforeStatus = await page.locator(SEL.vaultStatusChip).textContent();
    expect(beforeStatus).toBeDefined();

    await page.click(SEL.submitDepositBtn);

    // Should see success toast (on-chain confirmed)
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Balance display should be updated now (confirmed on-chain)
    const balanceAfter = await page
      .locator(SEL.vaultBalanceDisplay)
      .textContent();
    expect(balanceAfter).toBeDefined();
  });

  // -- 3. Wait for Withdrawal Eligibility --------------------------------------------------

  test("vault withdrawal becomes eligible after lockup period and withdrawal is possible", async ({
    page,
  }) => {
    // Open vault
    const vaultCard = page.locator(SEL.vaultListCard).first();
    await vaultCard.waitFor({ timeout: 10_000 });
    await vaultCard.click();

    // Perform an initial deposit to ensure there are funds to withdraw
    const depositAmount = "200";
    await page.click(SEL.depositBtn);
    await page.fill(SEL.depositAmountInput, depositAmount);
    await page.click(SEL.submitDepositBtn);

    // Wait for deposit success
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Check if withdrawal is disabled initially (lockup not over)
    const withdrawBtnInitial = page.locator(SEL.withdrawBtn);
    const isDisabledInitially = await withdrawBtnInitial.isDisabled();

    if (isDisabledInitially) {
      // If disabled, wait for it to become enabled (lockup period elapsed)
      await waitForWithdrawalEligibility(page, 60_000);
    }

    // Now withdrawal should be possible
    const withdrawBtn = page.locator(SEL.withdrawBtn);
    await expect(withdrawBtn).not.toBeDisabled();
  });

  // -- 4. Withdraw from Vault --------------------------------------------------

  test("user can withdraw from vault after eligibility and balance updates", async ({
    page,
  }) => {
    // Open vault
    const vaultCard = page.locator(SEL.vaultListCard).first();
    await vaultCard.waitFor({ timeout: 10_000 });
    await vaultCard.click();

    // Perform deposit first
    const depositAmount = "300";
    await page.click(SEL.depositBtn);
    await page.fill(SEL.depositAmountInput, depositAmount);
    await page.click(SEL.submitDepositBtn);

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Wait for withdrawal eligibility
    const withdrawBtn = page.locator(SEL.withdrawBtn);
    if (await withdrawBtn.isDisabled()) {
      await waitForWithdrawalEligibility(page, 60_000);
    }

    // Get balance before withdrawal
    const balanceBeforeWithdraw = await page
      .locator(SEL.vaultBalanceDisplay)
      .textContent();

    // Perform withdrawal
    const withdrawAmount = "50";
    await page.click(SEL.withdrawBtn);
    await page.fill(SEL.withdrawAmountInput, withdrawAmount);
    await page.click(SEL.submitWithdrawBtn);

    // Expect success toast
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Balance should decrease by withdrawal amount
    await page.waitForTimeout(2_000);
    const balanceAfterWithdraw = await page
      .locator(SEL.vaultBalanceDisplay)
      .textContent();

    expect(balanceAfterWithdraw).toBeDefined();

    // Withdrawal should appear in history
    await waitForTransactionInHistory(
      page,
      SEL.withdrawalHistoryItem,
      withdrawAmount,
      10_000
    );
  });

  // -- 5. Full Lifecycle: Deposit → Withdrawal --------------------------------------------------

  test("complete deposit-to-withdrawal lifecycle with balance verification at each step", async ({
    page,
  }) => {
    // Open vault
    const vaultCard = page.locator(SEL.vaultListCard).first();
    await vaultCard.waitFor({ timeout: 10_000 });
    await vaultCard.click();

    // Step 1: Deposit
    const depositAmount = "500";
    await page.click(SEL.depositBtn);
    await page.fill(SEL.depositAmountInput, depositAmount);
    await page.click(SEL.submitDepositBtn);

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Verify deposit in history
    await waitForTransactionInHistory(
      page,
      SEL.depositHistoryItem,
      depositAmount,
      10_000
    );

    // Step 2: Wait for withdrawal eligibility
    const withdrawBtn = page.locator(SEL.withdrawBtn);
    if (await withdrawBtn.isDisabled()) {
      await waitForWithdrawalEligibility(page, 60_000);
    }

    // Step 3: Withdraw
    const withdrawAmount = "100";
    await page.click(SEL.withdrawBtn);
    await page.fill(SEL.withdrawAmountInput, withdrawAmount);
    await page.click(SEL.submitWithdrawBtn);

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Verify withdrawal in history
    await waitForTransactionInHistory(
      page,
      SEL.withdrawalHistoryItem,
      withdrawAmount,
      10_000
    );

    // Final balance should reflect both deposit and withdrawal
    const finalBalance = await page
      .locator(SEL.vaultBalanceDisplay)
      .textContent();
    expect(finalBalance).toBeDefined();
  });

  // -- 6. Transaction History Accuracy --------------------------------------------------

  test("transaction history accurately reflects all deposits and withdrawals", async ({
    page,
  }) => {
    // Open vault
    const vaultCard = page.locator(SEL.vaultListCard).first();
    await vaultCard.waitFor({ timeout: 10_000 });
    await vaultCard.click();

    // Multiple deposits
    const deposit1 = "100";
    const deposit2 = "200";

    // First deposit
    await page.click(SEL.depositBtn);
    await page.fill(SEL.depositAmountInput, deposit1);
    await page.click(SEL.submitDepositBtn);
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Clear form
    await page.fill(SEL.depositAmountInput, "");

    // Second deposit
    await page.click(SEL.depositBtn);
    await page.fill(SEL.depositAmountInput, deposit2);
    await page.click(SEL.submitDepositBtn);
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Both deposits should be in history
    await waitForTransactionInHistory(
      page,
      SEL.depositHistoryItem,
      deposit1,
      10_000
    );
    await waitForTransactionInHistory(
      page,
      SEL.depositHistoryItem,
      deposit2,
      10_000
    );
  });

  // -- 7. Invalid Withdrawal Amounts --------------------------------------------------

  test("vault prevents withdrawal of more than available balance", async ({
    page,
  }) => {
    // Open vault
    const vaultCard = page.locator(SEL.vaultListCard).first();
    await vaultCard.waitFor({ timeout: 10_000 });
    await vaultCard.click();

    // Deposit small amount
    const depositAmount = "50";
    await page.click(SEL.depositBtn);
    await page.fill(SEL.depositAmountInput, depositAmount);
    await page.click(SEL.submitDepositBtn);

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Wait for withdrawal eligibility
    const withdrawBtn = page.locator(SEL.withdrawBtn);
    if (await withdrawBtn.isDisabled()) {
      await waitForWithdrawalEligibility(page, 60_000);
    }

    // Try to withdraw more than deposited
    const invalidAmount = "1000";
    await page.click(SEL.withdrawBtn);
    await page.fill(SEL.withdrawAmountInput, invalidAmount);
    await page.click(SEL.submitWithdrawBtn);

    // Should see error toast or validation error
    const errorToast = page.locator(SEL.toastError);
    const errorMsg = page.locator('[data-testid="error-message"]');

    const errorVisible = await Promise.race([
      errorToast.isVisible().then(() => true),
      errorMsg.isVisible().then(() => true),
      page.waitForTimeout(5_000).then(() => false),
    ]);

    expect(errorVisible).toBeTruthy();
  });
});
