import { useState, useEffect, useRef } from 'react';
import { message } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { useConfig } from './hooks/useConfig';
import { useCalendarData } from './hooks/useCalendarData';
import { CalendarTab } from './components/CalendarTab';
import { InvoicesTab } from './components/InvoicesTab';
import { RatesTab } from './components/RatesTab';
import { LogPanel } from './components/LogPanel';
import { UpdateNotification } from './components/UpdateNotification';
import { initRustLogListener, logInfo } from './lib/logger';
import { nextUnusedColor } from './lib/studioColors';

type Tab = 'calendar' | 'invoices' | 'rates';

export default function App() {
  const {
    config,
    isDirty,
    isLoading: configLoading,
    error: configError,
    updateConfig,
    save,
  } = useConfig();
  const { classes, isLoading: calLoading, error: calError, refresh } = useCalendarData(config);
  const [activeTab, setActiveTab] = useState<Tab>('calendar');
  const fatalConfigHandled = useRef(false);

  function handleAddStudio(name: string) {
    const usedHexes = Object.values(config.studios)
      .map((s) => s.color)
      .filter((c): c is string => c !== undefined);
    updateConfig({
      ...config,
      studios: {
        ...config.studios,
        [name]: {
          fullName: name,
          address: '',
          rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
          color: nextUnusedColor(usedHexes),
        },
      },
    });
    setActiveTab('rates');
  }

  // Cmd+Plus / Cmd+Minus zoom
  useEffect(() => {
    const STEP = 0.1;
    const MIN = 0.5;
    const MAX = 2.0;

    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        const cur = parseFloat(
          document.documentElement.style.getPropertyValue('--app-zoom') || '1'
        );
        document.documentElement.style.setProperty('--app-zoom', String(Math.min(cur + STEP, MAX)));
      } else if (e.key === '-') {
        e.preventDefault();
        const cur = parseFloat(
          document.documentElement.style.getPropertyValue('--app-zoom') || '1'
        );
        document.documentElement.style.setProperty('--app-zoom', String(Math.max(cur - STEP, MIN)));
      } else if (e.key === '0') {
        e.preventDefault();
        document.documentElement.style.setProperty('--app-zoom', '1');
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Start listening to Rust log events
  useEffect(() => {
    logInfo('App started');
    let unlisten: () => void = () => {};
    initRustLogListener().then((fn) => {
      unlisten = fn;
    });
    return () => unlisten();
  }, []);

  // Fetch calendar once config is loaded and whenever calendarId or the set of studios changes.
  // refresh is safe to include: it only changes when calendarId/studioKeys change, and calling
  // it doesn't mutate either, so there is no loop.
  useEffect(() => {
    if (!configLoading && !configError && config.calendarId) refresh();
  }, [configLoading, configError, config.calendarId, refresh]);

  useEffect(() => {
    if (configLoading || !configError || fatalConfigHandled.current) return;
    fatalConfigHandled.current = true;

    async function showFatalConfigError() {
      try {
        await message(configError ?? 'The configuration file is invalid.', {
          title: 'Invalid configuration',
          kind: 'error',
          buttons: { ok: 'Quit' },
        });
      } finally {
        await exit(1);
      }
    }

    void showFatalConfigError();
  }, [configLoading, configError]);

  if (configLoading) {
    return <div className="flex items-center justify-center h-screen text-gray-500">Loading…</div>;
  }

  if (configError) {
    return (
      <div className="flex items-center justify-center h-screen text-red-600">
        Invalid configuration
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'calendar', label: 'Calendar' },
    { id: 'invoices', label: 'Invoices' },
    { id: 'rates', label: 'Rates & Config' },
  ];

  return (
    <div className="flex flex-col h-screen bg-white">
      <UpdateNotification />
      {/* Tab bar */}
      <div className="flex border-b border-gray-200 bg-gray-50">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-indigo-600 text-indigo-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab.label}
            {tab.id === 'rates' && isDirty && (
              <span className="ml-2 text-xs text-amber-500">●</span>
            )}
          </button>
        ))}
        <div className="ml-auto flex items-center px-4 gap-3">
          {calLoading && <span className="text-xs text-gray-400">Refreshing…</span>}
          {calError && (
            <span className="text-xs text-red-500" title={calError}>
              ⚠ Calendar error
            </span>
          )}
          <button
            onClick={refresh}
            disabled={calLoading}
            className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-40"
          >
            ↺ Refresh
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === 'calendar' && (
          <CalendarTab classes={classes} studios={config.studios} onAddStudio={handleAddStudio} />
        )}
        {activeTab === 'invoices' && (
          <InvoicesTab classes={classes} config={config} onSaveConfig={save} />
        )}
        {activeTab === 'rates' && (
          <RatesTab
            config={config}
            isDirty={isDirty}
            saveError={configError}
            onUpdate={updateConfig}
            onSave={save}
          />
        )}
      </div>
      <LogPanel />
    </div>
  );
}
