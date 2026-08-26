import { useState, useEffect, useMemo, useRef } from 'react';
import { message } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { useConfig } from './hooks/useConfig';
import { useCalendarData } from './hooks/useCalendarData';
import { useGoogleAuthorization } from './hooks/useGoogleAuthorization';
import { useCalendarEditing } from './hooks/useCalendarEditing';
import { useDriveInvoices } from './hooks/useDriveInvoices';
import { useCalendarPicker } from './hooks/useCalendarPicker';
import { useCompactLayout, type AppLayout } from './hooks/useCompactLayout';
import { CalendarTab } from './components/CalendarTab';
import { InvoicesTab } from './components/InvoicesTab';
import { IncomeTab } from './components/IncomeTab';
import { RatesTab } from './components/RatesTab';
import { LogPanel } from './components/LogPanel';
import { UpdateNotification } from './components/UpdateNotification';
import { CalendarPermissionPrompt } from './components/CalendarPermissionPrompt';
import { MobileAppShell } from './components/mobile/MobileAppShell';
import type { AppTab } from './components/mobile/MobileNavigation';
import { initialMobileTabState, selectMobileTab } from './components/mobile/mobile-tab-state';
import { initRustLogListener, logInfo } from './lib/logger';
import { nextUnusedColor } from './lib/studioColors';
import { createTauriDriveApi } from './lib/drive/transport';
import { DriveFolderService } from './lib/drive/folders';
import { scanFinalFolder } from './lib/drive/invoiceCatalog';
import { DriveInvoiceStore } from './lib/drive/invoiceStore';
import { renderFinalPdf } from './lib/pdf/generatePdf';
import {
  buildCurrentInvoiceSources,
  currentInvoiceSourceInputKey,
  visibleCurrentInvoiceSourceBuild,
  type CurrentInvoiceSourceBuild,
} from './lib/invoice/rows';

export default function App() {
  const {
    config,
    isDirty,
    isLoading: configLoading,
    loadError: configLoadError,
    saveError: configSaveError,
    updateConfig,
    save,
    saveOrThrow,
    saveUpdateOrThrow,
  } = useConfig();
  const calendarPicker = useCalendarPicker({ config, saveConfig: saveUpdateOrThrow });
  const {
    classes,
    isLoading: calLoading,
    error: calError,
    refresh,
    reloadCache,
  } = useCalendarData(config);
  const googleAuthorization = useGoogleAuthorization();
  const calendarEditing = useCalendarEditing({
    calendarId: configLoading ? undefined : config.calendarId,
    persistedAccessRole: config.calendarAccessRole,
    hasCalendarWrite: googleAuthorization.hasCalendarWrite,
    authorizationLoading: googleAuthorization.isLoading,
    reloadCache,
  });
  const compactLayout = useCompactLayout();
  const layout: AppLayout = compactLayout ? 'mobile' : 'desktop';
  const [mobileTabState, setMobileTabState] = useState(initialMobileTabState);
  const { activeTab, calendarActivation } = mobileTabState;
  const invoiceSourceInputKey = useMemo(
    () => currentInvoiceSourceInputKey(classes, config),
    [classes, config]
  );
  const [invoiceSourceBuild, setInvoiceSourceBuild] = useState<CurrentInvoiceSourceBuild>({
    inputKey: null,
    sources: [],
    error: null,
  });
  const {
    sources: invoiceSources,
    ready: invoiceSourcesReady,
    error: invoiceSourceError,
  } = visibleCurrentInvoiceSourceBuild(invoiceSourceInputKey, invoiceSourceBuild);
  const fatalConfigHandled = useRef(false);
  const driveApi = useMemo(() => createTauriDriveApi(), []);
  const driveStore = useMemo(() => new DriveInvoiceStore(driveApi, { renderFinalPdf }), [driveApi]);
  const driveFolderService = useMemo(() => new DriveFolderService(driveApi), [driveApi]);
  const driveInvoices = useDriveInvoices({
    store: driveStore,
    sources: invoiceSources,
    sourceContextKey: invoiceSourceInputKey,
    authorizationIncarnation: googleAuthorization.authorizationIncarnation,
    discoveryEnabled: !googleAuthorization.isLoading && googleAuthorization.hasDrive,
    foregroundRefreshEnabled: activeTab === 'invoices' && invoiceSourcesReady,
  });

  useEffect(() => {
    let current = true;
    void buildCurrentInvoiceSources(classes, config).then(
      (sources) => {
        if (!current) return;
        setInvoiceSourceBuild({ inputKey: invoiceSourceInputKey, sources, error: null });
      },
      (error) => {
        if (!current) return;
        const message = error instanceof Error ? error.message : String(error);
        logInfo(`Current invoice sources unavailable: ${message}`);
        setInvoiceSourceBuild({ inputKey: invoiceSourceInputKey, sources: [], error: message });
      }
    );
    return () => {
      current = false;
    };
  }, [classes, config, invoiceSourceInputKey]);

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
    setMobileTabState((state) => ({ ...state, activeTab: 'rates' }));
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
    if (!configLoading && !configLoadError && config.calendarId) refresh();
  }, [configLoading, configLoadError, config.calendarId, refresh]);

  useEffect(() => {
    if (configLoading || !configLoadError || fatalConfigHandled.current) return;
    fatalConfigHandled.current = true;

    async function showFatalConfigError() {
      try {
        await message(configLoadError ?? 'The configuration file is invalid.', {
          title: 'Invalid configuration',
          kind: 'error',
          buttons: { ok: 'Quit' },
        });
      } finally {
        await exit(1);
      }
    }

    void showFatalConfigError();
  }, [configLoading, configLoadError]);

  if (configLoading) {
    return <div className="flex items-center justify-center h-screen text-gray-500">Loading…</div>;
  }

  if (configLoadError) {
    return (
      <div className="flex items-center justify-center h-screen text-red-600">
        Invalid configuration
      </div>
    );
  }

  const tabs: { id: AppTab; label: string }[] = [
    { id: 'calendar', label: 'Calendar' },
    { id: 'invoices', label: 'Invoices' },
    { id: 'income', label: 'Income' },
    { id: 'rates', label: 'Rates & Config' },
  ];

  const tabContent = (
    <>
      {/* Tab content */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === 'calendar' && (
          <CalendarTab
            layout={layout}
            mobileActivation={calendarActivation}
            classes={classes}
            studios={config.studios}
            onAddStudio={handleAddStudio}
            canEdit={calendarEditing.canEdit}
            onReassignStudio={calendarEditing.reassignOccurrenceStudio}
            onPrepareValueEdit={calendarEditing.prepareOccurrenceValueEdit}
            onSaveValueEdit={calendarEditing.saveOccurrenceValueEdit}
            onPrepareSeriesStudioEdit={calendarEditing.prepareSeriesStudioEdit}
            onSaveSeriesStudioEdit={calendarEditing.saveSeriesStudioEdit}
          />
        )}
        {activeTab === 'invoices' && (
          <InvoicesTab
            layout={layout}
            classes={classes}
            config={config}
            drive={driveInvoices}
            sourceError={invoiceSourceError}
            folderService={driveFolderService}
            scanCandidate={(stagedRoot) => {
              if (!invoiceSourcesReady) {
                throw new Error(invoiceSourceError ?? 'Current invoice sources are still loading.');
              }
              return scanFinalFolder(driveApi, stagedRoot, invoiceSources);
            }}
            onSaveConfig={saveOrThrow}
            onAuthorizeDrive={googleAuthorization.allowDrive}
          />
        )}
        {activeTab === 'income' && <IncomeTab layout={layout} classes={classes} config={config} />}
        {activeTab === 'rates' && (
          <RatesTab
            layout={layout}
            config={config}
            calendarPicker={calendarPicker}
            isDirty={isDirty}
            saveError={configSaveError}
            onUpdate={updateConfig}
            onSave={save}
          />
        )}
      </div>
      <LogPanel layout={layout} />
    </>
  );

  return (
    <div className="flex flex-col h-screen bg-white">
      <UpdateNotification />
      <CalendarPermissionPrompt
        open={googleAuthorization.promptOpen}
        reason={googleAuthorization.hasCalendarWrite ? 'calendarReadOnly' : 'scopeMissing'}
        isAuthorizing={googleAuthorization.isAuthorizing}
        error={googleAuthorization.error}
        onAllow={googleAuthorization.allowCalendarEditing}
        onDismiss={googleAuthorization.dismissCalendarEditingPrompt}
      />
      {layout === 'desktop' ? (
        <>
          {/* Tab bar */}
          <div data-layout="desktop" className="flex border-b border-gray-200 bg-gray-50">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setMobileTabState((state) => ({ ...state, activeTab: tab.id }))}
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
          {tabContent}
        </>
      ) : (
        <MobileAppShell
          activeTab={activeTab}
          onSelectTab={(tab) => setMobileTabState((state) => selectMobileTab(state, tab))}
          calendarLoading={calLoading}
          calendarError={calError}
          onRefresh={refresh}
        >
          {tabContent}
        </MobileAppShell>
      )}
    </div>
  );
}
