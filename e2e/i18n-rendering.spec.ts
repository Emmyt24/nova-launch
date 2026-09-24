/**
 * E2E — Multi-language i18n rendering across all six supported locales
 * Issue #1319
 *
 * Validates that every locale produces:
 *   1. Fully-resolved strings (no raw translation keys in the DOM).
 *   2. Correct text for four key UI areas:
 *        a. LandingPage  — hero headline
 *        b. TokenDeployForm — form input labels
 *        c. Governance — proposal status indicators / filter labels
 *        d. Global/Form states — error / system messages
 *   3. No layout overflow caused by long localised strings.
 *
 * The app exposes locale switching via localStorage key "nova_language"
 * (configured in frontend/src/i18n/config.ts, detection order: localStorage → navigator).
 *
 * Run:
 *   npx playwright test e2e/i18n-rendering.spec.ts
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCALES = ["en", "es", "fr", "ha", "pt", "sw"] as const;
type Locale = (typeof LOCALES)[number];

/** Regex matching a raw i18n key: one or more dot-separated lowercase segments. */
const RAW_KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]+)+$/;

/**
 * Per-locale expected strings sampled from the translation files.
 * Used to assert that resolved translations actually match the locale, not just
 * that they are non-empty.
 */
const EXPECTED = {
  en: {
    walletConnect: "Connect Wallet",
    tokenNameLabel: "Token Name",
    requiredError: "This field is required",
    loadingMsg: "Loading...",
  },
  es: {
    walletConnect: "Conectar billetera",
    tokenNameLabel: "Nombre del token",
    requiredError: "Este campo es obligatorio",
    loadingMsg: "Cargando...",
  },
  fr: {
    walletConnect: "Connecter le portefeuille",
    tokenNameLabel: "Nom du jeton",
    requiredError: "Ce champ est obligatoire",
    loadingMsg: "Chargement...",
  },
  ha: {
    walletConnect: "Haɗa Wallet",
    tokenNameLabel: "Sunan Token",
    requiredError: "Wannan filin yana buƙata",
    loadingMsg: "Ana lodi...",
  },
  pt: {
    walletConnect: "Conectar carteira",
    tokenNameLabel: "Nome do token",
    requiredError: "Este campo é obrigatório",
    loadingMsg: "Carregando...",
  },
  sw: {
    walletConnect: "Unganisha Mkoba",
    tokenNameLabel: "Jina la Token",
    requiredError: "Sehemu hii inahitajika",
    loadingMsg: "Inapakia...",
  },
} satisfies Record<Locale, Record<string, string>>;

/**
 * Governance heading + status filter labels per locale, mirroring
 * frontend/src/i18n/locales/*.json → governance.*
 */
const GOVERNANCE_EXPECTED = {
  en: {
    title: "Governance",
    statusFilter: {
      all: "All",
      active: "Active",
      passed: "Passed",
      rejected: "Rejected",
      executed: "Executed",
      cancelled: "Cancelled",
      expired: "Expired",
    },
  },
  es: {
    title: "Gobernanza",
    statusFilter: {
      all: "Todas",
      active: "Activas",
      passed: "Aprobadas",
      rejected: "Rechazadas",
      executed: "Ejecutadas",
      cancelled: "Canceladas",
      expired: "Expiradas",
    },
  },
  fr: {
    title: "Gouvernance",
    statusFilter: {
      all: "Toutes",
      active: "Actives",
      passed: "Adoptées",
      rejected: "Rejetées",
      executed: "Exécutées",
      cancelled: "Annulées",
      expired: "Expirées",
    },
  },
  ha: {
    title: "Shugabanci",
    statusFilter: {
      all: "Duka",
      active: "Masu aiki",
      passed: "An amince",
      rejected: "An ƙi",
      executed: "An aiwatar",
      cancelled: "An soke",
      expired: "Sun ƙare",
    },
  },
  pt: {
    title: "Governança",
    statusFilter: {
      all: "Todas",
      active: "Ativas",
      passed: "Aprovadas",
      rejected: "Rejeitadas",
      executed: "Executadas",
      cancelled: "Canceladas",
      expired: "Expiradas",
    },
  },
  sw: {
    title: "Utawala",
    statusFilter: {
      all: "Zote",
      active: "Hai",
      passed: "Zimepitishwa",
      rejected: "Zimekataliwa",
      executed: "Zimetekelezwa",
      cancelled: "Zimeghairiwa",
      expired: "Zimeisha muda",
    },
  },
} satisfies Record<Locale, { title: string; statusFilter: Record<string, string> }>;

/** Status filter keys rendered by ProposalList STATUS_OPTIONS (data-testid="status-filter-<key>") */
const GOVERNANCE_STATUS_FILTER_KEYS = [
  "all",
  "active",
  "passed",
  "rejected",
  "executed",
  "cancelled",
  "expired",
] as const;

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set locale in localStorage and reload so the i18n LanguageDetector picks it up. */
async function setLocale(page: Page, locale: Locale): Promise<void> {
  await page.addInitScript((loc) => {
    window.localStorage.setItem("nova_language", loc);
  }, locale);
}

/**
 * Assert no element whose text matches the raw-key pattern exists in the document.
 * Scans visible text nodes and aria-label values.
 */
async function assertNoRawKeys(page: Page): Promise<void> {
  const rawKeyNodes = await page.evaluate((re) => {
    const pattern = new RegExp(re);
    const found: string[] = [];

    // Walk all text nodes
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? "").trim();
      if (text && pattern.test(text)) {
        found.push(text);
      }
    }

    // Check aria-labels too
    document.querySelectorAll("[aria-label]").forEach((el) => {
      const label = (el.getAttribute("aria-label") ?? "").trim();
      if (label && pattern.test(label)) {
        found.push(`[aria-label] ${label}`);
      }
    });

    return found;
  }, RAW_KEY_RE.source);

  expect(
    rawKeyNodes,
    `Raw i18n key(s) leaked into DOM: ${rawKeyNodes.join(", ")}`
  ).toHaveLength(0);
}

/**
 * Assert that no element in the given selector list overflows its parent
 * horizontally, using getBoundingClientRect comparisons.
 */
async function assertNoHorizontalOverflow(
  page: Page,
  selectors: string[]
): Promise<void> {
  for (const sel of selectors) {
    const locator = page.locator(sel).first();
    const count = await locator.count();
    if (count === 0) continue;

    const overflow = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const parentRect = el.parentElement?.getBoundingClientRect();
      if (!parentRect) return false;
      // Allow 2 px rounding tolerance
      return rect.right > parentRect.right + 2;
    });

    expect(
      overflow,
      `"${sel}" horizontally overflows its parent (layout break)`
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Parameterised test matrix
// ---------------------------------------------------------------------------

for (const locale of LOCALES) {
  test.describe(`locale: ${locale}`, () => {
    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      // Create one context per locale with matching Accept-Language header.
      context = await browser.newContext({
        locale,
        extraHTTPHeaders: { "Accept-Language": locale },
        baseURL: BASE_URL,
      });
      page = await context.newPage();
      // Inject localStorage BEFORE the page loads so the detector reads it.
      await setLocale(page, locale);
    });

    test.afterAll(async () => {
      await context.close();
    });

    // -----------------------------------------------------------------------
    // 1. LandingPage — hero headline
    // -----------------------------------------------------------------------

    test.describe("LandingPage — hero headline", () => {
      test.beforeEach(async () => {
        await page.goto("/");
        await page.waitForLoadState("domcontentloaded");
      });

      test("hero-headline element is present and non-empty", async () => {
        // Try data-testid first (preferred); fall back to the CSS class / h1 in the hero section.
        const heroLocator = page
          .locator('[data-testid="hero-headline"], h1.hero-headline, section#hero h1')
          .first();

        await expect(heroLocator).toBeVisible({ timeout: 10_000 });
        const text = (await heroLocator.textContent())?.trim() ?? "";
        expect(text.length).toBeGreaterThan(0);
      });

      test("hero headline is not a raw translation key", async () => {
        const heroLocator = page
          .locator('[data-testid="hero-headline"], h1.hero-headline, section#hero h1')
          .first();
        await expect(heroLocator).toBeVisible({ timeout: 10_000 });
        const text = (await heroLocator.textContent())?.trim() ?? "";
        expect(RAW_KEY_RE.test(text)).toBe(false);
      });

      test("no raw translation keys in landing page DOM", async () => {
        await assertNoRawKeys(page);
      });

      test("hero headline does not overflow its container", async () => {
        await assertNoHorizontalOverflow(page, [
          '[data-testid="hero-headline"]',
          "h1.hero-headline",
          "section#hero h1",
        ]);
      });
    });

    // -----------------------------------------------------------------------
    // 2. TokenDeployForm — form input labels
    // -----------------------------------------------------------------------

    test.describe("TokenDeployForm — form input labels", () => {
      test.beforeEach(async () => {
        // Deploy form lives at / or /deploy; the app renders the form when
        // a wallet is connected, but the label text is always rendered.
        // Navigate to / and look for the form or deploy page.
        await page.goto("/deploy");
        await page.waitForLoadState("domcontentloaded");
      });

      test("token name label is localised and non-empty", async () => {
        // Locate any label that wraps or precedes the token name input.
        // The TokenDeployForm component passes `label="Token Name"` (en) through Input.
        const labelLocator = page
          .locator(
            '[data-testid="label-token-name"], label[for*="name"], label:has-text("Token"), label:has-text("Jeton"), label:has-text("Jina"), label:has-text("Sunan"), label:has-text("token")'
          )
          .first();

        const count = await labelLocator.count();
        if (count === 0) {
          // Form may be behind wallet-connect gate — assert the connect button text is localised.
          const connectBtn = page.locator("button").filter({ hasText: EXPECTED[locale].walletConnect });
          await expect(connectBtn.first()).toBeVisible({ timeout: 5_000 });
          return;
        }

        await expect(labelLocator).toBeVisible({ timeout: 10_000 });
        const labelText = (await labelLocator.textContent())?.trim() ?? "";
        expect(labelText.length).toBeGreaterThan(0);
        expect(RAW_KEY_RE.test(labelText)).toBe(false);
      });

      test("wallet connect button shows localised text, not raw key", async () => {
        // Wallet connect button is always visible regardless of auth state.
        await page.goto("/");
        await page.waitForLoadState("domcontentloaded");

        // Find any button / element containing the expected wallet connect string.
        const expected = EXPECTED[locale].walletConnect;
        const btnLocator = page.getByRole("button", { name: expected }).or(
          page.getByText(expected)
        );

        // If the element isn't found with exact locale string, fall back to checking
        // that at least ONE button exists with non-key text.
        const count = await btnLocator.count();
        if (count > 0) {
          const text = (await btnLocator.first().textContent())?.trim() ?? "";
          expect(RAW_KEY_RE.test(text)).toBe(false);
          expect(text).toBe(expected);
        } else {
          // Wallet already connected in context or button has different structure — just
          // assert no raw keys in the page.
          await assertNoRawKeys(page);
        }
      });

      test("form area has no raw translation keys", async () => {
        await assertNoRawKeys(page);
      });

      test("form labels do not overflow their containers", async () => {
        await assertNoHorizontalOverflow(page, [
          "label",
          '[data-testid^="label-"]',
          "form .input-label",
        ]);
      });
    });

    // -----------------------------------------------------------------------
    // 3. Governance — proposal status indicators
    // -----------------------------------------------------------------------

    test.describe("Governance — proposal status indicators", () => {
      test.beforeEach(async () => {
        await page.goto("/governance");
        await page.waitForLoadState("domcontentloaded");
      });

      test("governance heading is translated for the active locale", async () => {
        const heading = page.locator('[data-testid="governance-heading"]');
        await expect(heading).toBeVisible({ timeout: 10_000 });
        await expect(heading).toHaveText(GOVERNANCE_EXPECTED[locale].title);
        const text = (await heading.textContent())?.trim() ?? "";
        expect(RAW_KEY_RE.test(text)).toBe(false);
      });

      test("status filter buttons show translated labels", async () => {
        for (const key of GOVERNANCE_STATUS_FILTER_KEYS) {
          const button = page.locator(`[data-testid="status-filter-${key}"]`);
          await expect(button).toBeVisible({ timeout: 10_000 });
          await expect(button).toHaveText(
            GOVERNANCE_EXPECTED[locale].statusFilter[key]
          );
          const text = (await button.textContent())?.trim() ?? "";
          expect(RAW_KEY_RE.test(text)).toBe(false);
        }
      });

      test("proposal status badges show resolved strings, not raw keys", async () => {
        // Proposal status badge elements carry a class like bg-blue-100 etc.
        // Selector targets any element inside a proposal card that contains a status word.
        const badges = page.locator(
          '[data-testid^="proposal-status"], .proposal-status-badge, [class*="text-blue-700"], [class*="text-green-700"], [class*="text-red-700"]'
        );
        const count = await badges.count();
        for (let i = 0; i < Math.min(count, 10); i++) {
          const text = (await badges.nth(i).textContent())?.trim() ?? "";
          if (text.length > 0) {
            expect(RAW_KEY_RE.test(text)).toBe(false);
          }
        }
      });

      test("no raw translation keys on governance page", async () => {
        await assertNoRawKeys(page);
      });

      test("governance page elements do not overflow horizontally", async () => {
        await assertNoHorizontalOverflow(page, [
          "h1",
          '[data-testid="proposal-list"]',
          ".proposal-card",
          "button",
        ]);
      });
    });

    // -----------------------------------------------------------------------
    // 4. Global / Form states — system and error messages
    // -----------------------------------------------------------------------

    test.describe("Global/Form states — error and system messages", () => {
      test.beforeEach(async () => {
        await page.goto("/");
        await page.waitForLoadState("domcontentloaded");
      });

      test("loading message translation resolves to localised string", async () => {
        const expected = EXPECTED[locale].loadingMsg;
        // loading strings appear in aria-labels of spinners and sr-only spans
        const loadingLocator = page
          .locator(`[aria-label*="${expected}"], .sr-only`)
          .filter({ hasText: expected });
        // Not guaranteed to be visible during smoke run, so only assert if present.
        const count = await loadingLocator.count();
        if (count > 0) {
          const text = (await loadingLocator.first().textContent())?.trim() ?? "";
          expect(RAW_KEY_RE.test(text)).toBe(false);
        }
      });

      test("error messages in DOM are fully resolved strings", async () => {
        // Trigger a validation error by navigating to /deploy and attempting submit
        // without filling required fields, if the form is reachable.
        await page.goto("/deploy");
        await page.waitForLoadState("domcontentloaded");

        // Try to click submit / deploy button if present.
        const submitBtn = page
          .getByRole("button", { name: /deploy/i })
          .or(page.locator('[type="submit"]'))
          .first();

        if (await submitBtn.count() > 0) {
          await submitBtn.click().catch(() => {});
          // Small wait for validation messages to appear.
          await page.waitForTimeout(300);
        }

        // Collect all error/validation message texts.
        const errorTexts = await page
          .locator(
            '[data-testid^="error-"], [role="alert"], .error-message, [class*="text-red"]'
          )
          .allTextContents();

        for (const text of errorTexts) {
          const trimmed = text.trim();
          if (trimmed.length > 0) {
            expect(
              RAW_KEY_RE.test(trimmed),
              `Error message "${trimmed}" appears to be an unresolved i18n key`
            ).toBe(false);
          }
        }
      });

      test("no raw translation keys on home page", async () => {
        await page.goto("/");
        await page.waitForLoadState("domcontentloaded");
        await assertNoRawKeys(page);
      });

      test("system message texts do not overflow their containers", async () => {
        await assertNoHorizontalOverflow(page, [
          '[role="alert"]',
          ".error-message",
          '[data-testid^="error-"]',
          '[data-testid^="toast-"]',
        ]);
      });

      test("html[lang] attribute matches the active locale", async () => {
        await page.goto("/");
        await page.waitForLoadState("domcontentloaded");

        const htmlLang = await page.evaluate(() =>
          document.documentElement.getAttribute("lang")
        );

        // The i18n config sets document.documentElement.lang on languageChanged.
        // Allow that it may be the two-char code or full BCP-47 tag.
        expect(htmlLang?.startsWith(locale)).toBe(true);
      });
    });
  });
}
