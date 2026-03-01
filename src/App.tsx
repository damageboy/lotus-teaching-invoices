import { useState, useEffect } from 'react';
import { useConfig } from './hooks/useConfig';
import { useCalendarData } from './hooks/useCalendarData';
import { CalendarTab } from './components/CalendarTab';
import { InvoicesTab } from './components/InvoicesTab';
import { RatesTab } from './components/RatesTab';
import { LogPanel } from './components/LogPanel';
import { initRustLogListener, logInfo } from './lib/logger';

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

  function handleAddStudio(name: string) {
    updateConfig({
      ...config,
      studios: {
        ...config.studios,
        [name]: {
          fullName: name,
          address: '',
          rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
        },
      },
    });
    setActiveTab('rates');
  }

  // Start listening to Rust log events
  useEffect(() => {
    logInfo('App started');
    let unlisten: () => void = () => {};
    initRustLogListener().then((fn) => {
      unlisten = fn;
    });
    return () => unlisten();
  }, []);

  // Fetch calendar once config is loaded and calendarUrl is set
  useEffect(() => {
    if (!configLoading && config.calendarUrl) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable; including it would cause an infinite fetch loop
  }, [configLoading, config.calendarUrl]);

  if (configLoading) {
    return <div className="flex items-center justify-center h-screen text-gray-500">Loading…</div>;
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'calendar', label: 'Calendar' },
    { id: 'invoices', label: 'Invoices' },
    { id: 'rates', label: 'Rates & Config' },
  ];

  return (
    <div className="flex flex-col h-screen bg-white">
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
