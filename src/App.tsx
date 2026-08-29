import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { LockSimple } from '@phosphor-icons/react';
import { message } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { useConfig } from './hooks/useConfig';
import { useCalendarData } from './hooks/useCalendarData';
import { useGoogleAuthorization } from './hooks/useGoogleAuthorization';
import { useCalendarEditing } from './hooks/useCalendarEditing';
import { useDriveInvoices } from './hooks/useDriveInvoices';
import { useDriveFolderController } from './hooks/useDriveFolderController';
import { useDriveSetupSnapshot } from './hooks/useDriveSetupSnapshot';
import { useCalendarPicker } from './hooks/useCalendarPicker';
import { useSetupOnboarding } from './hooks/useSetupOnboarding';
import { useCompactLayout, type AppLayout } from './hooks/useCompactLayout';
import { CalendarTab } from './components/CalendarTab';
import { InvoicesTab } from './components/InvoicesTab';
import { IncomeTab } from './components/IncomeTab';
import { RatesTab } from './components/RatesTab';
import { LogPanel } from './components/LogPanel';
import { UpdateNotification } from './components/UpdateNotification';
import { CalendarPermissionPrompt } from './components/CalendarPermissionPrompt';
import { DriveFolderDialog } from './components/setup/DriveFolderDialog';
import { SetupWizard } from './components/setup/SetupWizard';
import { MobileAppShell } from './components/mobile/MobileAppShell';
import type { AppTab } from './components/mobile/MobileNavigation';
import { initialMobileTabState, selectMobileTab } from './components/mobile/mobile-tab-state';
import { initRustLogListener, logInfo } from './lib/logger';
import { nextUnusedColor } from './lib/studioColors';
import { createTauriDriveApi } from './lib/drive/transport';
import { DriveFolderService } from './lib/drive/folders';
import { scanFinalFolder } from './lib/drive/invoiceCatalog';
import { DriveInvoiceStore } from './lib/drive/invoiceStore';
import type { DriveConfigSnapshot } from './lib/drive/configFile';
import {
  installDriveConfigPointer,
  readDriveConfigPointer,
  type DriveConfigPointerRead,
} from './lib/drive/configPointer';
import type { DriveInvoicesState } from './hooks/useDriveInvoices';
import { renderFinalPdf } from './lib/pdf/generatePdf';
import { deriveSetupReadiness } from './lib/setup/readiness';
import {
  buildCurrentInvoiceSources,
  currentInvoiceSourceInputKey,
  visibleCurrentInvoiceSourceBuild,
  type CurrentInvoiceSourceBuild,
} from './lib/invoice/rows';

export default function App() {
  const googleAuthorization = useGoogleAuthorization();
  const driveApi = useMemo(() => createTauriDriveApi(), []);
  const driveStore = useMemo(() => new DriveInvoiceStore(driveApi, { renderFinalPdf }), [driveApi]);
  const driveFolderService = useMemo(() => new DriveFolderService(driveApi), [driveApi]);
  const driveInvoicesRef = useRef<DriveInvoicesState | null>(null);
  const [remoteConfig, setRemoteConfig] = useState<DriveConfigSnapshot | null>(null);
  const [driveConfigUnavailable, setDriveConfigUnavailable] = useState(false);
  const [legacyConfig, setLegacyConfig] = useState<{
    loaded: boolean;
    raw?: string;
    error: string | null;
  }>({ loaded: false, error: null });
  const [migrationCleanupError, setMigrationCleanupError] = useState<string | null>(null);
  const [driveConfigPointer, setDriveConfigPointer] = useState<{
    loaded: boolean;
    value: DriveConfigPointerRead | null;
    error: string | null;
  }>({ loaded: false, value: null, error: null });
  const cleanedMigrationRef = useRef<string | null>(null);
  const saveRemoteConfig = useCallback((next: Parameters<DriveInvoicesState['saveConfig']>[0]) => {
    const drive = driveInvoicesRef.current;
    if (drive === null) return Promise.reject(new Error('Drive configuration is not ready'));
    return drive.saveConfig(next);
  }, []);
  const {
    config,
    isDirty,
    isLoading: remoteConfigLoading,
    loadError: remoteConfigLoadError,
    saveError: remoteConfigSaveError,
    updateConfig,
    save,
    saveUpdateOrThrow,
  } = useConfig({
    remote: remoteConfig,
    unconfigured: driveConfigUnavailable,
    ...(legacyConfig.raw === undefined ? {} : { legacyLocalYaml: legacyConfig.raw }),
    saveRemote: saveRemoteConfig,
  });
  const configLoading = remoteConfigLoading || !driveConfigPointer.loaded;
  const configLoadError = driveConfigPointer.error ?? legacyConfig.error ?? remoteConfigLoadError;
  const configSaveError = migrationCleanupError ?? remoteConfigSaveError;
  const {
    classes,
    isLoading: calLoading,
    error: calError,
    refresh,
    reloadCache,
  } = useCalendarData(config);
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
    issues: [],
    error: null,
  });
  const {
    sources: invoiceSources,
    issues: invoiceSourceIssues,
    ready: invoiceSourcesReady,
    error: invoiceSourceError,
  } = visibleCurrentInvoiceSourceBuild(invoiceSourceInputKey, invoiceSourceBuild);
  const fatalConfigHandled = useRef(false);
  const driveSources = invoiceSourcesReady ? invoiceSources : [];
  const driveSourceContextKey = invoiceSourcesReady ? invoiceSourceInputKey : 'setup-discovery';
  const driveInvoices = useDriveInvoices({
    store: driveStore,
    sources: driveSources,
    sourceContextKey: driveSourceContextKey,
    authorizationIncarnation: googleAuthorization.authorizationIncarnation,
    discoveryEnabled:
      !googleAuthorization.isLoading &&
      legacyConfig.loaded &&
      driveConfigPointer.loaded &&
      driveConfigPointer.error === null,
    foregroundRefreshEnabled: activeTab === 'invoices' && invoiceSourcesReady,
    ...(driveConfigPointer.value === null ? {} : { pointer: driveConfigPointer.value }),
    installPointer: async (fileId, expectedRaw) => {
      const installed = await installDriveConfigPointer(fileId, expectedRaw);
      setDriveConfigPointer({
        loaded: true,
        value: { kind: 'valid', raw: installed.raw, fileId: installed.fileId },
        error: null,
      });
      return installed;
    },
    ...(legacyConfig.raw === undefined ? {} : { legacyLocalYaml: legacyConfig.raw }),
  });
  driveInvoicesRef.current = driveInvoices;

  useEffect(() => {
    let current = true;
    void invoke<string | null>('read_legacy_config').then(
      (raw) => {
        if (!current) return;
        setLegacyConfig({ loaded: true, ...(raw === null ? {} : { raw }), error: null });
      },
      (cause) => {
        if (!current) return;
        setLegacyConfig({ loaded: true, error: String(cause) });
      }
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void readDriveConfigPointer().then(
      (value) => {
        if (current) setDriveConfigPointer({ loaded: true, value, error: null });
      },
      (cause) => {
        if (current) {
          setDriveConfigPointer({ loaded: true, value: null, error: String(cause) });
        }
      }
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    setRemoteConfig(driveInvoices.configSnapshot);
    setDriveConfigUnavailable(
      driveInvoices.configSnapshot === null && driveInvoices.status !== 'loading'
    );
  }, [driveInvoices.configSnapshot, driveInvoices.status]);

  useEffect(() => {
    const receipt = legacyConfig.raw;
    if (
      receipt === undefined ||
      driveInvoices.snapshot === null ||
      cleanedMigrationRef.current === receipt
    ) {
      return;
    }
    cleanedMigrationRef.current = receipt;
    setMigrationCleanupError(null);
    void invoke('remove_verified_legacy_config', { expectedRaw: receipt }).catch((cause) => {
      setMigrationCleanupError(
        `Cloud migration succeeded, but local config cleanup failed: ${cause}`
      );
    });
  }, [driveInvoices.snapshot, legacyConfig.raw]);
  const setupDriveSnapshot = useDriveSetupSnapshot({
    store: driveStore,
    authorizationIncarnation: googleAuthorization.authorizationIncarnation,
    status: driveInvoices.status,
    snapshot: driveInvoices.snapshot,
  });
  const scanDriveFolderCandidate = useCallback(
    (
      stagedRoot: Parameters<typeof scanFinalFolder>[1],
      sources: Parameters<typeof scanFinalFolder>[2]
    ) => scanFinalFolder(driveApi, stagedRoot, sources),
    [driveApi]
  );
  const driveFolder = useDriveFolderController({
    hasDriveAuthorization: googleAuthorization.hasDrive,
    authorizationIncarnation: googleAuthorization.authorizationIncarnation,
    authorizeDrive: googleAuthorization.allowDrive,
    drive: driveInvoices,
    config,
    sources: driveSources,
    sourceContextKey: driveSourceContextKey,
    scanCandidate: scanDriveFolderCandidate,
  });
  const calendarPicker = useCalendarPicker({
    config,
    saveConfig: saveUpdateOrThrow,
    validationEnabled: remoteConfig !== null || driveFolder.pendingNewRoot !== null,
    authorizationIncarnation: googleAuthorization.authorizationIncarnation,
  });
  const pendingRootCompletionRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = driveFolder.pendingNewRoot;
    if (pending === null || calendarPicker.connectionStatus !== 'accessible') return;
    const key = JSON.stringify([
      pending.root.folderId,
      pending.root.driveId,
      config.calendarId ?? null,
      config.calendarName ?? null,
      config.calendarAccessRole ?? null,
    ]);
    if (pendingRootCompletionRef.current === key) return;
    pendingRootCompletionRef.current = key;
    void driveFolder.completePendingNewRoot(config).catch(() => undefined);
  }, [calendarPicker.connectionStatus, config, driveFolder]);
  useEffect(() => {
    if (driveFolder.pendingNewRoot === null) pendingRootCompletionRef.current = null;
  }, [driveFolder.pendingNewRoot]);
  const setupReadiness = deriveSetupReadiness({
    configLoading,
    calendarStatus: calendarPicker.connectionStatus,
    authorizationLoading: googleAuthorization.isLoading,
    hasDrive: googleAuthorization.hasDrive,
    driveStatus: driveInvoices.status,
    driveSnapshot: setupDriveSnapshot,
    driveStaged: driveFolder.pendingNewRoot !== null,
  });
  const verifyingConfiguredStartup =
    driveInvoices.configSnapshot !== null &&
    driveInvoices.snapshot === null &&
    driveInvoices.status === 'loading';
  const setupBlocked = setupReadiness.status !== 'ready' && !verifyingConfiguredStartup;
  const visibleActiveTab: AppTab = setupBlocked ? 'rates' : activeTab;
  const disabledTabs: readonly AppTab[] = verifyingConfiguredStartup
    ? ['invoices', 'income']
    : setupBlocked
      ? ['calendar', 'invoices', 'income']
      : [];
  const onboarding = useSetupOnboarding(setupReadiness);
  const setupPresenterResolvedRef = useRef(false);
  const completionOriginRef = useRef<'welcome' | 'dismissed' | null>(null);
  const wizardOpen =
    onboarding.open ||
    (setupReadiness.status === 'checking' && completionOriginRef.current === 'welcome');
  const dismissOnboarding = useCallback(() => {
    completionOriginRef.current = 'dismissed';
    onboarding.dismiss();
  }, [onboarding]);

  useEffect(() => {
    if (setupReadiness.status !== 'ready') {
      setInvoiceSourceBuild({ inputKey: null, sources: [], issues: [], error: null });
      return;
    }
    let current = true;
    void buildCurrentInvoiceSources(classes, config).then(
      ({ sources, issues }) => {
        if (!current) return;
        setInvoiceSourceBuild({ inputKey: invoiceSourceInputKey, sources, issues, error: null });
      },
      (cause) => {
        if (!current) return;
        const sourceMessage = cause instanceof Error ? cause.message : String(cause);
        logInfo(`Current invoice sources unavailable: ${sourceMessage}`);
        setInvoiceSourceBuild({
          inputKey: invoiceSourceInputKey,
          sources: [],
          issues: [],
          error: sourceMessage,
        });
      }
    );
    return () => {
      current = false;
    };
  }, [classes, config, invoiceSourceInputKey, setupReadiness.status]);

  useEffect(() => {
    if (setupBlocked && activeTab !== 'rates') {
      setMobileTabState((state) => ({ ...state, activeTab: 'rates' }));
    }
  }, [activeTab, setupBlocked]);

  useEffect(() => {
    const initialCheckResolved =
      setupReadiness.status !== 'checking' && !setupPresenterResolvedRef.current;
    if (initialCheckResolved) setupPresenterResolvedRef.current = true;
    if (onboarding.open) completionOriginRef.current = 'welcome';
    if (setupReadiness.status !== 'ready') return;
    if (completionOriginRef.current === 'welcome') {
      setMobileTabState((state) => selectMobileTab(state, 'calendar'));
    } else if (initialCheckResolved) {
      setMobileTabState((state) => ({ ...state, activeTab: 'calendar' }));
    }
    completionOriginRef.current = null;
  }, [onboarding.open, setupReadiness.status]);

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

  if (
    setupReadiness.status === 'checking' &&
    !setupPresenterResolvedRef.current &&
    !verifyingConfiguredStartup
  ) {
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
        {visibleActiveTab === 'calendar' && (
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
        {visibleActiveTab === 'invoices' && (
          <InvoicesTab
            layout={layout}
            classes={classes}
            config={config}
            drive={driveInvoices}
            sourceError={invoiceSourceError}
            sourceIssues={invoiceSourceIssues}
          />
        )}
        {visibleActiveTab === 'income' && (
          <IncomeTab layout={layout} classes={classes} config={config} />
        )}
        {visibleActiveTab === 'rates' && (
          <RatesTab
            layout={layout}
            config={config}
            calendarPicker={calendarPicker}
            drive={driveInvoices}
            driveFolder={driveFolder}
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
        open={setupReadiness.status === 'ready' && !wizardOpen && googleAuthorization.promptOpen}
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
                disabled={disabledTabs.includes(tab.id)}
                onClick={() => setMobileTabState((state) => ({ ...state, activeTab: tab.id }))}
                className={`px-6 py-3 text-sm font-medium transition-colors ${
                  visibleActiveTab === tab.id
                    ? 'border-b-2 border-indigo-600 text-indigo-600'
                    : disabledTabs.includes(tab.id)
                      ? 'cursor-not-allowed text-gray-400'
                      : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {tab.label}
                {disabledTabs.includes(tab.id) && (
                  <LockSimple data-lock className="ml-1 inline" size={12} aria-hidden="true" />
                )}
                {tab.id === 'rates' && isDirty && (
                  <span className="ml-2 text-xs text-amber-500">●</span>
                )}
              </button>
            ))}
            <div className="ml-auto flex items-center px-4 gap-3">
              {calLoading && <span className="text-xs text-gray-400">Refreshing…</span>}
              {!setupBlocked && calError && (
                <span className="text-xs text-red-500" title={calError}>
                  ⚠ Calendar error
                </span>
              )}
              <button
                onClick={refresh}
                disabled={calLoading || setupBlocked}
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
          activeTab={visibleActiveTab}
          onSelectTab={(tab) => setMobileTabState((state) => selectMobileTab(state, tab))}
          disabledTabs={disabledTabs}
          calendarActionsEnabled={!setupBlocked}
          calendarLoading={calLoading}
          calendarError={calError}
          onRefresh={refresh}
        >
          {tabContent}
        </MobileAppShell>
      )}
      <SetupWizard
        open={wizardOpen}
        layout={layout}
        step={onboarding.step}
        calendarPicker={calendarPicker}
        drive={driveInvoices}
        driveFolder={driveFolder}
        onDismiss={dismissOnboarding}
      />
      <DriveFolderDialog
        open={driveFolder.dialogOpen}
        layout={layout}
        currentRoot={driveInvoices.snapshot?.stagedRoot.root ?? null}
        detectedFolders={
          driveInvoices.snapshot === null ? [] : [driveInvoices.snapshot.stagedRoot.rootFile]
        }
        folderService={driveFolderService}
        scanCandidate={driveFolder.scanCandidate}
        onConfirm={async (stagedRoot) => {
          await driveFolder.confirmRoot(stagedRoot);
        }}
        onClose={driveFolder.closeDialog}
      />
    </div>
  );
}
