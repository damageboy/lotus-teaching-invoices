import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowsClockwise } from '@phosphor-icons/react';
import lotusIcon from '../../assets/lotus-icon.png';
import { MobileNavigation, type AppTab } from './MobileNavigation';

interface Props {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  disabledTabs?: readonly AppTab[];
  calendarActionsEnabled?: boolean;
  calendarLoading: boolean;
  calendarError: string | null;
  onRefresh: () => void | Promise<void>;
  children: ReactNode;
}

const MOBILE_NAVIGATION_HEIGHT = 'calc(3rem + max(env(safe-area-inset-bottom), 1.5rem))';

const titles: Record<AppTab, string> = {
  calendar: 'Calendar',
  invoices: 'Invoices',
  income: 'Income',
  rates: 'Settings',
};

export function MobileAppShell({
  activeTab,
  onSelectTab,
  disabledTabs = [],
  calendarActionsEnabled = true,
  calendarLoading,
  calendarError,
  onRefresh,
  children,
}: Props) {
  const refreshLabel = calendarLoading ? 'Syncing' : 'Refresh calendar';
  const refreshStatus = calendarLoading
    ? 'Syncing'
    : calendarActionsEnabled && calendarError
      ? 'Retry'
      : 'Synced';
  const contentRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeTab]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousHeight = root.style.getPropertyValue('--mobile-navigation-height');
    root.style.setProperty('--mobile-navigation-height', MOBILE_NAVIGATION_HEIGHT);
    return () => {
      if (previousHeight) root.style.setProperty('--mobile-navigation-height', previousHeight);
      else root.style.removeProperty('--mobile-navigation-height');
    };
  }, []);

  return (
    <div data-layout="mobile" className="flex min-h-[100dvh] flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <img src={lotusIcon} alt="Lotus Teaching Invoices" className="h-8 w-8 rounded-lg" />
        <h1 className="flex-1 text-lg font-semibold text-gray-900">{titles[activeTab]}</h1>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={calendarLoading || !calendarActionsEnabled}
          aria-label={refreshLabel}
          className="flex min-h-12 items-center justify-center gap-2 rounded-full px-3 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:text-gray-400"
        >
          <ArrowsClockwise
            size={23}
            aria-hidden="true"
            className={calendarLoading ? 'animate-spin motion-reduce:animate-none' : ''}
          />
          <span>{refreshStatus}</span>
        </button>
      </header>

      {calendarError && calendarActionsEnabled && (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-center gap-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <span className="min-w-0 flex-1">{calendarError}</span>
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="min-h-12 shrink-0 px-2 font-medium text-red-700 underline"
          >
            Retry calendar sync
          </button>
        </div>
      )}

      <main
        ref={contentRef}
        className="min-h-0 flex-1 overflow-auto"
        style={{ paddingBottom: 'var(--mobile-navigation-height)' }}
      >
        {children}
      </main>

      <div
        className="fixed inset-x-0 bottom-0 z-50 bg-white"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 1.5rem)' }}
      >
        <MobileNavigation
          activeTab={activeTab}
          onSelect={onSelectTab}
          disabledTabs={disabledTabs}
        />
      </div>
    </div>
  );
}
