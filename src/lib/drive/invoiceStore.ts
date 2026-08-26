import type { DriveApi } from './api.js';
import {
  commitReservation,
  DriveControlRepository,
  reserveExistingInvoice,
  reserveNextInvoice,
  type ControlDiscovery,
  type ControlSnapshot,
  type DriveControl,
  type InvoiceReservation,
} from './controlFile.js';
import {
  DriveFolderError,
  DriveFolderService,
  type DriveLocation,
  type StagedDriveRoot,
} from './folders.js';
import {
  scanFinalFolder,
  resolveCurrentInvoiceSource,
  type CurrentInvoiceSource,
  type DriveInvoiceConflict,
  type DriveInvoiceEntry,
  type DriveInvoiceScan,
} from './invoiceCatalog.js';
import {
  DriveError,
  type DriveFileRecord,
  type InvoiceKey,
  type LotusPdfProperties,
} from './types.js';
import {
  finalizedFilename,
  parseFinalizedInvoiceFilename,
  studioSlug,
} from '../invoice/finalization.js';
import { sha256Hex } from '../invoice/sourceFingerprint.js';
import type { AppConfig, Invoice, ParsedClass } from '../types.js';

const PDF_MIME_TYPE = 'application/pdf';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const INVOICE_NUMBER_PATTERN = /^([1-9]\d*)\/(\d{4})$/;
const LOTUS_PROPERTY_KEYS = [
  'lotusSchema',
  'lotusCalendarHash',
  'lotusStudioSlug',
  'lotusMonth',
  'lotusInvoiceNumber',
  'lotusSourceSha256',
  'lotusPdfSha256',
  'lotusOperationId',
] as const satisfies readonly (keyof LotusPdfProperties)[];

export interface FinalizationInput {
  key: InvoiceKey;
  invoice: Invoice;
  classes: readonly ParsedClass[];
  config: AppConfig;
}

export interface DriveStoreSnapshot {
  control: ControlSnapshot;
  stagedRoot: StagedDriveRoot;
  scan: DriveInvoiceScan;
}

export type DriveStoreErrorCode =
  | 'authorizationRequired'
  | 'unconfigured'
  | 'offline'
  | 'permission'
  | 'conflict'
  | 'corrupt'
  | 'duplicate'
  | 'recoveryRequired'
  | 'invalidState';

export class DriveStoreError extends Error {
  constructor(
    readonly code: DriveStoreErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'DriveStoreError';
  }
}

export interface DriveInvoiceStoreDependencies {
  renderFinalPdf(invoice: Invoice, config: AppConfig, invoiceNumber: string): Promise<Uint8Array>;
  createOperationId?(): string;
  generateFileId?(): Promise<string>;
  now?(): string;
}

interface ExactPdfExpectation {
  fileId: string;
  filename: string;
  parentId: string;
  driveId: string | null;
  properties: LotusPdfProperties;
  bytes?: Uint8Array;
}

interface ReservationReconciliation {
  relevant: DriveFileRecord[];
  coherentUploads: DriveFileRecord[];
  conflictingKeyFiles: DriveFileRecord[];
  operationFiles: DriveFileRecord[];
}

function cloneFile(file: DriveFileRecord): DriveFileRecord {
  return {
    ...file,
    parents: [...file.parents],
    properties: { ...file.properties },
    capabilities: { ...file.capabilities },
  };
}

function snapshotValue<T>(value: T, message: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw invalidState(message);
  }
}

function snapshotSources(sources: readonly CurrentInvoiceSource[]): CurrentInvoiceSource[] {
  return snapshotValue([...sources], 'Current invoice sources could not be snapshotted');
}

function snapshotInput(input: FinalizationInput): FinalizationInput {
  return snapshotValue(input, 'Invoice finalization input could not be snapshotted');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidState(message: string): DriveStoreError {
  return new DriveStoreError('invalidState', message, false);
}

function recoveryRequired(message: string): DriveStoreError {
  return new DriveStoreError('recoveryRequired', message, false);
}

function keyEquals(left: InvoiceKey | null, right: InvoiceKey): boolean {
  return left?.studioSlug === right.studioSlug && left.monthKey === right.monthKey;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringMapsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function reservationsEqual(
  left: InvoiceReservation | null,
  right: InvoiceReservation | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.operationId === right.operationId &&
    left.year === right.year &&
    left.invoiceNumber === right.invoiceNumber &&
    left.studioSlug === right.studioSlug &&
    left.month === right.month &&
    left.fileId === right.fileId &&
    left.sourceSha256 === right.sourceSha256 &&
    left.startedAt === right.startedAt
  );
}

function isAmbiguousControlWriteFailure(error: unknown): boolean {
  if (!(error instanceof DriveError)) return false;
  if (error.code === 'authorization' || error.code === 'permission' || error.code === 'notFound') {
    return false;
  }
  return (
    error.retryable ||
    error.code === 'offline' ||
    error.code === 'rateLimited' ||
    error.code === 'server' ||
    error.code === 'invalidResponse' ||
    error.code === 'corrupt' ||
    (error.code === 'conflict' && error.status === 412)
  );
}

function isAmbiguousPdfUpdateFailure(error: unknown): boolean {
  return (
    error instanceof DriveError &&
    ((error.code === 'conflict' && error.status === 412) ||
      error.code === 'invalidResponse' ||
      error.code === 'corrupt')
  );
}

function isPrecisePdfUpdateFailure(error: unknown): boolean {
  return (
    error instanceof DriveError &&
    ((error.code === 'permission' && error.status === 403) ||
      (error.code === 'notFound' && error.status === 404))
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function capabilitiesEqual(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return (
    left.capabilities.canListChildren === right.capabilities.canListChildren &&
    left.capabilities.canAddChildren === right.capabilities.canAddChildren &&
    left.capabilities.canEdit === right.capabilities.canEdit &&
    left.capabilities.canDownload === right.capabilities.canDownload
  );
}

function fileAuthorityEqual(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    stringArraysEqual(left.parents, right.parents) &&
    left.driveId === right.driveId &&
    left.ownedByMe === right.ownedByMe &&
    left.trashed === right.trashed &&
    left.version === right.version &&
    left.size === right.size &&
    left.md5Checksum === right.md5Checksum &&
    left.sha256Checksum === right.sha256Checksum &&
    stringMapsEqual(left.properties, right.properties) &&
    capabilitiesEqual(left, right)
  );
}

function selectedAuthorityEqual(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return (
    fileAuthorityEqual(left, right) &&
    (left.etag === null || right.etag === null || left.etag === right.etag)
  );
}

function exactAuthorityEqual(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return fileAuthorityEqual(left, right) && left.etag === right.etag;
}

function mapLowerError(error: unknown): DriveStoreError {
  if (error instanceof DriveStoreError) return error;
  if (error instanceof DriveFolderError) {
    return new DriveStoreError('duplicate', 'Drive root contains duplicate Final folders', false);
  }
  if (error instanceof DriveError) {
    switch (error.code) {
      case 'authorization':
        return new DriveStoreError(
          'authorizationRequired',
          'Google Drive authorization is required',
          true
        );
      case 'offline':
      case 'rateLimited':
      case 'server':
        return new DriveStoreError('offline', 'Google Drive is temporarily unavailable', true);
      case 'permission':
        return new DriveStoreError('permission', 'Google Drive permission is insufficient', false);
      case 'conflict':
        return new DriveStoreError(
          'conflict',
          'Google Drive content changed; refresh before retrying',
          error.status === 412 || error.retryable
        );
      case 'notFound':
      case 'invalidResponse':
      case 'corrupt':
        return new DriveStoreError('corrupt', 'Google Drive invoice state is invalid', false);
    }
  }
  return invalidState('Drive invoice operation could not be completed');
}

function requireFolder(file: DriveFileRecord, expectedId: string): DriveFileRecord {
  if (
    file.id !== expectedId ||
    file.mimeType !== FOLDER_MIME_TYPE ||
    file.trashed ||
    !isNonEmptyString(file.name) ||
    !(file.driveId === null || isNonEmptyString(file.driveId))
  ) {
    throw new DriveStoreError('corrupt', 'Recorded Drive folder is invalid', false);
  }
  return file;
}

function requireReconciliationFile(value: unknown, stagedRoot: StagedDriveRoot): DriveFileRecord {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    typeof value.name !== 'string' ||
    !isNonEmptyString(value.mimeType) ||
    !Array.isArray(value.parents) ||
    value.parents.length !== 1 ||
    value.parents[0] !== stagedRoot.finalFolder.id ||
    value.driveId !== stagedRoot.root.driveId ||
    value.trashed !== false ||
    !isNonEmptyString(value.version) ||
    !isRecord(value.properties) ||
    !Object.values(value.properties).every((property) => typeof property === 'string') ||
    !isRecord(value.capabilities) ||
    typeof value.capabilities.canListChildren !== 'boolean' ||
    typeof value.capabilities.canAddChildren !== 'boolean' ||
    typeof value.capabilities.canEdit !== 'boolean' ||
    typeof value.capabilities.canDownload !== 'boolean' ||
    !(value.etag === null || isNonEmptyString(value.etag))
  ) {
    throw new DriveError('invalidResponse', 'Drive returned an invalid recovery file', false);
  }
  return cloneFile(value as unknown as DriveFileRecord);
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function requirePdfProperties(properties: Readonly<Record<string, string>>): LotusPdfProperties {
  if (!LOTUS_PROPERTY_KEYS.every((key) => typeof properties[key] === 'string')) {
    throw new DriveStoreError('corrupt', 'Drive invoice properties are incomplete', false);
  }
  const result = properties as unknown as LotusPdfProperties;
  if (
    result.lotusSchema !== '1' ||
    !HASH_PATTERN.test(result.lotusCalendarHash) ||
    !HASH_PATTERN.test(result.lotusSourceSha256) ||
    !HASH_PATTERN.test(result.lotusPdfSha256) ||
    !isNonEmptyString(result.lotusStudioSlug) ||
    !isNonEmptyString(result.lotusMonth) ||
    !isNonEmptyString(result.lotusInvoiceNumber) ||
    !isNonEmptyString(result.lotusOperationId)
  ) {
    throw new DriveStoreError('corrupt', 'Drive invoice properties are invalid', false);
  }
  return { ...result };
}

function requirePdfRecord(
  file: DriveFileRecord,
  expectation: ExactPdfExpectation
): DriveFileRecord {
  if (
    file.id !== expectation.fileId ||
    file.name !== expectation.filename ||
    file.mimeType !== PDF_MIME_TYPE ||
    file.parents.length !== 1 ||
    file.parents[0] !== expectation.parentId ||
    file.driveId !== expectation.driveId ||
    file.trashed ||
    !isNonEmptyString(file.version) ||
    !isNonEmptyString(file.etag) ||
    file.size === null ||
    !/^\d+$/.test(file.size) ||
    !file.capabilities.canDownload ||
    !file.capabilities.canEdit ||
    !stringMapsEqual(file.properties, { ...expectation.properties })
  ) {
    throw new DriveStoreError('corrupt', 'Drive invoice upload identity is invalid', false);
  }
  requirePdfProperties(file.properties);
  if (expectation.bytes !== undefined && file.size !== String(expectation.bytes.byteLength)) {
    throw new DriveStoreError('corrupt', 'Drive invoice upload size is invalid', false);
  }
  return file;
}

function parseLegacyLastInvoice(
  value: string | undefined
): { year: string; sequence: number } | null {
  if (value === undefined || value.trim().length === 0) return null;
  const match = INVOICE_NUMBER_PATTERN.exec(value);
  const sequence = match == null ? Number.NaN : Number(match[1]);
  const year = match?.[2];
  if (
    year === undefined ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    Number(year) < 1 ||
    Number(year) > 9999
  ) {
    throw invalidState('Legacy invoice number must use the exact N/YYYY format');
  }
  return { year, sequence };
}

function defaultOperationId(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (!isNonEmptyString(value))
    throw invalidState('An invoice operation ID could not be generated');
  return value;
}

export class DriveInvoiceStore {
  private readonly repository: DriveControlRepository;
  private readonly folderService: DriveFolderService;
  private readonly createOperationId: () => string;
  private readonly now: () => string;
  private readonly generateFileId: () => Promise<string>;
  private currentSources: CurrentInvoiceSource[] = [];

  constructor(
    private readonly api: DriveApi,
    private readonly dependencies: DriveInvoiceStoreDependencies
  ) {
    this.repository = new DriveControlRepository(api);
    this.folderService = new DriveFolderService(api);
    this.createOperationId = dependencies.createOperationId ?? defaultOperationId;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.generateFileId =
      dependencies.generateFileId ??
      (async () => {
        const ids = await this.api.generateFileIds(1);
        if (ids.length !== 1 || !isNonEmptyString(ids[0])) {
          throw new DriveError('invalidResponse', 'Drive returned invalid generated IDs', false);
        }
        return ids[0];
      });
  }

  async bootstrap(sources: readonly CurrentInvoiceSource[]): Promise<DriveStoreSnapshot | null> {
    const exactSources = snapshotSources(sources);
    try {
      const discovery = await this.repository.discover();
      if (discovery.kind === 'unconfigured') {
        this.currentSources = exactSources;
        return null;
      }
      if (discovery.kind === 'conflict') {
        throw new DriveStoreError(
          'duplicate',
          'Multiple Drive control files are configured',
          false
        );
      }
      return await this.loadConfigured(discovery.snapshot, exactSources);
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async activateRoot(
    staged: StagedDriveRoot,
    sources: readonly CurrentInvoiceSource[],
    legacyLastInvoice: string | undefined
  ): Promise<DriveStoreSnapshot> {
    const exactStagedInput = snapshotValue(staged, 'Staged Drive root could not be snapshotted');
    const exactSources = snapshotSources(sources);
    try {
      const discovery = await this.repository.discover();
      if (discovery.kind === 'conflict') {
        throw new DriveStoreError(
          'duplicate',
          'Multiple Drive control files are configured',
          false
        );
      }
      if (discovery.kind === 'configured' && discovery.snapshot.control.reservation !== null) {
        throw recoveryRequired('Recover the active invoice reservation before changing Drive root');
      }

      const legacy = parseLegacyLastInvoice(legacyLastInvoice);
      const exactStaged = await this.loadStagedRoot({
        schemaVersion: 1,
        generation: 0,
        root: { ...exactStagedInput.root },
        finalFolderId: exactStagedInput.finalFolder.id,
        sequenceByYear: {},
        reservation: null,
      });
      const scan = await scanFinalFolder(this.api, exactStaged, exactSources);
      this.requireScanCanActivate(scan);

      const sequenceByYear: Record<string, number> =
        discovery.kind === 'configured' ? { ...discovery.snapshot.control.sequenceByYear } : {};
      for (const [year, sequence] of Object.entries(scan.maxSequenceByYear)) {
        sequenceByYear[year] = Math.max(sequenceByYear[year] ?? 0, sequence);
      }
      if (legacy !== null) {
        sequenceByYear[legacy.year] = Math.max(sequenceByYear[legacy.year] ?? 0, legacy.sequence);
      }

      const control: DriveControl = {
        schemaVersion: 1,
        generation: discovery.kind === 'configured' ? discovery.snapshot.control.generation : 0,
        root: { ...exactStaged.root },
        finalFolderId: exactStaged.finalFolder.id,
        sequenceByYear,
        reservation: null,
      };
      const saved =
        discovery.kind === 'configured'
          ? await this.repository.replace(discovery.snapshot, control)
          : await this.repository.create(control);
      return await this.loadConfigured(saved, exactSources);
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async refresh(sources: readonly CurrentInvoiceSource[]): Promise<DriveStoreSnapshot> {
    const exactSources = snapshotSources(sources);
    try {
      return await this.refreshInternal(exactSources);
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async finalize(input: FinalizationInput): Promise<DriveInvoiceEntry> {
    const exactInput = snapshotInput(input);
    let reserved: ControlSnapshot | null = null;
    try {
      const snapshot = await this.refreshInternal(this.currentSources);
      if (snapshot.control.control.reservation !== null) {
        throw recoveryRequired('Recover the active invoice reservation before finalizing');
      }
      this.requireScanCanMutate(snapshot.scan, exactInput.key);
      if (snapshot.scan.entries.some((entry) => keyEquals(entry.key, exactInput.key))) {
        throw new DriveStoreError(
          'duplicate',
          'An invoice already exists for this studio and month',
          false
        );
      }

      const year = this.requireInputYear(exactInput);
      const sequence = snapshot.control.control.sequenceByYear[String(year)] ?? 0;
      if (sequence === Number.MAX_SAFE_INTEGER) {
        throw new DriveStoreError('corrupt', 'Invoice sequence cannot be incremented', false);
      }
      const invoiceNumber = `${sequence + 1}/${year}`;
      const source = await this.sourceForInput(exactInput, invoiceNumber);
      const operationId = this.requireGeneratedValue(this.createOperationId(), 'operation');
      const fileId = this.requireGeneratedValue(await this.generateFileId(), 'file');
      const startedAt = this.requireTimestamp(this.now());

      const proposed = reserveNextInvoice(snapshot.control, {
        operationId,
        year,
        studioSlug: exactInput.key.studioSlug,
        month: exactInput.key.monthKey,
        fileId,
        sourceSha256: source.fingerprint.sourceSha256,
        startedAt,
      });
      try {
        reserved = await this.repository.replace(snapshot.control, proposed.control);
      } catch (error) {
        await this.throwReservationWriteFailure(
          proposed,
          error,
          'Invoice reservation changed; refresh before retrying'
        );
      }

      const bytes = await this.renderReserved(source, invoiceNumber);
      const properties = await this.pdfProperties(source, invoiceNumber, operationId, bytes);
      const expectation = this.pdfExpectation(
        snapshot.stagedRoot,
        fileId,
        invoiceNumber,
        exactInput.key,
        properties,
        bytes
      );
      let created: DriveFileRecord;
      try {
        created = await this.api.createFile({
          fileId,
          name: expectation.filename,
          mimeType: PDF_MIME_TYPE,
          parents: [expectation.parentId],
          properties: { ...properties },
          bytes: Array.from(bytes),
          supportsAllDrives: true,
        });
      } catch {
        throw recoveryRequired(
          'Invoice upload response was not confirmed; recover the reservation'
        );
      }
      try {
        await this.verifyUploadedPdf(created, expectation);
      } catch {
        throw recoveryRequired('Invoice upload could not be verified; recover the reservation');
      }

      try {
        const committed = commitReservation(reserved!, operationId);
        await this.repository.replace(reserved!, committed.control);
        reserved = null;
      } catch {
        throw recoveryRequired('Invoice upload is reserved but sequence commit was not confirmed');
      }

      const postSources = this.replaceSource(this.currentSources, source);
      const refreshed = await this.refreshInternal(postSources);
      return this.requireFreshResult(refreshed.scan, fileId);
    } catch (error) {
      if (
        reserved !== null &&
        (!(error instanceof DriveStoreError) || error.code !== 'recoveryRequired')
      ) {
        throw recoveryRequired('Invoice reservation requires recovery');
      }
      throw mapLowerError(error);
    }
  }

  async refinalize(
    input: FinalizationInput,
    expectedEntry: DriveInvoiceEntry
  ): Promise<DriveInvoiceEntry> {
    const exactInput = snapshotInput(input);
    const exactExpectedEntry = snapshotValue(
      expectedEntry,
      'Selected Drive invoice could not be snapshotted'
    );
    let lease: ControlSnapshot | null = null;
    try {
      if (exactExpectedEntry.state !== 'stale' || exactExpectedEntry.key === null) {
        throw invalidState('Only one selected stale invoice can be re-finalized');
      }
      if (
        !keyEquals(exactExpectedEntry.key, exactInput.key) ||
        exactExpectedEntry.invoiceNumber === null
      ) {
        throw invalidState('Selected invoice does not match the re-finalization input');
      }

      const snapshot = await this.refreshInternal(this.currentSources);
      if (snapshot.control.control.reservation !== null) {
        throw recoveryRequired('Recover the active invoice reservation before re-finalizing');
      }
      this.requireScanCanMutate(snapshot.scan, exactInput.key);
      const selected = snapshot.scan.entries.filter(
        (entry) => entry.file.id === exactExpectedEntry.file.id
      );
      if (
        selected.length !== 1 ||
        selected[0].state !== 'stale' ||
        !keyEquals(selected[0].key, exactInput.key) ||
        selected[0].invoiceNumber !== exactExpectedEntry.invoiceNumber ||
        !selectedAuthorityEqual(exactExpectedEntry.file, selected[0].file)
      ) {
        throw new DriveStoreError('conflict', 'Selected Drive invoice changed', false);
      }

      const exact = await this.api.getFile({
        fileId: selected[0].file.id,
        supportsAllDrives: true,
      });
      if (!selectedAuthorityEqual(selected[0].file, exact) || !isNonEmptyString(exact.etag)) {
        throw new DriveStoreError('conflict', 'Selected Drive invoice changed', false);
      }
      if (!exact.capabilities.canEdit) {
        throw new DriveStoreError(
          'permission',
          'Edit access is required to re-finalize this Drive invoice',
          false
        );
      }
      await this.downloadAndVerifyExact(exact);

      const operationId = this.requireGeneratedValue(this.createOperationId(), 'operation');
      const startedAt = this.requireTimestamp(this.now());
      const source = await this.sourceForInput(exactInput, exactExpectedEntry.invoiceNumber);
      const proposed = reserveExistingInvoice(snapshot.control, {
        operationId,
        year: this.requireInputYear(exactInput),
        invoiceNumber: exactExpectedEntry.invoiceNumber,
        studioSlug: exactInput.key.studioSlug,
        month: exactInput.key.monthKey,
        fileId: exact.id,
        sourceSha256: source.fingerprint.sourceSha256,
        startedAt,
      });
      try {
        lease = await this.repository.replace(snapshot.control, proposed.control);
      } catch (error) {
        await this.throwReservationWriteFailure(
          proposed,
          error,
          'Invoice mutation lease changed; refresh before retrying'
        );
      }

      const bytes = await this.renderReserved(source, exactExpectedEntry.invoiceNumber);
      const lotusProperties = await this.pdfProperties(
        source,
        exactExpectedEntry.invoiceNumber,
        operationId,
        bytes
      );
      const properties = { ...exact.properties, ...lotusProperties } as LotusPdfProperties;
      const expectation: ExactPdfExpectation = {
        fileId: exact.id,
        filename: exact.name,
        parentId: snapshot.stagedRoot.finalFolder.id,
        driveId: snapshot.stagedRoot.root.driveId,
        properties,
        bytes,
      };
      let updated: DriveFileRecord;
      try {
        updated = await this.api.updateFile({
          fileId: exact.id,
          name: exact.name,
          mimeType: PDF_MIME_TYPE,
          parents: [snapshot.stagedRoot.finalFolder.id],
          properties: { ...properties },
          bytes: Array.from(bytes),
          supportsAllDrives: true,
          ifMatch: exact.etag,
        });
      } catch (error) {
        if (isAmbiguousPdfUpdateFailure(error)) {
          let applied: boolean;
          try {
            applied = await this.verifyAmbiguousPdfUpdate(expectation);
          } catch {
            throw recoveryRequired(
              'Re-finalization update could not be reconciled; recover the lease'
            );
          }
          await this.releaseExistingLease(lease!, operationId);
          lease = null;
          if (!applied) {
            throw new DriveStoreError('conflict', 'Selected Drive invoice changed', true);
          }
          const refreshed = await this.refreshInternal(
            this.replaceSource(this.currentSources, source)
          );
          return this.requireFreshResult(refreshed.scan, exact.id);
        }
        if (isPrecisePdfUpdateFailure(error)) {
          const mapped = mapLowerError(error);
          await this.releaseExistingLease(lease!, operationId);
          lease = null;
          throw mapped;
        }
        throw recoveryRequired('Re-finalization update was not confirmed; recover the lease');
      }
      try {
        await this.verifyUploadedPdf(updated, expectation);
      } catch {
        throw recoveryRequired('Re-finalization update could not be verified; recover the lease');
      }

      try {
        const committed = commitReservation(lease!, operationId);
        await this.repository.replace(lease!, committed.control);
        lease = null;
      } catch {
        throw recoveryRequired('Re-finalization is visible but lease release was not confirmed');
      }

      const refreshed = await this.refreshInternal(this.replaceSource(this.currentSources, source));
      return this.requireFreshResult(refreshed.scan, exact.id);
    } catch (error) {
      if (
        lease !== null &&
        (!(error instanceof DriveStoreError) || error.code !== 'recoveryRequired')
      ) {
        throw recoveryRequired('Re-finalization lease requires recovery');
      }
      throw mapLowerError(error);
    }
  }

  async recoverReservation(sources: readonly CurrentInvoiceSource[]): Promise<DriveStoreSnapshot> {
    const exactSources = snapshotSources(sources);
    try {
      const discovery = await this.repository.discover();
      if (discovery.kind === 'unconfigured') {
        throw new DriveStoreError('unconfigured', 'Drive invoice storage is not configured', false);
      }
      if (discovery.kind === 'conflict') {
        throw new DriveStoreError(
          'duplicate',
          'Multiple Drive control files are configured',
          false
        );
      }
      const reservation = discovery.snapshot.control.reservation;
      if (reservation === null) return await this.loadConfigured(discovery.snapshot, exactSources);

      const stagedRoot = await this.loadStagedRoot(discovery.snapshot.control);
      const reconciliation = await this.reconcileReservation(stagedRoot, reservation);
      if (reconciliation.conflictingKeyFiles.length > 0) {
        throw recoveryRequired('Another Drive invoice matches the reserved studio and month');
      }
      if (reconciliation.relevant.length > 1 || reconciliation.coherentUploads.length > 1) {
        throw recoveryRequired('Multiple uploads match the active invoice reservation');
      }
      if (reconciliation.operationFiles.length > 0 && reconciliation.coherentUploads.length === 0) {
        throw recoveryRequired('An incoherent upload matches the active reservation operation');
      }
      const currentSequence =
        discovery.snapshot.control.sequenceByYear[String(reservation.year)] ?? 0;
      const reservedSequence = Number(reservation.invoiceNumber.split('/')[0]);
      const isRefinalization = reservedSequence <= currentSequence;
      let recoverySources = exactSources;

      if (reconciliation.coherentUploads.length === 1 && reconciliation.relevant.length === 1) {
        await this.verifyRecoveryUpload(reconciliation.coherentUploads[0], stagedRoot, reservation);
      } else if (isRefinalization) {
        const committed = await this.releaseExistingLease(
          discovery.snapshot,
          reservation.operationId
        );
        return await this.loadConfigured(committed, exactSources, false);
      } else {
        const source = await this.sourceForReservation(exactSources, reservation);
        if (source === null || source.fingerprint.sourceSha256 !== reservation.sourceSha256) {
          throw recoveryRequired('Current invoice source does not match the active reservation');
        }
        recoverySources = this.replaceSource(exactSources, source);
        const bytes = await this.renderReserved(source, reservation.invoiceNumber);
        const lotusProperties = await this.pdfProperties(
          source,
          reservation.invoiceNumber,
          reservation.operationId,
          bytes
        );
        if (reconciliation.relevant.length !== 0) {
          throw recoveryRequired('Drive state conflicts with the new invoice reservation');
        }
        const expectation = this.pdfExpectation(
          stagedRoot,
          reservation.fileId,
          reservation.invoiceNumber,
          { studioSlug: reservation.studioSlug, monthKey: reservation.month },
          lotusProperties,
          bytes
        );
        let created: DriveFileRecord;
        try {
          created = await this.api.createFile({
            fileId: reservation.fileId,
            name: expectation.filename,
            mimeType: PDF_MIME_TYPE,
            parents: [expectation.parentId],
            properties: { ...lotusProperties },
            bytes: Array.from(bytes),
            supportsAllDrives: true,
          });
        } catch {
          throw recoveryRequired('Reservation upload response was not confirmed');
        }
        try {
          await this.verifyUploadedPdf(created, expectation);
        } catch {
          throw recoveryRequired('Reservation upload could not be verified');
        }
      }

      let committed: ControlSnapshot;
      try {
        const proposed = commitReservation(discovery.snapshot, reservation.operationId);
        committed = await this.repository.replace(discovery.snapshot, proposed.control);
      } catch {
        throw recoveryRequired('Reservation upload is visible but commit was not confirmed');
      }
      return await this.loadConfigured(committed, recoverySources);
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async downloadVerified(entry: DriveInvoiceEntry): Promise<Uint8Array> {
    const exactEntry = snapshotValue(entry, 'Selected Drive invoice could not be snapshotted');
    try {
      if (
        (exactEntry.state !== 'fresh' && exactEntry.state !== 'stale') ||
        exactEntry.key === null
      ) {
        throw invalidState('Only one verified Drive invoice can be downloaded');
      }
      const snapshot = await this.refreshInternal(this.currentSources);
      if (snapshot.control.control.reservation !== null) {
        throw recoveryRequired('Recover the active invoice reservation before downloading');
      }
      const selected = snapshot.scan.entries.filter(
        (candidate) => candidate.file.id === exactEntry.file.id
      );
      if (
        selected.length !== 1 ||
        selected[0].state !== exactEntry.state ||
        !keyEquals(selected[0].key, exactEntry.key) ||
        !selectedAuthorityEqual(exactEntry.file, selected[0].file)
      ) {
        throw new DriveStoreError('conflict', 'Selected Drive invoice changed', false);
      }
      const exact = await this.api.getFile({
        fileId: exactEntry.file.id,
        supportsAllDrives: true,
      });
      if (!selectedAuthorityEqual(selected[0].file, exact)) {
        throw new DriveStoreError('conflict', 'Selected Drive invoice changed', false);
      }
      const bytes = await this.downloadAndVerifyExact(exact);
      const after = await this.api.getFile({ fileId: exact.id, supportsAllDrives: true });
      if (!exactAuthorityEqual(exact, after)) {
        throw new DriveStoreError('conflict', 'Drive invoice changed during verification', false);
      }
      return bytes;
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  private async throwReservationWriteFailure(
    proposed: ControlSnapshot,
    error: unknown,
    conflictMessage: string
  ): Promise<never> {
    const mapped = mapLowerError(error);
    if (!isAmbiguousControlWriteFailure(error)) throw mapped;

    let discovery: ControlDiscovery;
    try {
      discovery = await this.repository.discover();
    } catch {
      throw recoveryRequired('Drive control state could not be reloaded after the write attempt');
    }
    if (
      discovery.kind === 'configured' &&
      reservationsEqual(discovery.snapshot.control.reservation, proposed.control.reservation)
    ) {
      throw recoveryRequired('Drive invoice reservation was installed but not confirmed');
    }
    if (discovery.kind === 'configured') {
      try {
        await this.loadConfigured(discovery.snapshot, this.currentSources);
      } catch {
        throw recoveryRequired('Drive control state could not be reloaded after the write attempt');
      }
    }
    throw new DriveStoreError('conflict', conflictMessage, true);
  }

  private async verifyAmbiguousPdfUpdate(expectation: ExactPdfExpectation): Promise<boolean> {
    const exact = await this.api.getFile({
      fileId: expectation.fileId,
      supportsAllDrives: true,
    });
    const downloaded = await this.downloadAndVerifyExact(exact);
    try {
      requirePdfRecord(exact, expectation);
    } catch (error) {
      if (error instanceof DriveStoreError && error.code === 'corrupt') return false;
      throw error;
    }
    return expectation.bytes === undefined || bytesEqual(downloaded, expectation.bytes);
  }

  private async releaseExistingLease(
    lease: ControlSnapshot,
    operationId: string
  ): Promise<ControlSnapshot> {
    try {
      const cleared = commitReservation(lease, operationId);
      return await this.repository.replace(lease, cleared.control);
    } catch {
      throw recoveryRequired('Re-finalization lease cleanup was not confirmed');
    }
  }

  private async refreshInternal(
    sources: readonly CurrentInvoiceSource[]
  ): Promise<DriveStoreSnapshot> {
    const discovery = await this.repository.discover();
    if (discovery.kind === 'unconfigured') {
      throw new DriveStoreError('unconfigured', 'Drive invoice storage is not configured', false);
    }
    if (discovery.kind === 'conflict') {
      throw new DriveStoreError('duplicate', 'Multiple Drive control files are configured', false);
    }
    return this.loadConfigured(discovery.snapshot, sources);
  }

  private async loadConfigured(
    control: ControlSnapshot,
    sources: readonly CurrentInvoiceSource[],
    adoptManual = true
  ): Promise<DriveStoreSnapshot> {
    const stagedRoot = await this.loadStagedRoot(control.control);
    const scan = await scanFinalFolder(this.api, stagedRoot, sources, { adoptManual });
    const snapshot = { control, stagedRoot, scan };
    this.currentSources = snapshotSources(sources);
    return snapshot;
  }

  private async loadStagedRoot(control: DriveControl): Promise<StagedDriveRoot> {
    const rootFile = requireFolder(
      await this.api.getFile({ fileId: control.root.folderId, supportsAllDrives: true }),
      control.root.folderId
    );
    const finalFolder = requireFolder(
      await this.api.getFile({ fileId: control.finalFolderId, supportsAllDrives: true }),
      control.finalFolderId
    );
    if (
      rootFile.driveId !== control.root.driveId ||
      !rootFile.capabilities.canListChildren ||
      !rootFile.capabilities.canAddChildren
    ) {
      throw new DriveStoreError('corrupt', 'Recorded Drive root is no longer usable', false);
    }
    if (
      finalFolder.name !== 'Final' ||
      finalFolder.driveId !== control.root.driveId ||
      finalFolder.parents.length !== 1 ||
      finalFolder.parents[0] !== rootFile.id ||
      !finalFolder.capabilities.canListChildren ||
      !finalFolder.capabilities.canAddChildren ||
      !finalFolder.capabilities.canEdit
    ) {
      throw new DriveStoreError('corrupt', 'Recorded Final folder is no longer usable', false);
    }

    const location: DriveLocation =
      control.root.driveId === null
        ? { kind: 'myDrive', id: 'root', name: 'My Drive', driveId: null }
        : {
            kind: 'sharedDrive',
            id: control.root.driveId,
            name: control.root.driveId,
            driveId: control.root.driveId,
          };
    const finals = new Map<string, DriveFileRecord>();
    let pageToken: string | undefined;
    do {
      const page = await this.folderService.listChildren(location, rootFile.id, pageToken);
      for (const child of page.folders) {
        if (child.name === 'Final') finals.set(child.id, child);
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken !== undefined);
    if (finals.size > 1) {
      throw new DriveStoreError('duplicate', 'Drive root contains duplicate Final folders', false);
    }
    if (finals.size !== 1 || !finals.has(finalFolder.id)) {
      throw new DriveStoreError('corrupt', 'Recorded Final folder is not the direct child', false);
    }
    return {
      root: { ...control.root, folderName: rootFile.name },
      rootFile: cloneFile(rootFile),
      finalFolder: cloneFile(finalFolder),
    };
  }

  private async reconcileReservation(
    stagedRoot: StagedDriveRoot,
    reservation: InvoiceReservation
  ): Promise<ReservationReconciliation> {
    const filesById = new Map<string, DriveFileRecord>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.api.listFiles({
        query: `'${escapeDriveQueryString(stagedRoot.finalFolder.id)}' in parents and trashed = false`,
        corpora: stagedRoot.root.driveId === null ? 'user' : 'drive',
        ...(stagedRoot.root.driveId === null ? {} : { driveId: stagedRoot.root.driveId }),
        ...(pageToken === undefined ? {} : { pageToken }),
        pageSize: 100,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw new DriveError('invalidResponse', 'Drive returned an invalid recovery page', false);
      }
      for (const item of page.items) {
        const file = requireReconciliationFile(item, stagedRoot);
        const existing = filesById.get(file.id);
        if (existing !== undefined && !selectedAuthorityEqual(existing, file)) {
          throw new DriveError(
            'invalidResponse',
            'Drive returned inconsistent recovery records',
            false,
            undefined,
            file.id
          );
        }
        if (existing === undefined) filesById.set(file.id, file);
      }
      if (page.nextPageToken === null) break;
      if (
        !isNonEmptyString(page.nextPageToken) ||
        page.nextPageToken === pageToken ||
        seenPageTokens.has(page.nextPageToken)
      ) {
        throw new DriveError(
          'invalidResponse',
          'Drive returned an invalid recovery page token',
          false
        );
      }
      seenPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    } while (true);

    const expectedFilename = this.pdfExpectation(
      stagedRoot,
      reservation.fileId,
      reservation.invoiceNumber,
      { studioSlug: reservation.studioSlug, monthKey: reservation.month },
      {
        lotusSchema: '1',
        lotusCalendarHash: '0'.repeat(64),
        lotusStudioSlug: reservation.studioSlug,
        lotusMonth: reservation.month,
        lotusInvoiceNumber: reservation.invoiceNumber,
        lotusSourceSha256: reservation.sourceSha256,
        lotusPdfSha256: '0'.repeat(64),
        lotusOperationId: reservation.operationId,
      }
    ).filename;
    const files = [...filesById.values()];
    const sameKeyFiles = files.filter((file) => {
      const parsed = parseFinalizedInvoiceFilename(file.name);
      return (
        parsed !== null &&
        parsed.studioSlug === reservation.studioSlug &&
        parsed.monthKey === reservation.month
      );
    });
    const conflictingKeyFiles = sameKeyFiles.filter((file) => file.id !== reservation.fileId);
    const operationFiles = files.filter(
      (file) => file.properties.lotusOperationId === reservation.operationId
    );
    const relevant = files.filter(
      (file) =>
        file.id === reservation.fileId ||
        file.properties.lotusOperationId === reservation.operationId ||
        file.name === expectedFilename ||
        sameKeyFiles.some((sameKey) => sameKey.id === file.id)
    );
    const coherentUploads = relevant.filter((file) => {
      try {
        const properties = requirePdfProperties(file.properties);
        return (
          file.id === reservation.fileId &&
          file.name === expectedFilename &&
          file.mimeType === PDF_MIME_TYPE &&
          properties.lotusOperationId === reservation.operationId &&
          properties.lotusSourceSha256 === reservation.sourceSha256 &&
          properties.lotusInvoiceNumber === reservation.invoiceNumber &&
          properties.lotusStudioSlug === reservation.studioSlug &&
          properties.lotusMonth === reservation.month
        );
      } catch {
        return false;
      }
    });
    return {
      relevant,
      coherentUploads,
      conflictingKeyFiles,
      operationFiles,
    };
  }

  private throwCatalogConflicts(conflicts: readonly DriveInvoiceConflict[]): void {
    if (conflicts.length === 0) return;
    if (conflicts.some((conflict) => conflict.kind === 'duplicate')) {
      throw new DriveStoreError('duplicate', 'Drive invoice catalog contains duplicates', false);
    }
    if (conflicts.some((conflict) => conflict.kind === 'permission')) {
      throw new DriveStoreError(
        'permission',
        'Drive invoice catalog contains permission conflicts',
        false
      );
    }
    throw new DriveStoreError(
      'corrupt',
      'Drive invoice catalog contains blocking conflicts',
      false
    );
  }

  private requireScanCanActivate(scan: DriveInvoiceScan): void {
    this.throwCatalogConflicts(scan.blockingConflicts);
  }

  private requireScanCanMutate(scan: DriveInvoiceScan, key: InvoiceKey): void {
    this.throwCatalogConflicts(
      scan.blockingConflicts.filter(
        (conflict) => conflict.scope === 'global' || keyEquals(conflict.key, key)
      )
    );
  }

  private requireInputYear(input: FinalizationInput): number {
    const match = MONTH_PATTERN.exec(input.key.monthKey);
    if (match === null) throw invalidState('Invoice month key is invalid');
    return Number(match[1]);
  }

  private async sourceForInput(
    input: FinalizationInput,
    invoiceNumber: string
  ): Promise<CurrentInvoiceSource> {
    const month = MONTH_PATTERN.exec(input.key.monthKey);
    const calendarId = input.config.calendarId;
    if (
      month === null ||
      !isNonEmptyString(calendarId) ||
      studioSlug(input.invoice.studioName) !== input.key.studioSlug ||
      input.invoice.invoicePeriod.from.slice(0, 7) !== input.key.monthKey ||
      input.invoice.invoicePeriod.to.slice(0, 7) !== input.key.monthKey ||
      input.config.studios[input.invoice.studioName] === undefined ||
      input.classes.some((cls) => cls.eventIdentity.calendarId !== calendarId)
    ) {
      throw invalidState('Invoice source identity is invalid');
    }
    const number = INVOICE_NUMBER_PATTERN.exec(invoiceNumber);
    if (number === null || number[2] !== month[1]) {
      throw invalidState('Invoice number does not match its month year');
    }
    return resolveCurrentInvoiceSource(
      {
        key: { ...input.key },
        studioName: input.invoice.studioName,
        invoice: input.invoice,
        classes: [...input.classes],
        config: input.config,
        fingerprint: { sourceSha256: '', calendarSha256: '' },
      },
      invoiceNumber
    );
  }

  private async sourceForReservation(
    sources: readonly CurrentInvoiceSource[],
    reservation: InvoiceReservation
  ): Promise<CurrentInvoiceSource | null> {
    const matches = sources.filter(
      (source) =>
        source.key.studioSlug === reservation.studioSlug &&
        source.key.monthKey === reservation.month
    );
    if (matches.length !== 1) return null;
    return this.sourceForInput(
      {
        key: { ...matches[0].key },
        invoice: matches[0].invoice,
        classes: matches[0].classes,
        config: matches[0].config,
      },
      reservation.invoiceNumber
    );
  }

  private replaceSource(
    sources: readonly CurrentInvoiceSource[],
    replacement: CurrentInvoiceSource
  ): CurrentInvoiceSource[] {
    return [...sources.filter((source) => !keyEquals(source.key, replacement.key)), replacement];
  }

  private requireGeneratedValue(value: string, kind: 'operation' | 'file'): string {
    if (!isNonEmptyString(value)) throw invalidState(`Generated invoice ${kind} ID is invalid`);
    return value;
  }

  private requireTimestamp(value: string): string {
    if (!isNonEmptyString(value) || !Number.isFinite(Date.parse(value))) {
      throw invalidState('Invoice reservation timestamp is invalid');
    }
    return value;
  }

  private async renderReserved(
    source: CurrentInvoiceSource,
    invoiceNumber: string
  ): Promise<Uint8Array> {
    const bytes = await this.dependencies.renderFinalPdf(
      source.invoice,
      source.config,
      invoiceNumber
    );
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw invalidState('Invoice renderer returned invalid PDF bytes');
    }
    return new Uint8Array(bytes);
  }

  private async pdfProperties(
    source: CurrentInvoiceSource,
    invoiceNumber: string,
    operationId: string,
    bytes: Uint8Array
  ): Promise<LotusPdfProperties> {
    return {
      lotusSchema: '1',
      lotusCalendarHash: source.fingerprint.calendarSha256,
      lotusStudioSlug: source.key.studioSlug,
      lotusMonth: source.key.monthKey,
      lotusInvoiceNumber: invoiceNumber,
      lotusSourceSha256: source.fingerprint.sourceSha256,
      lotusPdfSha256: await sha256Hex(bytes),
      lotusOperationId: operationId,
    };
  }

  private pdfExpectation(
    stagedRoot: StagedDriveRoot,
    fileId: string,
    invoiceNumber: string,
    key: InvoiceKey,
    properties: LotusPdfProperties,
    bytes?: Uint8Array
  ): ExactPdfExpectation {
    const [periodYear, periodMonth] = key.monthKey.split('-');
    return {
      fileId,
      filename: finalizedFilename(key.studioSlug, periodYear, periodMonth, invoiceNumber),
      parentId: stagedRoot.finalFolder.id,
      driveId: stagedRoot.root.driveId,
      properties,
      ...(bytes === undefined ? {} : { bytes }),
    };
  }

  private async verifyUploadedPdf(
    returned: DriveFileRecord,
    expectation: ExactPdfExpectation
  ): Promise<DriveFileRecord> {
    const response = requirePdfRecord(returned, expectation);
    const exact = requirePdfRecord(
      await this.api.getFile({ fileId: expectation.fileId, supportsAllDrives: true }),
      expectation
    );
    if (!exactAuthorityEqual(response, exact)) {
      throw new DriveStoreError('corrupt', 'Drive upload response is incoherent', false);
    }
    const downloaded = await this.downloadAndVerifyExact(exact);
    if (expectation.bytes !== undefined && !bytesEqual(downloaded, expectation.bytes)) {
      throw new DriveStoreError('corrupt', 'Downloaded Drive invoice bytes do not match', false);
    }
    return exact;
  }

  private async verifyRecoveryUpload(
    file: DriveFileRecord,
    stagedRoot: StagedDriveRoot,
    reservation: InvoiceReservation
  ): Promise<void> {
    const stored = requirePdfProperties(file.properties);
    if (
      stored.lotusOperationId !== reservation.operationId ||
      stored.lotusSourceSha256 !== reservation.sourceSha256 ||
      stored.lotusInvoiceNumber !== reservation.invoiceNumber ||
      stored.lotusStudioSlug !== reservation.studioSlug ||
      stored.lotusMonth !== reservation.month
    ) {
      throw recoveryRequired('Drive upload properties do not match the active reservation');
    }
    const expectation = this.pdfExpectation(
      stagedRoot,
      reservation.fileId,
      reservation.invoiceNumber,
      { studioSlug: reservation.studioSlug, monthKey: reservation.month },
      stored
    );
    const exact = requirePdfRecord(
      await this.api.getFile({ fileId: reservation.fileId, supportsAllDrives: true }),
      expectation
    );
    if (!selectedAuthorityEqual(file, exact)) {
      throw recoveryRequired('Drive upload changed during reservation recovery');
    }
    await this.downloadAndVerifyExact(exact);
  }

  private async downloadAndVerifyExact(exact: DriveFileRecord): Promise<Uint8Array> {
    const properties = requirePdfProperties(exact.properties);
    if (
      exact.mimeType !== PDF_MIME_TYPE ||
      exact.trashed ||
      !exact.capabilities.canDownload ||
      !isNonEmptyString(exact.etag)
    ) {
      throw new DriveStoreError('permission', 'Drive invoice cannot be safely downloaded', false);
    }
    const downloaded = await this.api.downloadFile({ fileId: exact.id, supportsAllDrives: true });
    if (
      !(downloaded.bytes instanceof Uint8Array) ||
      !exactAuthorityEqual(exact, downloaded.file) ||
      exact.size !== String(downloaded.bytes.byteLength)
    ) {
      throw new DriveStoreError('conflict', 'Drive invoice changed during download', false);
    }
    const actual = await sha256Hex(downloaded.bytes);
    if (
      actual !== properties.lotusPdfSha256 ||
      (exact.sha256Checksum !== null && exact.sha256Checksum !== actual)
    ) {
      throw new DriveStoreError(
        'corrupt',
        'Downloaded Drive invoice checksum does not match',
        false
      );
    }
    return new Uint8Array(downloaded.bytes);
  }

  private requireFreshResult(scan: DriveInvoiceScan, fileId: string): DriveInvoiceEntry {
    const matches = scan.entries.filter((entry) => entry.file.id === fileId);
    if (matches.length !== 1 || matches[0].state !== 'fresh') {
      throw new DriveStoreError(
        'corrupt',
        'Committed Drive invoice did not refresh as fresh',
        false
      );
    }
    return matches[0];
  }
}
