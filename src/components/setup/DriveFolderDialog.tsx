import { useCallback, useEffect, useRef, useState } from 'react';
import type { DriveRootPointer } from '../../lib/drive/controlFile.js';
import type {
  DriveFolderPage,
  DriveFolderService,
  DriveLocation,
  StagedDriveRoot,
} from '../../lib/drive/folders.js';
import type { DriveInvoiceScan } from '../../lib/drive/invoiceCatalog.js';
import type { DriveFileRecord } from '../../lib/drive/types.js';

export type DriveFolderDialogLayout = 'desktop' | 'mobile';

export type DriveFolderBrowserService = Pick<
  DriveFolderService,
  'listLocations' | 'listChildren' | 'createChild' | 'stageRoot'
>;

export interface DriveFolderDialogProps {
  open: boolean;
  layout: DriveFolderDialogLayout;
  currentRoot: DriveRootPointer | null;
  detectedFolders: readonly DriveFileRecord[];
  legacyLastInvoice?: string;
  folderService: DriveFolderBrowserService;
  scanCandidate(stagedRoot: StagedDriveRoot): Promise<DriveInvoiceScan>;
  onConfirm(stagedRoot: StagedDriveRoot, legacyLastInvoice?: string): void | Promise<void>;
  onClose(): void;
}

type DialogPhase = 'landing' | 'browse' | 'scanning' | 'confirm';

interface MobileHistoryEntry {
  id: number;
  closing: boolean;
  popping: boolean;
}

const TITLE_ID = 'drive-folder-dialog-title';
const DESCRIPTION_ID = 'drive-folder-dialog-description';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeFolders(
  current: readonly DriveFileRecord[],
  next: readonly DriveFileRecord[]
): DriveFileRecord[] {
  const folders = new Map(current.map((folder) => [folder.id, folder]));
  for (const folder of next) {
    if (!folders.has(folder.id)) folders.set(folder.id, folder);
  }
  return [...folders.values()];
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function rootsDiffer(current: DriveRootPointer | null, staged: StagedDriveRoot): boolean {
  return (
    current !== null &&
    (current.folderId !== staged.root.folderId || current.driveId !== staged.root.driveId)
  );
}

export function DriveFolderDialog({
  open,
  layout,
  currentRoot,
  detectedFolders,
  legacyLastInvoice,
  folderService,
  scanCandidate,
  onConfirm,
  onClose,
}: DriveFolderDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);
  const confirmingRef = useRef(false);
  const mobileHistoryRef = useRef<MobileHistoryEntry | null>(null);
  const mobileHistorySequenceRef = useRef(0);
  const [phase, setPhase] = useState<DialogPhase>('landing');
  const [locations, setLocations] = useState<DriveLocation[]>([]);
  const [location, setLocation] = useState<DriveLocation | null>(null);
  const [path, setPath] = useState<DriveFileRecord[]>([]);
  const [folders, setFolders] = useState<DriveFileRecord[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stagedRoot, setStagedRoot] = useState<StagedDriveRoot | null>(null);
  const [candidateScan, setCandidateScan] = useState<DriveInvoiceScan | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const touchClass = layout === 'mobile' ? 'min-h-12 min-w-12 text-base' : '';

  const ownMobileHistory = useCallback((): void => {
    const id = ++mobileHistorySequenceRef.current;
    window.history.pushState({ lotusDriveFolderDialog: id }, '');
    mobileHistoryRef.current = { id, closing: false, popping: false };
  }, []);

  const finishClose = useCallback(
    (fromHistory: boolean) => {
      const historyEntry = mobileHistoryRef.current;
      if (fromHistory && historyEntry !== null) {
        mobileHistoryRef.current = null;
        if (historyEntry.popping && !historyEntry.closing && open && layout === 'mobile') {
          ownMobileHistory();
          return;
        }
        if (historyEntry.closing || !historyEntry.popping) {
          if (!historyEntry.closing) requestRef.current += 1;
          onClose();
        }
        return;
      }
      if (
        historyEntry !== null &&
        window.history.state?.lotusDriveFolderDialog === historyEntry.id
      ) {
        if (!historyEntry.closing) {
          historyEntry.closing = true;
          requestRef.current += 1;
        }
        if (!historyEntry.popping) {
          historyEntry.popping = true;
          window.history.back();
        }
        return;
      }
      if (historyEntry?.closing !== true) requestRef.current += 1;
      mobileHistoryRef.current = null;
      onClose();
    },
    [layout, onClose, open, ownMobileHistory]
  );

  const close = useCallback(() => finishClose(false), [finishClose]);

  const loadLocations = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await folderService.listLocations();
      if (request !== requestRef.current) return;
      setLocations(result);
    } catch (cause) {
      if (request === requestRef.current) setError(errorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [folderService]);

  const loadFolder = useCallback(
    async (
      nextLocation: DriveLocation,
      parentId: string,
      nextPath: DriveFileRecord[],
      pageToken?: string
    ): Promise<void> => {
      const request = ++requestRef.current;
      const appending = pageToken !== undefined;
      setLoading(true);
      setError(null);
      if (!appending) {
        setLocation(nextLocation);
        setPath(nextPath);
        setFolders([]);
        setNextPageToken(null);
      }
      try {
        const page: DriveFolderPage = await folderService.listChildren(
          nextLocation,
          parentId,
          pageToken
        );
        if (request !== requestRef.current) return;
        setFolders((current) => mergeFolders(appending ? current : [], page.folders));
        setNextPageToken(page.nextPageToken);
      } catch (cause) {
        if (request === requestRef.current) setError(errorMessage(cause));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [folderService]
  );

  useEffect(() => {
    if (!open) {
      requestRef.current += 1;
      return;
    }
    setPhase('landing');
    setLocations([]);
    setLocation(null);
    setPath([]);
    setFolders([]);
    setNextPageToken(null);
    setNewFolderName('');
    setCreating(false);
    setError(null);
    setStagedRoot(null);
    setCandidateScan(null);
    setScanFailed(false);
    setConfirming(false);
    confirmingRef.current = false;
    return () => {
      requestRef.current += 1;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirmingRef.current) return;
        close();
        return;
      }
      if (event.key !== 'Tab' || dialogRef.current === null) return;
      const controls = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)'
        ),
      ];
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    function handlePopState(event: PopStateEvent): void {
      if (mobileHistoryRef.current === null) return;
      event.stopImmediatePropagation();
      finishClose(true);
    }

    window.addEventListener('popstate', handlePopState, true);
    return () => window.removeEventListener('popstate', handlePopState, true);
  }, [finishClose, open]);

  useEffect(() => {
    if (!open) return;
    const historyEntry = mobileHistoryRef.current;
    if (layout === 'mobile') {
      if (historyEntry === null) ownMobileHistory();
      return;
    }
    if (
      historyEntry !== null &&
      !historyEntry.popping &&
      window.history.state?.lotusDriveFolderDialog === historyEntry.id
    ) {
      historyEntry.popping = true;
      window.history.back();
    }
  }, [layout, open, ownMobileHistory]);

  if (!open) return null;

  const currentFolder = path.at(-1) ?? null;
  const parentId = currentFolder?.id ?? location?.id ?? null;

  async function chooseLocation(nextLocation: DriveLocation): Promise<void> {
    await loadFolder(nextLocation, nextLocation.id, []);
  }

  async function enterFolder(folder: DriveFileRecord): Promise<void> {
    if (location === null) return;
    await loadFolder(location, folder.id, [...path, folder]);
  }

  async function goBack(): Promise<void> {
    if (location === null) return;
    if (path.length === 0) {
      requestRef.current += 1;
      setLocation(null);
      setFolders([]);
      setNextPageToken(null);
      setError(null);
      return;
    }
    const nextPath = path.slice(0, -1);
    await loadFolder(location, nextPath.at(-1)?.id ?? location.id, nextPath);
  }

  async function goToBreadcrumb(pathIndex: number): Promise<void> {
    if (location === null) return;
    if (pathIndex < 0) {
      await loadFolder(location, location.id, []);
      return;
    }
    const nextPath = path.slice(0, pathIndex + 1);
    await loadFolder(location, nextPath[pathIndex].id, nextPath);
  }

  async function createFolder(): Promise<void> {
    if (location === null || parentId === null || creating) return;
    const name = newFolderName.trim();
    if (name.length === 0) {
      setError('Enter a folder name.');
      return;
    }
    const request = ++requestRef.current;
    setCreating(true);
    setError(null);
    try {
      const created = await folderService.createChild(location, parentId, name);
      if (request !== requestRef.current) return;
      setNewFolderName('');
      setCreating(false);
      await loadFolder(location, created.id, [...path, created]);
    } catch (cause) {
      if (request === requestRef.current) setError(errorMessage(cause));
    } finally {
      if (request === requestRef.current) setCreating(false);
    }
  }

  async function openBrowser(): Promise<void> {
    setPhase('browse');
    await loadLocations();
  }

  async function stageFolder(
    folder: DriveFileRecord,
    failurePhase: 'landing' | 'browse'
  ): Promise<void> {
    const request = ++requestRef.current;
    setPhase('scanning');
    setError(null);
    setCandidateScan(null);
    setScanFailed(false);
    try {
      const staged = await folderService.stageRoot(folder);
      if (request !== requestRef.current) return;
      const scan = await scanCandidate(staged);
      if (request !== requestRef.current) return;
      setStagedRoot(staged);
      setCandidateScan(scan);
      setScanFailed(false);
      setPhase('confirm');
    } catch (cause) {
      if (request !== requestRef.current) return;
      setError(errorMessage(cause));
      setPhase(failurePhase);
    }
  }

  async function stageCandidate(): Promise<void> {
    if (currentFolder === null) return;
    await stageFolder(currentFolder, 'browse');
  }

  async function refreshScan(): Promise<void> {
    if (stagedRoot === null) return;
    const request = ++requestRef.current;
    setPhase('scanning');
    setError(null);
    setScanFailed(false);
    try {
      const scan = await scanCandidate(stagedRoot);
      if (request !== requestRef.current) return;
      setCandidateScan(scan);
      setScanFailed(false);
      setPhase('confirm');
    } catch (cause) {
      if (request !== requestRef.current) return;
      setError(errorMessage(cause));
      setScanFailed(true);
      setPhase('confirm');
    }
  }

  async function confirmCandidate(): Promise<void> {
    if (
      stagedRoot === null ||
      candidateScan === null ||
      candidateScan.blockingConflicts.length > 0 ||
      scanFailed ||
      confirmingRef.current
    ) {
      return;
    }
    confirmingRef.current = true;
    setConfirming(true);
    setError(null);
    const request = requestRef.current;
    try {
      await onConfirm(stagedRoot, legacyLastInvoice);
      if (request !== requestRef.current) return;
      close();
    } catch (cause) {
      if (request !== requestRef.current) return;
      setError(errorMessage(cause));
    } finally {
      if (request !== requestRef.current) return;
      confirmingRef.current = false;
      setConfirming(false);
    }
  }

  const recognizedCount =
    candidateScan?.entries.filter(
      (entry) => entry.state === 'fresh' || entry.state === 'stale' || entry.state === 'unmanaged'
    ).length ?? 0;
  const malformedCount =
    candidateScan?.entries.filter((entry) => entry.state === 'malformed').length ?? 0;
  const duplicateCount =
    candidateScan?.entries.filter((entry) => entry.state === 'duplicate').length ?? 0;
  const permissionCount =
    candidateScan?.entries.filter((entry) => entry.state === 'permission').length ?? 0;
  const corruptCount =
    candidateScan?.entries.filter((entry) => entry.state === 'corrupt').length ?? 0;

  return (
    <div
      className={`fixed inset-0 z-50 flex bg-black/30 p-4 ${
        layout === 'mobile' ? 'items-end p-0' : 'items-center justify-center'
      }`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={DESCRIPTION_ID}
        className={`drive-folder-dialog max-h-[calc(100dvh-2rem)] w-full overflow-y-auto bg-white p-5 shadow-xl ${
          layout === 'mobile'
            ? 'drive-folder-dialog--mobile max-h-[100dvh] rounded-t-2xl'
            : 'max-w-2xl rounded-lg border border-gray-200'
        }`}
      >
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 id={TITLE_ID} className="text-lg font-semibold text-gray-900">
              Choose Drive invoice folder
            </h2>
            <p id={DESCRIPTION_ID} className="mt-1 text-sm text-gray-600">
              Choose a root folder. Lotus uses its direct Final folder for finalized invoices.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={close}
            disabled={confirming}
            className={`${touchClass} rounded px-3 py-2 text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500`}
          >
            ×
          </button>
        </div>

        {phase === 'landing' && (
          <div className="mt-5 flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-gray-700">Detected Lotus folders</h3>
            {detectedFolders.length === 0 ? (
              <p className="text-sm text-gray-500">No Lotus folders detected</p>
            ) : (
              <div className="grid gap-2">
                {detectedFolders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => void stageFolder(folder, 'landing')}
                    className={`${touchClass} rounded border border-gray-200 px-3 py-2 text-left text-sm font-medium text-gray-800 hover:bg-indigo-50`}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => void openBrowser()}
              className={`${touchClass} rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white`}
            >
              Create / Select folder…
            </button>
            {error !== null && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
          </div>
        )}

        {phase === 'browse' && (
          <div className="mt-5 flex flex-col gap-4">
            {location === null ? (
              <>
                <h3 className="text-sm font-semibold text-gray-700">Drive locations</h3>
                {loading && locations.length === 0 ? (
                  <p role="status" className="text-sm text-gray-500">
                    Loading Drive locations…
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {locations.map((item) => (
                      <button
                        key={`${item.kind}:${item.id}`}
                        type="button"
                        onClick={() => void chooseLocation(item)}
                        disabled={loading}
                        className={`${touchClass} rounded border border-gray-200 px-3 py-2 text-left text-sm font-medium text-gray-800 hover:bg-indigo-50 disabled:opacity-40`}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <nav aria-label="Drive folder path" className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void goBack()}
                    disabled={loading || creating}
                    className={`${touchClass} rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40`}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      requestRef.current += 1;
                      setLocation(null);
                      setPath([]);
                      setFolders([]);
                      setNextPageToken(null);
                      setError(null);
                    }}
                    disabled={loading || creating}
                    className={`${touchClass} rounded px-2 py-1 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-40`}
                  >
                    Drive locations
                  </button>
                  <span aria-hidden="true" className="text-gray-400">
                    /
                  </span>
                  {path.length === 0 ? (
                    <span aria-current="page" className="px-2 text-sm font-medium text-gray-800">
                      {location.name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void goToBreadcrumb(-1)}
                      disabled={loading || creating}
                      className={`${touchClass} rounded px-2 py-1 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-40`}
                    >
                      {location.name}
                    </button>
                  )}
                  {path.map((folder, index) => (
                    <span key={folder.id} className="contents">
                      <span aria-hidden="true" className="text-gray-400">
                        /
                      </span>
                      {index === path.length - 1 ? (
                        <span
                          aria-current="page"
                          className="px-2 text-sm font-medium text-gray-800"
                        >
                          {folder.name}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void goToBreadcrumb(index)}
                          disabled={loading || creating}
                          className={`${touchClass} rounded px-2 py-1 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-40`}
                        >
                          {folder.name}
                        </button>
                      )}
                    </span>
                  ))}
                </nav>

                <div className="rounded border border-gray-200">
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      onClick={() => void enterFolder(folder)}
                      disabled={loading || creating}
                      className={`${touchClass} block w-full border-b border-gray-100 px-3 py-2 text-left text-sm text-gray-800 last:border-b-0 hover:bg-indigo-50 disabled:opacity-40`}
                    >
                      {folder.name}
                    </button>
                  ))}
                  {!loading && folders.length === 0 && (
                    <p className="px-3 py-4 text-sm text-gray-500">No folders here</p>
                  )}
                </div>

                {nextPageToken !== null && parentId !== null && (
                  <button
                    type="button"
                    onClick={() => void loadFolder(location, parentId, path, nextPageToken)}
                    disabled={loading || creating}
                    className={`${touchClass} self-start rounded border border-gray-300 px-3 py-2 text-sm text-indigo-700 disabled:opacity-40`}
                  >
                    Load more folders
                  </button>
                )}

                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createFolder();
                  }}
                >
                  <label className="min-w-48 flex-1 text-sm text-gray-700">
                    New folder name
                    <input
                      type="text"
                      value={newFolderName}
                      onInput={(event) => setNewFolderName(event.currentTarget.value)}
                      disabled={loading || creating}
                      className={`${touchClass} mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:opacity-40`}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={loading || creating}
                    className={`${touchClass} self-end rounded border border-gray-300 px-3 py-2 text-sm font-medium text-indigo-700 disabled:opacity-40`}
                  >
                    {creating ? 'Creating…' : 'Create folder'}
                  </button>
                </form>

                {currentFolder !== null && (
                  <button
                    type="button"
                    onClick={() => void stageCandidate()}
                    disabled={loading || creating}
                    className={`${touchClass} rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40`}
                  >
                    Use this folder
                  </button>
                )}
              </>
            )}

            {error !== null && (
              <div className="flex flex-col items-start gap-2">
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
                {location === null && (
                  <button
                    type="button"
                    onClick={() => void loadLocations()}
                    className={`${touchClass} rounded border border-red-300 px-3 py-2 text-sm text-red-700`}
                  >
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {phase === 'scanning' && (
          <div className="mt-8 flex flex-col items-center gap-4 py-8" aria-live="polite">
            <p role="status" className="text-sm text-gray-600">
              Scanning Final folder…
            </p>
            <button
              type="button"
              onClick={close}
              className={`${touchClass} rounded px-3 py-2 text-sm text-gray-600 hover:bg-gray-100`}
            >
              Cancel
            </button>
          </div>
        )}

        {phase === 'confirm' && candidateScan !== null && stagedRoot !== null && (
          <div className="mt-5 flex flex-col gap-4">
            <div>
              <h3 className="font-semibold text-gray-900">Review {stagedRoot.root.folderName}</h3>
              <p className="mt-1 text-sm text-gray-600">
                Copy existing PDFs into {stagedRoot.finalFolder.name}, then refresh before
                activation.
              </p>
            </div>

            <ul className="grid gap-2 text-sm text-gray-700 sm:grid-cols-2">
              <li>{countLabel(recognizedCount, 'recognized invoice', 'recognized invoices')}</li>
              <li>{countLabel(malformedCount, 'malformed file', 'malformed files')}</li>
              <li>{countLabel(duplicateCount, 'duplicate invoice', 'duplicate invoices')}</li>
              <li>{countLabel(permissionCount, 'permission problem', 'permission problems')}</li>
              <li>{countLabel(corruptCount, 'corrupt file', 'corrupt files')}</li>
            </ul>

            {candidateScan.warnings.length > 0 && (
              <section aria-label="Scan warnings" className="rounded bg-amber-50 p-3">
                <h4 className="text-sm font-semibold text-amber-900">Warnings</h4>
                <ul className="mt-1 list-disc pl-5 text-sm text-amber-900">
                  {candidateScan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            )}

            {candidateScan.blockingConflicts.length > 0 && (
              <section role="alert" className="rounded bg-red-50 p-3 text-red-800">
                <h4 className="text-sm font-semibold">Resolve these conflicts first</h4>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {candidateScan.blockingConflicts.map((conflict) => (
                    <li key={conflict.message}>{conflict.message}</li>
                  ))}
                </ul>
              </section>
            )}

            {rootsDiffer(currentRoot, stagedRoot) && (
              <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">
                Activating this folder changes the invoice view on every device signed into this
                Google account. Files are not moved or deleted.
              </p>
            )}

            {error !== null && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={confirming}
                className={`${touchClass} rounded px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void refreshScan()}
                disabled={confirming}
                className={`${touchClass} rounded border border-gray-300 px-3 py-2 text-sm text-indigo-700 disabled:opacity-40`}
              >
                Refresh scan
              </button>
              <button
                type="button"
                onClick={() => void confirmCandidate()}
                disabled={candidateScan.blockingConflicts.length > 0 || scanFailed || confirming}
                className={`${touchClass} rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {confirming ? 'Activating…' : 'Activate for all devices'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
