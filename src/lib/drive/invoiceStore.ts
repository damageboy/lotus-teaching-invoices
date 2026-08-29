import { parseLegacyLocalConfigYaml } from '../config/schema.js';
import { finalizedFilename, studioSlug } from '../invoice/finalization.js';
import { sha256Hex } from '../invoice/sourceFingerprint.js';
import type { AppConfig, Invoice, ParsedClass } from '../types.js';
import type { DriveApi } from './api.js';
import {
  DriveConfigRepository,
  nextInvoiceConfig,
  type DriveConfigDiscoveryCandidate,
  type DriveConfigSnapshot,
} from './configFile.js';
import {
  DriveFolderError,
  DriveFolderService,
  type DriveRoot,
  type StagedDriveRoot,
} from './folders.js';
import {
  resolveCurrentInvoiceSource,
  scanFinalFolder,
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

const PDF_MIME_TYPE = 'application/pdf';
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
  config: DriveConfigSnapshot;
  stagedRoot: StagedDriveRoot;
  scan: DriveInvoiceScan;
}

export interface DriveConfigCandidate {
  fileId: string;
  kind: 'configured' | 'legacy';
  root: DriveRoot;
  rootFile: DriveFileRecord;
  calendarName: string | null;
}

export interface DriveRecoveryIssue {
  fileId: string;
  message: string;
}

export interface DriveRecoveryDiscovery {
  candidates: DriveConfigCandidate[];
  issues: DriveRecoveryIssue[];
}

export interface DriveMutationResult {
  entry: DriveInvoiceEntry;
  snapshot: DriveStoreSnapshot;
}

export type DriveStoreErrorCode =
  | 'authorizationRequired'
  | 'unconfigured'
  | 'offline'
  | 'permission'
  | 'conflict'
  | 'corrupt'
  | 'duplicate'
  | 'invalidState';

export class DriveStoreError extends Error {
  constructor(
    readonly code: DriveStoreErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly snapshot?: DriveStoreSnapshot
  ) {
    super(message);
    this.name = 'DriveStoreError';
  }
}

export interface DriveInvoiceStoreDependencies {
  renderFinalPdf(invoice: Invoice, config: AppConfig, invoiceNumber: string): Promise<Uint8Array>;
  createOperationId?(): string;
  generateFileId?(): Promise<string>;
}

interface ExactPdfExpectation {
  fileId: string;
  filename: string;
  parentId: string;
  driveId: string | null;
  properties: LotusPdfProperties;
  bytes?: Uint8Array;
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

function invalidState(message: string): DriveStoreError {
  return new DriveStoreError('invalidState', message, false);
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

function isEtagConflict(error: unknown): boolean {
  return error instanceof DriveError && error.code === 'conflict' && error.status === 412;
}

function isAmbiguousMoveFailure(error: unknown): boolean {
  return (
    error instanceof DriveError &&
    (error.retryable ||
      error.code === 'offline' ||
      error.code === 'rateLimited' ||
      error.code === 'server' ||
      error.code === 'invalidResponse')
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

function defaultOperationId(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (!isNonEmptyString(value)) {
    throw invalidState('An invoice operation ID could not be generated');
  }
  return value;
}

export class DriveInvoiceStore {
  private readonly repository: DriveConfigRepository;
  private readonly folderService: DriveFolderService;
  private readonly createOperationId: () => string;
  private readonly generateFileId: () => Promise<string>;
  private currentSources: CurrentInvoiceSource[] = [];
  private selectedConfigFileId: string | null = null;

  constructor(
    private readonly api: DriveApi,
    private readonly dependencies: DriveInvoiceStoreDependencies
  ) {
    this.repository = new DriveConfigRepository(api);
    this.folderService = new DriveFolderService(api);
    this.createOperationId = dependencies.createOperationId ?? defaultOperationId;
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

  async bootstrap(
    sources: readonly CurrentInvoiceSource[],
    legacyLocalYaml?: string
  ): Promise<DriveStoreSnapshot | null> {
    const exactSources = snapshotSources(sources);
    try {
      const discovery = await this.repository.discover();
      if (discovery.kind === 'unconfigured') {
        this.currentSources = exactSources;
        this.selectedConfigFileId = null;
        return null;
      }
      if (discovery.kind === 'conflict') {
        throw new DriveStoreError('duplicate', 'Multiple Drive configuration files exist', false);
      }
      if (discovery.kind === 'configured') {
        return await this.loadConfigured(discovery.snapshot, exactSources);
      }
      if (legacyLocalYaml === undefined) {
        throw invalidState('The legacy local config.yaml is required for Drive migration');
      }
      const parsed = parseLegacyLocalConfigYaml(legacyLocalYaml);
      const migrated = await this.repository.migrate(discovery.snapshot, parsed.config);
      return await this.loadConfigured(migrated, exactSources);
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async loadByFileId(
    fileId: string,
    sources: readonly CurrentInvoiceSource[]
  ): Promise<DriveStoreSnapshot> {
    const exactSources = snapshotSources(sources);
    try {
      return await this.loadConfigured(await this.repository.loadByFileId(fileId), exactSources);
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async discoverRecovery(legacyLocalYaml?: string): Promise<DriveRecoveryDiscovery> {
    try {
      return await this.validateRecoveryCandidates(
        await this.repository.discoverCandidates(),
        legacyLocalYaml
      );
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async inspectRecoveryFolder(
    parentId: string,
    legacyLocalYaml?: string
  ): Promise<DriveRecoveryDiscovery> {
    try {
      return await this.validateRecoveryCandidates(
        await this.repository.listDirectChildren(parentId),
        legacyLocalYaml
      );
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async adoptRecoveryCandidate(
    fileId: string,
    sources: readonly CurrentInvoiceSource[],
    legacyLocalYaml?: string
  ): Promise<DriveStoreSnapshot> {
    const exactSources = snapshotSources(sources);
    try {
      let configured: DriveConfigSnapshot;
      try {
        configured = await this.repository.loadByFileId(fileId);
      } catch (error) {
        if (!(error instanceof DriveError) || error.code !== 'invalidResponse') throw error;
        if (legacyLocalYaml === undefined) {
          throw invalidState('The legacy local config.yaml is required for Drive migration');
        }
        const legacy = await this.repository.loadLegacyByFileId(fileId);
        const parsed = parseLegacyLocalConfigYaml(legacyLocalYaml);
        configured = await this.repository.migrate(legacy, parsed.config);
      }
      return await this.loadConfigured(configured, exactSources);
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async saveConfig(
    snapshot: DriveStoreSnapshot,
    nextConfig: AppConfig,
    sources: readonly CurrentInvoiceSource[]
  ): Promise<DriveStoreSnapshot> {
    const exactSnapshot = snapshotValue(snapshot, 'Drive configuration could not be snapshotted');
    const exactSources = snapshotSources(sources);
    try {
      const saved = await this.repository.replace(exactSnapshot.config, nextConfig);
      return await this.loadConfigured(saved, exactSources);
    } catch (error) {
      if (isEtagConflict(error)) {
        const fresh = await this.refreshInternal(exactSources);
        throw new DriveStoreError(
          'conflict',
          'Drive configuration changed elsewhere; repeat the edit',
          false,
          fresh
        );
      }
      throw mapLowerError(error);
    }
  }

  async activateRoot(
    staged: StagedDriveRoot,
    sources: readonly CurrentInvoiceSource[],
    initialConfig?: AppConfig
  ): Promise<DriveStoreSnapshot> {
    const exactStaged = snapshotValue(staged, 'Staged Drive root could not be snapshotted');
    const exactSources = snapshotSources(sources);
    try {
      const scan = await scanFinalFolder(this.api, exactStaged, exactSources);
      this.requireScanCanActivate(scan);
      if (this.selectedConfigFileId === null) {
        if (initialConfig === undefined) {
          throw invalidState('Initial configuration is required for Drive setup');
        }
        const sequenceByYear = { ...initialConfig.invoiceSequenceByYear };
        for (const [year, sequence] of Object.entries(scan.maxSequenceByYear)) {
          sequenceByYear[year] = Math.max(sequenceByYear[year] ?? 0, sequence);
        }
        const created = await this.repository.create(exactStaged.root.folderId, {
          ...initialConfig,
          invoiceSequenceByYear: sequenceByYear,
        });
        return await this.loadConfigured(created, exactSources);
      }

      const current = await this.repository.loadByFileId(this.selectedConfigFileId);
      let moved: DriveConfigSnapshot;
      try {
        moved = await this.repository.move(current, exactStaged.root.folderId);
      } catch (error) {
        if (!isAmbiguousMoveFailure(error)) throw error;
        const reconciled = await this.repository.loadByFileId(this.selectedConfigFileId);
        if (
          reconciled.file.id !== current.file.id ||
          reconciled.file.parents.length !== 1 ||
          reconciled.file.parents[0] !== exactStaged.root.folderId
        ) {
          throw error;
        }
        moved = reconciled;
      }
      return await this.loadConfigured(moved, exactSources);
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

  async finalize(input: FinalizationInput): Promise<DriveMutationResult> {
    const exactInput = snapshotInput(input);
    try {
      const year = this.requireInputYear(exactInput);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await this.refreshInternal(this.currentSources);
        this.requireScanCanMutate(current.scan, exactInput.key);
        if (current.scan.entries.some((entry) => keyEquals(entry.key, exactInput.key))) {
          throw new DriveStoreError(
            'duplicate',
            'An invoice already exists for this studio and month',
            false
          );
        }
        const allocated = nextInvoiceConfig(current.config, year);
        try {
          await this.repository.replace(current.config, allocated.config);
        } catch (error) {
          if (isEtagConflict(error) && attempt < 2) continue;
          throw error;
        }
        return await this.uploadAllocated(exactInput, current.stagedRoot, allocated.invoiceNumber);
      }
      throw invalidState('Invoice number allocation did not complete');
    } catch (error) {
      throw mapLowerError(error);
    }
  }

  async refinalize(
    input: FinalizationInput,
    expectedEntry: DriveInvoiceEntry
  ): Promise<DriveMutationResult> {
    const exactInput = snapshotInput(input);
    const exactExpectedEntry = snapshotValue(
      expectedEntry,
      'Selected Drive invoice could not be snapshotted'
    );
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

      const current = await this.refreshInternal(this.currentSources);
      this.requireScanCanMutate(current.scan, exactInput.key);
      const selected = current.scan.entries.filter(
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

      const source = await this.sourceForInput(exactInput, exactExpectedEntry.invoiceNumber);
      const bytes = await this.render(source, exactExpectedEntry.invoiceNumber);
      const operationId = this.requireGeneratedValue(this.createOperationId(), 'operation');
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
        parentId: current.stagedRoot.finalFolder.id,
        driveId: current.stagedRoot.root.driveId,
        properties,
        bytes,
      };
      let updated: DriveFileRecord;
      try {
        updated = await this.api.updateFile({
          fileId: exact.id,
          name: exact.name,
          mimeType: PDF_MIME_TYPE,
          parents: [current.stagedRoot.finalFolder.id],
          properties: { ...properties },
          bytes: Array.from(bytes),
          supportsAllDrives: true,
          ifMatch: exact.etag,
        });
      } catch (error) {
        if (
          !isAmbiguousPdfUpdateFailure(error) ||
          !(await this.verifyAmbiguousPdfUpdate(expectation))
        ) {
          throw error;
        }
        updated = await this.api.getFile({ fileId: exact.id, supportsAllDrives: true });
      }
      await this.verifyUploadedPdf(updated, expectation);
      const snapshot = await this.refreshInternal(this.replaceSource(this.currentSources, source));
      return { entry: this.requireFreshResult(snapshot.scan, exact.id), snapshot };
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
      const exact = await this.api.getFile({ fileId: exactEntry.file.id, supportsAllDrives: true });
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

  private async uploadAllocated(
    input: FinalizationInput,
    stagedRoot: StagedDriveRoot,
    invoiceNumber: string
  ): Promise<DriveMutationResult> {
    const source = await this.sourceForInput(input, invoiceNumber);
    const bytes = await this.render(source, invoiceNumber);
    const operationId = this.requireGeneratedValue(this.createOperationId(), 'operation');
    const fileId = this.requireGeneratedValue(await this.generateFileId(), 'file');
    const properties = await this.pdfProperties(source, invoiceNumber, operationId, bytes);
    const expectation = this.pdfExpectation(
      stagedRoot,
      fileId,
      invoiceNumber,
      input.key,
      properties,
      bytes
    );
    const created = await this.api.createFile({
      fileId,
      name: expectation.filename,
      mimeType: PDF_MIME_TYPE,
      parents: [expectation.parentId],
      properties: { ...properties },
      bytes: Array.from(bytes),
      supportsAllDrives: true,
    });
    await this.verifyUploadedPdf(created, expectation);
    const snapshot = await this.refreshInternal(this.replaceSource(this.currentSources, source));
    return { entry: this.requireFreshResult(snapshot.scan, fileId), snapshot };
  }

  private async verifyAmbiguousPdfUpdate(expectation: ExactPdfExpectation): Promise<boolean> {
    try {
      const exact = await this.api.getFile({ fileId: expectation.fileId, supportsAllDrives: true });
      const downloaded = await this.downloadAndVerifyExact(exact);
      requirePdfRecord(exact, expectation);
      return expectation.bytes === undefined || bytesEqual(downloaded, expectation.bytes);
    } catch {
      return false;
    }
  }

  private async refreshInternal(
    sources: readonly CurrentInvoiceSource[]
  ): Promise<DriveStoreSnapshot> {
    if (this.selectedConfigFileId === null) {
      throw invalidState('No Drive configuration file is selected');
    }
    return this.loadConfigured(
      await this.repository.loadByFileId(this.selectedConfigFileId),
      sources
    );
  }

  private async loadConfigured(
    config: DriveConfigSnapshot,
    sources: readonly CurrentInvoiceSource[]
  ): Promise<DriveStoreSnapshot> {
    if (config.file.parents.length !== 1) {
      throw new DriveStoreError('corrupt', 'Drive configuration must have one parent', false);
    }
    const stagedRoot = await this.folderService.resolveRootFromConfigParent(config.file.parents[0]);
    const scan = await scanFinalFolder(this.api, stagedRoot, sources);
    const snapshot = { config, stagedRoot, scan };
    this.currentSources = snapshotSources(sources);
    this.selectedConfigFileId = config.file.id;
    return snapshot;
  }

  private async validateRecoveryCandidates(
    discoveries: readonly DriveConfigDiscoveryCandidate[],
    legacyLocalYaml?: string
  ): Promise<DriveRecoveryDiscovery> {
    const candidates: DriveConfigCandidate[] = [];
    const issues: DriveRecoveryIssue[] = [];
    for (const discovery of discoveries) {
      try {
        if (discovery.kind === 'configured') {
          const snapshot = await this.repository.loadByFileId(discovery.file.id);
          const staged = await this.folderService.resolveRootFromConfigParent(
            snapshot.file.parents[0]
          );
          candidates.push({
            fileId: snapshot.file.id,
            kind: 'configured',
            root: { ...staged.root },
            rootFile: snapshotValue(staged.rootFile, 'Drive root could not be snapshotted'),
            calendarName: snapshot.config.calendarName ?? null,
          });
          continue;
        }
        const snapshot = await this.repository.loadLegacyByFileId(discovery.file.id);
        const staged = await this.folderService.resolveRootFromConfigParent(
          snapshot.file.parents[0]
        );
        let calendarName: string | null = null;
        if (legacyLocalYaml !== undefined) {
          calendarName = parseLegacyLocalConfigYaml(legacyLocalYaml).config.calendarName ?? null;
        }
        candidates.push({
          fileId: snapshot.file.id,
          kind: 'legacy',
          root: { ...staged.root },
          rootFile: snapshotValue(staged.rootFile, 'Drive root could not be snapshotted'),
          calendarName,
        });
      } catch (error) {
        issues.push({
          fileId: discovery.file.id,
          message: error instanceof Error ? error.message : 'Drive configuration is invalid',
        });
      }
    }
    candidates.sort(
      (left, right) =>
        left.root.folderName.localeCompare(right.root.folderName) ||
        left.fileId.localeCompare(right.fileId)
    );
    issues.sort((left, right) => left.fileId.localeCompare(right.fileId));
    return { candidates, issues };
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

  private async render(source: CurrentInvoiceSource, invoiceNumber: string): Promise<Uint8Array> {
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
      throw new DriveStoreError('corrupt', 'Drive invoice did not refresh as fresh', false);
    }
    return matches[0];
  }
}
