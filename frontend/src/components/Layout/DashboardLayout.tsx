import React, { useState, useCallback } from 'react';
import { Button } from '../UI/Button';
import type { WalletState } from '../../types';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

// Navigation items
const NAV_ITEMS: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    label: 'Streams',
    href: '/streams',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    label: 'Recurring Payments',
    href: '/recurring-payments',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
  },
  {
    label: 'Deploy Token',
    href: '/deploy',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
      </svg>
    ),
  },
  {
    label: 'Governance',
    href: '/governance',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
  },
  {
    label: 'Webhooks',
    href: '/webhooks',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
];

interface DashboardLayoutProps {
  children: React.ReactNode;
  wallet: WalletState;
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
  isConnecting: boolean;
  currentPath: string;
}

export function DashboardLayout({
  children,
  wallet,
  onConnect,
  onDisconnect,
  isConnecting,
  currentPath,
}: DashboardLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleConnect = useCallback(async () => {
    try {
      await onConnect();
    } catch (err) {
      console.error('Failed to connect wallet:', err);
    }
  }, [onConnect]);

  const handleDisconnect = useCallback(() => {
    onDisconnect();
  }, [onDisconnect]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  // Truncate address for display
  const truncatedAddress = wallet.address 
    ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
    : '';

  return (
    <div className="min-h-screen bg-background-dark text-text-primary">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 border-r border-border-medium bg-background-elevated transform transition-all duration-300 ease-in-out lg:translate-x-0 ${
          sidebarCollapsed ? 'lg:w-20' : 'lg:w-64'
        } ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between h-16 px-4 border-b border-border-medium">
            <a
              href="/"
              className={`font-bold text-text-primary transition-all ${sidebarCollapsed ? 'text-lg' : 'text-xl'}`}
            >
              {sidebarCollapsed ? 'NL' : 'NovaLaunch'}
            </a>
            <button
              onClick={closeSidebar}
              className="p-2 text-text-secondary hover:text-text-primary lg:hidden"
              aria-label="Close sidebar"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <button
              onClick={toggleSidebarCollapsed}
              className="hidden rounded-md p-2 text-text-secondary hover:bg-background-card hover:text-text-primary lg:inline-flex"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5v14" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7M19 5v14" />
                </svg>
              )}
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
            {NAV_ITEMS.map((item) => {
              const isActive = currentPath === item.href || 
                (item.href !== '/' && currentPath.startsWith(item.href));
              
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-primary/15 text-primary border border-primary/30'
                      : 'text-text-secondary hover:bg-background-card hover:text-text-primary'
                  }`}
                  title={sidebarCollapsed ? item.label : undefined}
                  onClick={closeSidebar}
                >
                  <span className={isActive ? 'text-primary' : 'text-text-muted'}>
                    {item.icon}
                  </span>
                  {!sidebarCollapsed && item.label}
                </a>
              );
            })}
          </nav>

          {/* Wallet section */}
          <div className="p-4 border-t border-border-medium">
            {wallet.connected && wallet.address ? (
              <div className="space-y-3">
                <div className={`flex items-center ${sidebarCollapsed ? 'justify-center' : 'gap-2'}`}>
                  <div className="w-2 h-2 bg-emerald-400 rounded-full" />
                  {!sidebarCollapsed && <span className="text-sm text-text-secondary">Connected</span>}
                </div>
                {!sidebarCollapsed && (
                  <div className="p-2 bg-background-card border border-border-subtle rounded-lg">
                    <p className="text-xs text-text-muted">Wallet</p>
                    <p className="text-sm font-mono text-text-primary truncate" title={wallet.address}>
                      {truncatedAddress}
                    </p>
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  className={`border-primary/40 text-text-primary hover:bg-primary/10 ${
                    sidebarCollapsed ? 'w-full px-2' : 'w-full'
                  }`}
                  title={sidebarCollapsed ? 'Disconnect' : undefined}
                >
                  {sidebarCollapsed ? 'Off' : 'Disconnect'}
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleConnect}
                loading={isConnecting}
                className={`bg-primary hover:bg-[#E63428] hover:shadow-glow-red ${sidebarCollapsed ? 'w-full px-2' : 'w-full'}`}
                title={sidebarCollapsed ? 'Connect Wallet' : undefined}
              >
                {sidebarCollapsed ? 'On' : 'Connect Wallet'}
              </Button>
            )}
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className={`transition-all duration-300 ${sidebarCollapsed ? 'lg:pl-20' : 'lg:pl-64'}`}>
        {/* Top bar for mobile */}
        <header className="sticky top-0 z-30 border-b border-border-medium bg-background-elevated/90 backdrop-blur-md lg:hidden">
          <div className="flex items-center justify-between h-16 px-4">
            <button
              onClick={toggleSidebar}
              className="p-2 text-text-secondary hover:text-text-primary"
              aria-label="Open sidebar"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="text-lg font-bold text-text-primary">NovaLaunch</span>
            <div className="w-10" /> {/* Spacer for centering */}
          </div>
        </header>

        {/* Page content */}
        <main className="min-h-[calc(100vh-4rem)] lg:min-h-screen">
          {children}
        </main>
      </div>
    </div>
  );
}

export default DashboardLayout;
