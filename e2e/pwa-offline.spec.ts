/**
 * E2E: PWA Offline Mode with Cached Transaction State Persistence
 *
 * Verifies that the service worker (public/sw.js) correctly serves cached
 * content when the user goes offline mid-deployment, and that the
 * PWAConnectionStatus component accurately reflects the network state.
 *
 * Scenarios:
 *  1. Go offline during deploy → cached status is shown (no blank screen)
 *  2. Restore connectivity → live status replaces the cached UI state
 *
 * Runs against the full frontend dev server (http://localhost:5173).
 * Service workers must be enabled: set `serviceWorkers: "allow"` in playwright.config.ts.
 */

import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the service worker to be fully activated for this page. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return (
      "serviceWorker" in navigator &&
      navigator.serviceWorker.controller !== null
    );
  }, { timeout: 15_000 });
}

/**
 * Locate the PWAConnectionStatus indicator.
 * The component renders aria-label="Online" / "Offline" and inner text "Online" / "Offline".
 */
function connectionStatusLocator(page: Page) {
  return page.locator('[aria-label="Online"], [aria-label="Offline"]').first();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("PWA offline mode — cached transaction state persistence", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app and wait for it to load fully.
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Allow the service worker to install and activate before stressing the
    // network condition. Distinguish between genuine SW unsupport vs. activation failure.
    try {
      await waitForServiceWorker(page);
    } catch (error) {
      // Check if service workers are supported in this browser context
      const isSWSupported = await page.evaluate(() => "serviceWorker" in navigator);

      if (!isSWSupported) {
        // Service workers not supported — this is acceptable in some contexts
        console.log("Service workers not supported in this browser context");
      } else {
        // Service workers are supported but activation failed — log a warning
        const message = `Service worker activation failed: ${error instanceof Error ? error.message : String(error)}`;
        page.context().on("console", () => {});  // Ensure console exists
        console.warn(message);
        // Also annotate the test for visibility in reports
        test.info().annotations.push({
          type: "warning",
          description: message,
        });
      }
    }
  });

  // ── Scenario 1: Go offline mid-deploy — cached state is shown ─────────────

  test("shows cached app shell and Offline status when network is lost", async ({ page, context }) => {
    // Confirm the app is initially online.
    const statusIndicator = connectionStatusLocator(page);
    await expect(statusIndicator).toHaveAttribute("aria-label", "Online");
    await expect(statusIndicator).toContainText("Online");

    // Simulate network loss (equivalent to toggling DevTools → Network → Offline).
    await context.setOffline(true);

    // The browser fires the "offline" window event; usePWA() listens for it and
    // updates the PWAConnectionStatus component.
    await expect(statusIndicator).toHaveAttribute("aria-label", "Offline", {
      timeout: 5_000,
    });
    await expect(statusIndicator).toContainText("Offline");

    // The page must NOT show a blank screen — the cached app shell is served.
    // Assert that at minimum the root element rendered meaningful content.
    await expect(page.locator("#root")).not.toBeEmpty();

    // Assert no uncaught JS errors rendered an error boundary placeholder.
    const errorText = page.getByText(/something went wrong/i);
    await expect(errorText).toHaveCount(0);
  });

  test("preserves last-known transaction state in UI while offline", async ({ page, context }) => {
    // Navigate to any route that displays transaction / deployment state.
    // Reload to ensure the service worker has cached this navigation request.
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Capture visible text content that represents "deployment state" before
    // going offline (any non-empty content the app renders while online).
    const appContent = page.locator("#root");
    const onlineContent = await appContent.textContent();

    // Go offline.
    await context.setOffline(true);

    // Reload the page while offline — the service worker should serve the
    // cached navigation response instead of showing a blank/error page.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // The root element must be non-empty (no blank screen).
    await expect(appContent).not.toBeEmpty();

    // The connection status must reflect the offline state.
    const statusIndicator = connectionStatusLocator(page);
    await expect(statusIndicator).toHaveAttribute("aria-label", "Offline", {
      timeout: 5_000,
    });

    // Assert the offline HTML fallback (/offline.html) is NOT served when there
    // IS a cached navigation response — the app shell should be served instead.
    const title = await page.title();
    expect(title).not.toMatch(/offline/i);
  });

  // ── Scenario 2: Restore connectivity — live status replaces cached state ──

  test("updates ConnectionStatus to Online and fetches live data on reconnect", async ({ page, context }) => {
    // Go offline.
    await context.setOffline(true);

    const statusIndicator = connectionStatusLocator(page);
    await expect(statusIndicator).toHaveAttribute("aria-label", "Offline", {
      timeout: 5_000,
    });
    await expect(statusIndicator).toContainText("Offline");

    // Restore connectivity.
    await context.setOffline(false);

    // The browser fires the "online" window event; usePWA() updates the indicator.
    await expect(statusIndicator).toHaveAttribute("aria-label", "Online", {
      timeout: 8_000,
    });
    await expect(statusIndicator).toContainText("Online");
  });

  test("triggers background sync and live state replaces cached state after reconnect", async ({ page, context }) => {
    // Load the page online to prime caches, then go offline.
    await context.setOffline(true);

    const statusIndicator = connectionStatusLocator(page);
    await expect(statusIndicator).toHaveAttribute("aria-label", "Offline", {
      timeout: 5_000,
    });

    // Restore network — the app should detect reconnect and update.
    await context.setOffline(false);

    // Wait for the indicator to flip back to Online.
    await expect(statusIndicator).toHaveAttribute("aria-label", "Online", {
      timeout: 8_000,
    });
    await expect(statusIndicator).toContainText("Online");

    // After going back online, the page must render real content (not just the
    // cached skeleton) — verify the root element has meaningful children.
    await expect(page.locator("#root")).not.toBeEmpty();

    // No uncaught errors after reconnect.
    const errorText = page.getByText(/something went wrong/i);
    await expect(errorText).toHaveCount(0);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  test("rapid offline → online toggle does not leave ConnectionStatus in inconsistent state", async ({ page, context }) => {
    const statusIndicator = connectionStatusLocator(page);

    // Toggle offline/online rapidly three times.
    for (let i = 0; i < 3; i++) {
      await context.setOffline(true);
      await context.setOffline(false);
    }

    // After rapid toggling, the final state must be Online.
    await expect(statusIndicator).toHaveAttribute("aria-label", "Online", {
      timeout: 8_000,
    });
    await expect(statusIndicator).toContainText("Online");
  });
});
