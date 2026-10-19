import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useNetwork } from "./hooks/useNetwork";
import { useWallet } from "./hooks/useWallet";
import { ErrorBoundary, ThemeToggle } from "./components/UI";
import { PageLoader } from "./components/UI/PageLoader";
import { DashboardLayout } from "./components/Layout";
import { PWAOfflineBanner, PWAUpdateNotification } from "./components/PWA";
import { ResourceCostConfirmDialog } from "./components/ResourceCost";
import { IntegrationVersionBanner } from "./components/IntegrationVersionBanner";
import type { CompatibilityInfo } from "./components/IntegrationVersionBanner";
import { LanguageSelector } from "./components/LanguageSelector";

// Lazy load pages
const LandingPage = lazy(() => import("./pages/LandingPage"));
const NotFoundRoute = lazy(() => import("./routes/NotFoundRoute"));
const RecurringPayments = lazy(() => import("./app/dashboard/RecurringPayments"));
const CampaignDashboard = lazy(() => import("./app/dashboard/CampaignDashboard"));
const GovernancePage = lazy(() => import("./pages/GovernancePage"));
const StreamDashboard = lazy(() => import("./components/Streams/StreamDashboard"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
// Analytics pulls in recharts; keep it (and the chart chunk) off the initial load.
const TokenAnalyticsPage = lazy(() => import("./pages/TokenAnalyticsPage"));
// Dev-only tooling: never part of the production entry chunk.
const PerformanceDashboard = import.meta.env.DEV
  ? lazy(() =>
      import("./components/PerformanceDashboard").then((m) => ({
        default: m.PerformanceDashboard,
      }))
    )
  : null;

const ANALYTICS_ROUTE = /^\/analytics\/([A-Za-z0-9]+)$/;

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname || "/";
}

function App({ compatibilityInfo }: { compatibilityInfo?: CompatibilityInfo }) {
  const [pathname, setPathname] = useState(() =>
    normalizePath(window.location.pathname)
  );

  const { network, setNetwork } = useNetwork();
  const {
    wallet,
    connect,
    disconnect,
    isConnecting,
    isRestoring,
    availableWallets,
    selectedWalletId,
    selectWallet,
  } = useWallet({ network });

  useEffect(() => {
    const handlePopState = () => {
      setPathname(normalizePath(window.location.pathname));
    };

    const handleInternalNavigation = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;

      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin) return;

      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      event.preventDefault();

      const nextPath = normalizePath(url.pathname);
      if (nextPath !== pathname) {
        window.history.pushState(null, "", `${nextPath}${url.search}${url.hash}`);
        setPathname(nextPath);
        window.scrollTo(0, 0);
      }
    };

    window.addEventListener("popstate", handlePopState);
    document.addEventListener("click", handleInternalNavigation);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("click", handleInternalNavigation);
    };
  }, [pathname]);

  const page = useMemo(() => {
    if (pathname === "/campaigns") {
      return (
        <DashboardLayout
          wallet={wallet}
          onConnect={connect}
          onDisconnect={disconnect}
          isConnecting={isConnecting}
          currentPath={pathname}
        >
          <CampaignDashboard
            isWalletConnected={wallet.connected}
            onReconnectWallet={connect}
          />
        </DashboardLayout>
      );
    }

    if (pathname === "/recurring-payments") {
      return (
        <DashboardLayout
          wallet={wallet}
          onConnect={connect}
          onDisconnect={disconnect}
          isConnecting={isConnecting}
          currentPath={pathname}
        >
          <RecurringPayments />
        </DashboardLayout>
      );
    }

    if (pathname === "/streams") {
      return (
        <DashboardLayout
          wallet={wallet}
          onConnect={connect}
          onDisconnect={disconnect}
          isConnecting={isConnecting}
          currentPath={pathname}
        >
          <StreamDashboard />
        </DashboardLayout>
      );
    }

    if (pathname === "/governance") {
      return (
        <DashboardLayout
          wallet={wallet}
          onConnect={connect}
          onDisconnect={disconnect}
          isConnecting={isConnecting}
          currentPath={pathname}
        >
          <GovernancePage wallet={wallet} />
        </DashboardLayout>
      );
    }

    if (pathname === "/settings") {
      return (
        <DashboardLayout
          wallet={wallet}
          onConnect={connect}
          onDisconnect={disconnect}
          isConnecting={isConnecting}
          currentPath={pathname}
        >
          <SettingsPage network={network} onNetworkChange={setNetwork} />
        </DashboardLayout>
      );
    }

    const analyticsMatch = ANALYTICS_ROUTE.exec(pathname);
    if (analyticsMatch) {
      return (
        <DashboardLayout
          wallet={wallet}
          onConnect={connect}
          onDisconnect={disconnect}
          isConnecting={isConnecting}
          currentPath={pathname}
        >
          <TokenAnalyticsPage address={analyticsMatch[1]} />
        </DashboardLayout>
      );
    }

    if (pathname === "/" || pathname === "/deploy") {
      return (
        <LandingPage
          wallet={wallet}
          connect={connect}
          disconnect={disconnect}
          isConnecting={isConnecting}
          availableWallets={availableWallets}
          selectedWalletId={selectedWalletId}
          onSelectWallet={selectWallet}
        />
      );
    }

    return <NotFoundRoute />;
  }, [
    pathname,
    wallet,
    connect,
    disconnect,
    isConnecting,
    network,
    setNetwork,
    availableWallets,
    selectedWalletId,
    selectWallet,
  ]);

  if (isRestoring) return <PageLoader />;

  return (
    <ErrorBoundary>
      {compatibilityInfo && (
        <IntegrationVersionBanner info={compatibilityInfo} />
      )}
      <Suspense fallback={<PageLoader />}>
        <div id="main-content" tabIndex={-1}>
          {page}
        </div>
      </Suspense>

      {/* Language Selector + Theme Toggle */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
        <ThemeToggle />
        <LanguageSelector variant="inline" />
      </div>

      {/* PWA Offline Banner and Update Notification */}
      <PWAOfflineBanner />
      <PWAUpdateNotification />

      {/* Fee/resource preview shown before any contract call is signed */}
      <ResourceCostConfirmDialog />

      {/* Performance Dashboard (Dev only) */}
      {PerformanceDashboard && (
        <Suspense fallback={null}>
          <PerformanceDashboard />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export default App;
