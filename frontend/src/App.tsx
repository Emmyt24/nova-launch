import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useNetwork } from "./hooks/useNetwork";
import { useWallet } from "./hooks/useWallet";
import { Spinner, ErrorBoundary } from "./components/UI";
import { DashboardLayout } from "./components/Layout";
import { PerformanceDashboard } from "./components/PerformanceDashboard";
import { PWAUpdateNotification } from "./components/PWA";

// Lazy load pages
const LandingPage = lazy(() => import("./pages/LandingPage"));
const NotFoundRoute = lazy(() => import("./routes/NotFoundRoute"));
const RecurringPayments = lazy(() => import("./app/dashboard/RecurringPayments"));
const CampaignDashboard = lazy(() => import("./app/dashboard/CampaignDashboard"));

// Loading fallback
function PageLoader() {
  return (
    <div
      className="flex items-center justify-center min-h-screen bg-gray-50"
      role="status"
      aria-label="Loading page"
    >
      <Spinner size="lg" />
      <span className="sr-only">Loading...</span>
    </div>
  );
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname || "/";
}

function App() {
  const [pathname, setPathname] = useState(() =>
    normalizePath(window.location.pathname)
  );

  const { network } = useNetwork();
  const { wallet, connect, disconnect, isConnecting } = useWallet({ network });

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
    if (pathname === "/campaign-dashboard") {
      return (
        <DashboardLayout
          wallet={wallet}
          onConnect={connect}
          onDisconnect={disconnect}
          isConnecting={isConnecting}
          currentPath={pathname}
        >
          <CampaignDashboard />
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

    if (pathname === "/" || pathname === "/deploy") {
      return (
        <LandingPage
          wallet={wallet}
          connect={connect}
          disconnect={disconnect}
          isConnecting={isConnecting}
        />
      );
    }

    return <NotFoundRoute />;
  }, [pathname, wallet, connect, disconnect, isConnecting]);

  return (
    <ErrorBoundary>
      <a href="#main-content" className="skip-to-main">
        Skip to main content
      </a>

      <Suspense fallback={<PageLoader />}>
        <div id="main-content" tabIndex={-1}>
          {page}
        </div>
      </Suspense>

      {/* PWA Update Notification */}
      <PWAUpdateNotification />

      {/* Performance Dashboard (Dev only) */}
      <PerformanceDashboard />
    </ErrorBoundary>
  );
}

export default App;
