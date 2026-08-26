import type { DriveApi } from './api.js';
import type { StagedDriveRoot } from './folders.js';
import {
  DriveError,
  type DriveFileRecord,
  type InvoiceKey,
  type InvoiceSourceFingerprint,
  type LotusPdfProperties,
} from './types.js';
import {
  parseFinalizedInvoiceFilename,
  studioSlug,
  type ParsedFinalizedInvoiceFilename,
} from '../invoice/finalization.js';
import {
  buildInvoiceSource,
  fingerprintInvoiceSource,
  sha256Hex,
} from '../invoice/sourceFingerprint.js';
import type { AppConfig, Invoice, ParsedClass } from '../types.js';

const PDF_MIME_TYPE = 'application/pdf';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const PAGE_SIZE = 100;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

export type DriveInvoiceState =
  | 'fresh'
  | 'stale'
  | 'unmanaged'
  | 'duplicate'
  | 'malformed'
  | 'corrupt'
  | 'permission';

export interface DriveInvoiceEntry {
  key: InvoiceKey | null;
  file: DriveFileRecord;
  filename: string;
  invoiceNumber: string | null;
  state: DriveInvoiceState;
  sourceSha256: string | null;
  pdfSha256: string | null;
  message: string | null;
}

export interface CurrentInvoiceSource {
  key: InvoiceKey;
  studioName: string;
  invoice: Invoice;
  classes: readonly ParsedClass[];
  config: AppConfig;
  fingerprint: InvoiceSourceFingerprint;
}

export type DriveInvoiceConflict =
  | {
      scope: 'global';
      kind: 'sequenceAmbiguity';
      message: string;
    }
  | {
      scope: 'invoice';
      kind: 'duplicate' | 'corrupt' | 'permission';
      key: InvoiceKey;
      message: string;
    };

export interface DriveInvoiceScan {
  entries: DriveInvoiceEntry[];
  warnings: string[];
  blockingConflicts: DriveInvoiceConflict[];
  maxSequenceByYear: Record<string, number>;
}

export interface DriveInvoiceScanOptions {
  adoptManual?: boolean;
}

/** Resolve current business input against the authoritative number parsed from a Drive file. */
export async function resolveCurrentInvoiceSource(
  source: CurrentInvoiceSource,
  invoiceNumber: string
): Promise<CurrentInvoiceSource> {
  const calendarId = source.config.calendarId;
  const invoice = { ...source.invoice, invoiceNumber };
  if (typeof calendarId !== 'string' || calendarId.length === 0) {
    throw corrupt('Current invoice source has no Calendar identity');
  }
  const canonical = buildInvoiceSource({
    config: source.config,
    classes: source.classes,
    invoice,
    calendarId,
    invoiceNumber,
  });
  return {
    ...source,
    invoice,
    fingerprint: await fingerprintInvoiceSource(canonical),
  };
}

interface ParsedFile {
  file: DriveFileRecord;
  parsed: ParsedFinalizedInvoiceFilename | null;
}

interface SourceIndexEntry {
  source: CurrentInvoiceSource | null;
  count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidResponse(message: string, fileId?: string): DriveError {
  return new DriveError('invalidResponse', message, false, undefined, fileId);
}

function corrupt(message: string, fileId?: string): DriveError {
  return new DriveError('corrupt', message, false, undefined, fileId);
}

function permission(message: string, fileId: string): DriveError {
  return new DriveError('permission', message, false, 403, fileId);
}

function conflict(message: string, fileId: string): DriveError {
  return new DriveError('conflict', message, false, 409, fileId);
}

function cloneFile(file: DriveFileRecord): DriveFileRecord {
  return {
    ...file,
    parents: [...file.parents],
    properties: { ...file.properties },
    capabilities: { ...file.capabilities },
  };
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

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableFileIdentityEqual(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    stringArraysEqual(left.parents, right.parents) &&
    left.driveId === right.driveId &&
    left.ownedByMe === right.ownedByMe &&
    left.trashed === right.trashed
  );
}

function fileSnapshotAuthorityEqual(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return (
    stableFileIdentityEqual(left, right) &&
    left.version === right.version &&
    left.size === right.size &&
    left.md5Checksum === right.md5Checksum &&
    left.sha256Checksum === right.sha256Checksum &&
    stringMapsEqual(left.properties, right.properties) &&
    left.capabilities.canListChildren === right.capabilities.canListChildren &&
    left.capabilities.canAddChildren === right.capabilities.canAddChildren &&
    left.capabilities.canEdit === right.capabilities.canEdit &&
    left.capabilities.canDownload === right.capabilities.canDownload
  );
}

function exactFileSnapshotEqual(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return fileSnapshotAuthorityEqual(left, right) && left.etag === right.etag;
}

function listedAndExactSnapshotEqual(listed: DriveFileRecord, exact: DriveFileRecord): boolean {
  return (
    fileSnapshotAuthorityEqual(listed, exact) &&
    (listed.etag === null || listed.etag === exact.etag)
  );
}

function requireDriveFile(value: unknown): DriveFileRecord {
  const fallbackId = isRecord(value) && typeof value.id === 'string' ? value.id : undefined;
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    typeof value.name !== 'string' ||
    !isNonEmptyString(value.mimeType) ||
    !Array.isArray(value.parents) ||
    !value.parents.every(isNonEmptyString) ||
    !(value.driveId === null || isNonEmptyString(value.driveId)) ||
    typeof value.ownedByMe !== 'boolean' ||
    typeof value.trashed !== 'boolean' ||
    !isNonEmptyString(value.version) ||
    !(value.size === null || (typeof value.size === 'string' && /^\d+$/.test(value.size))) ||
    !(value.md5Checksum === null || typeof value.md5Checksum === 'string') ||
    !(value.sha256Checksum === null || typeof value.sha256Checksum === 'string') ||
    !isRecord(value.properties) ||
    !Object.values(value.properties).every((property) => typeof property === 'string') ||
    !isRecord(value.capabilities) ||
    typeof value.capabilities.canListChildren !== 'boolean' ||
    typeof value.capabilities.canAddChildren !== 'boolean' ||
    typeof value.capabilities.canEdit !== 'boolean' ||
    typeof value.capabilities.canDownload !== 'boolean' ||
    !(value.etag === null || isNonEmptyString(value.etag))
  ) {
    throw invalidResponse('Drive returned an invalid invoice file record', fallbackId);
  }
  return value as unknown as DriveFileRecord;
}

function requireStagedRoot(stagedRoot: StagedDriveRoot): void {
  const { root, rootFile, finalFolder } = stagedRoot;
  if (
    !isNonEmptyString(root.folderId) ||
    !(root.driveId === null || isNonEmptyString(root.driveId)) ||
    !isNonEmptyString(rootFile.id) ||
    rootFile.id !== root.folderId ||
    rootFile.mimeType !== FOLDER_MIME_TYPE ||
    rootFile.driveId !== root.driveId ||
    rootFile.trashed ||
    !isNonEmptyString(finalFolder.id) ||
    finalFolder.mimeType !== FOLDER_MIME_TYPE ||
    finalFolder.name !== 'Final' ||
    finalFolder.trashed ||
    finalFolder.driveId !== root.driveId ||
    finalFolder.parents.length !== 1 ||
    finalFolder.parents[0] !== root.folderId
  ) {
    throw invalidResponse('Staged Drive root and Final folder are incoherent');
  }
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function fileSnapshotsCanDeduplicate(left: DriveFileRecord, right: DriveFileRecord): boolean {
  return exactFileSnapshotEqual(left, right);
}

async function listFinalChildren(
  api: DriveApi,
  stagedRoot: StagedDriveRoot
): Promise<DriveFileRecord[]> {
  requireStagedRoot(stagedRoot);
  const filesById = new Map<string, DriveFileRecord>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  do {
    const page = await api.listFiles({
      query: `'${escapeDriveQueryString(stagedRoot.finalFolder.id)}' in parents and trashed = false`,
      corpora: stagedRoot.root.driveId === null ? 'user' : 'drive',
      ...(stagedRoot.root.driveId === null ? {} : { driveId: stagedRoot.root.driveId }),
      ...(pageToken === undefined ? {} : { pageToken }),
      pageSize: PAGE_SIZE,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    if (!isRecord(page) || !Array.isArray(page.items)) {
      throw invalidResponse('Drive returned an invalid Final-folder page');
    }

    for (const item of page.items) {
      const file = requireDriveFile(item);
      if (
        file.trashed ||
        file.parents.length !== 1 ||
        file.parents[0] !== stagedRoot.finalFolder.id ||
        file.driveId !== stagedRoot.root.driveId
      ) {
        throw invalidResponse('Drive returned an invoice outside the staged Final folder', file.id);
      }
      const existing = filesById.get(file.id);
      if (existing != null && !fileSnapshotsCanDeduplicate(existing, file)) {
        throw invalidResponse('Drive returned inconsistent duplicate invoice records', file.id);
      }
      if (existing == null) filesById.set(file.id, cloneFile(file));
    }

    if (page.nextPageToken === null) break;
    if (!isNonEmptyString(page.nextPageToken) || page.nextPageToken === pageToken) {
      throw invalidResponse('Drive returned an invalid Final-folder page token');
    }
    if (seenPageTokens.has(page.nextPageToken)) {
      throw invalidResponse('Drive repeated a Final-folder page token');
    }
    seenPageTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  } while (true);

  return [...filesById.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
}

function invoiceKey(parsed: ParsedFinalizedInvoiceFilename): InvoiceKey {
  return { studioSlug: parsed.studioSlug, monthKey: parsed.monthKey };
}

function keyString(key: InvoiceKey): string {
  return `${key.studioSlug}\u0000${key.monthKey}`;
}

function sourceIndex(sources: readonly CurrentInvoiceSource[]): Map<string, SourceIndexEntry> {
  const result = new Map<string, SourceIndexEntry>();
  for (const source of sources) {
    const serialized = keyString(source.key);
    const existing = result.get(serialized);
    if (existing == null) result.set(serialized, { source, count: 1 });
    else result.set(serialized, { source: null, count: existing.count + 1 });
  }
  return result;
}

function hasManagedMarker(properties: Readonly<Record<string, string>>): boolean {
  return LOTUS_PROPERTY_KEYS.some((key) => Object.hasOwn(properties, key));
}

function requireManagedProperties(
  file: DriveFileRecord,
  parsed: ParsedFinalizedInvoiceFilename
): LotusPdfProperties {
  const properties = file.properties;
  if (!LOTUS_PROPERTY_KEYS.every((key) => typeof properties[key] === 'string')) {
    throw corrupt('Managed invoice is missing one or more Lotus properties', file.id);
  }
  const values = properties as unknown as LotusPdfProperties;
  if (values.lotusSchema !== '1') {
    throw corrupt('Managed invoice has an unsupported Lotus schema', file.id);
  }
  if (!HASH_PATTERN.test(values.lotusCalendarHash)) {
    throw corrupt('Managed invoice has an invalid Calendar hash', file.id);
  }
  if (!SLUG_PATTERN.test(values.lotusStudioSlug)) {
    throw corrupt('Managed invoice has an invalid studio slug', file.id);
  }
  if (!MONTH_PATTERN.test(values.lotusMonth)) {
    throw corrupt('Managed invoice has an invalid month', file.id);
  }
  if (values.lotusInvoiceNumber !== parsed.invoiceNumber) {
    throw corrupt('Managed invoice number disagrees with its filename', file.id);
  }
  if (values.lotusStudioSlug !== parsed.studioSlug) {
    throw corrupt('Managed invoice studio disagrees with its filename', file.id);
  }
  if (values.lotusMonth !== parsed.monthKey) {
    throw corrupt('Managed invoice month disagrees with its filename', file.id);
  }
  if (!HASH_PATTERN.test(values.lotusSourceSha256)) {
    throw corrupt('Managed invoice has an invalid source hash', file.id);
  }
  if (!HASH_PATTERN.test(values.lotusPdfSha256)) {
    throw corrupt('Managed invoice has an invalid PDF hash', file.id);
  }
  if (!isNonEmptyString(values.lotusOperationId)) {
    throw corrupt('Managed invoice has an invalid operation ID', file.id);
  }
  return { ...values };
}

function requireDownloadPermission(file: DriveFileRecord): void {
  if (!file.capabilities.canDownload) {
    throw permission('Drive invoice cannot be downloaded', file.id);
  }
}

function requireEditPermission(file: DriveFileRecord): void {
  if (!file.capabilities.canEdit) {
    throw permission('Drive invoice metadata cannot be edited', file.id);
  }
}

function requirePdf(file: DriveFileRecord): void {
  if (file.mimeType !== PDF_MIME_TYPE) {
    throw corrupt('Finalized invoice does not have PDF MIME type', file.id);
  }
}

function requireDownloadedSnapshot(
  expected: DriveFileRecord,
  downloaded: DriveFileRecord,
  bytes: Uint8Array
): DriveFileRecord {
  const exact = requireDriveFile(downloaded);
  if (!listedAndExactSnapshotEqual(expected, exact)) {
    throw conflict('Drive invoice metadata changed during download', expected.id);
  }
  if (!isNonEmptyString(exact.etag)) {
    throw invalidResponse('Drive invoice download is missing an ETag', expected.id);
  }
  if (exact.size !== null && exact.size !== String(bytes.byteLength)) {
    throw corrupt('Drive invoice size does not match downloaded bytes', expected.id);
  }
  return exact;
}

export async function verifyDrivePdf(api: DriveApi, file: DriveFileRecord): Promise<string> {
  const exactFile = requireDriveFile(file);
  requirePdf(exactFile);
  const parsed = parseFinalizedInvoiceFilename(exactFile.name);
  if (parsed == null) throw corrupt('Drive invoice filename is malformed', exactFile.id);
  const properties = requireManagedProperties(exactFile, parsed);

  if (exactFile.sha256Checksum !== null) {
    if (!HASH_PATTERN.test(exactFile.sha256Checksum)) {
      throw corrupt('Drive returned an invalid PDF SHA-256', exactFile.id);
    }
    if (exactFile.sha256Checksum !== properties.lotusPdfSha256) {
      throw corrupt('Drive PDF checksum does not match Lotus metadata', exactFile.id);
    }
    return exactFile.sha256Checksum;
  }

  requireDownloadPermission(exactFile);
  const downloaded = await api.downloadFile({
    fileId: exactFile.id,
    supportsAllDrives: true,
  });
  if (!isRecord(downloaded) || !(downloaded.bytes instanceof Uint8Array)) {
    throw invalidResponse('Drive returned an invalid PDF download', exactFile.id);
  }
  const downloadedFile = requireDownloadedSnapshot(exactFile, downloaded.file, downloaded.bytes);
  const actualSha256 = await sha256Hex(downloaded.bytes);
  if (actualSha256 !== properties.lotusPdfSha256) {
    throw corrupt('Downloaded PDF checksum does not match Lotus metadata', exactFile.id);
  }
  const freshFile = requireDriveFile(
    await api.getFile({ fileId: exactFile.id, supportsAllDrives: true })
  );
  if (!exactFileSnapshotEqual(downloadedFile, freshFile)) {
    throw conflict('Drive invoice changed after checksum verification', exactFile.id);
  }
  return actualSha256;
}

function requireAdoptionSource(
  source: CurrentInvoiceSource,
  parsed: ParsedFinalizedInvoiceFilename,
  fileId: string
): void {
  if (
    source.key.studioSlug !== parsed.studioSlug ||
    source.key.monthKey !== parsed.monthKey ||
    source.invoice.invoiceNumber !== parsed.invoiceNumber ||
    source.invoice.studioName !== source.studioName ||
    studioSlug(source.studioName) !== source.key.studioSlug ||
    source.invoice.invoicePeriod.from.slice(0, 7) !== source.key.monthKey ||
    source.invoice.invoicePeriod.to.slice(0, 7) !== source.key.monthKey ||
    source.config.studios[source.studioName] == null ||
    !HASH_PATTERN.test(source.fingerprint.sourceSha256) ||
    !HASH_PATTERN.test(source.fingerprint.calendarSha256)
  ) {
    throw corrupt('Current invoice source does not match the manual PDF identity', fileId);
  }
}

async function adoptionOperationId(
  file: DriveFileRecord,
  parsed: ParsedFinalizedInvoiceFilename,
  source: CurrentInvoiceSource,
  pdfSha256: string
): Promise<string> {
  const identity = [
    'lotus-adoption-v1',
    file.id,
    parsed.invoiceNumber,
    parsed.studioSlug,
    parsed.monthKey,
    source.fingerprint.sourceSha256,
    source.fingerprint.calendarSha256,
    pdfSha256,
  ].join('\u0000');
  return `adopt:${await sha256Hex(new TextEncoder().encode(identity))}`;
}

function requireManualSnapshot(
  value: DriveFileRecord,
  expected: DriveFileRecord,
  parsed: ParsedFinalizedInvoiceFilename,
  stage: string,
  listedSnapshot: boolean
): DriveFileRecord {
  const exact = requireDriveFile(value);
  const coherent = listedSnapshot
    ? listedAndExactSnapshotEqual(expected, exact)
    : exactFileSnapshotEqual(expected, exact);
  if (!coherent) {
    throw conflict(`Drive invoice changed during manual adoption ${stage}`, expected.id);
  }
  if (!isNonEmptyString(exact.etag)) {
    throw invalidResponse(`Drive invoice ${stage} is missing an ETag`, expected.id);
  }
  if (hasManagedMarker(exact.properties)) {
    throw conflict('Drive invoice acquired Lotus metadata during manual adoption', expected.id);
  }
  const exactParsed = parseFinalizedInvoiceFilename(exact.name);
  if (
    exactParsed == null ||
    exactParsed.invoiceNumber !== parsed.invoiceNumber ||
    exactParsed.studioSlug !== parsed.studioSlug ||
    exactParsed.monthKey !== parsed.monthKey
  ) {
    throw conflict('Drive invoice identity changed during manual adoption', expected.id);
  }
  return exact;
}

export async function adoptManualPdf(
  api: DriveApi,
  file: DriveFileRecord,
  source: CurrentInvoiceSource
): Promise<DriveFileRecord> {
  const listedFile = requireDriveFile(file);
  requirePdf(listedFile);
  requireDownloadPermission(listedFile);
  requireEditPermission(listedFile);
  if (hasManagedMarker(listedFile.properties)) {
    throw corrupt('Drive invoice already contains Lotus metadata', listedFile.id);
  }
  const parsed = parseFinalizedInvoiceFilename(listedFile.name);
  if (parsed == null) throw corrupt('Manual PDF filename is malformed', listedFile.id);
  const resolvedSource = await resolveCurrentInvoiceSource(source, parsed.invoiceNumber);
  requireAdoptionSource(resolvedSource, parsed, listedFile.id);

  const downloaded = await api.downloadFile({ fileId: listedFile.id, supportsAllDrives: true });
  if (!isRecord(downloaded) || !(downloaded.bytes instanceof Uint8Array)) {
    throw invalidResponse('Drive returned an invalid manual PDF download', listedFile.id);
  }
  const downloadedFile = requireManualSnapshot(
    downloaded.file,
    listedFile,
    parsed,
    'download',
    true
  );
  if (downloadedFile.size !== null && downloadedFile.size !== String(downloaded.bytes.byteLength)) {
    throw corrupt('Manual PDF size does not match downloaded bytes', listedFile.id);
  }
  const pdfSha256 = await sha256Hex(downloaded.bytes);
  if (downloadedFile.sha256Checksum !== null) {
    if (!HASH_PATTERN.test(downloadedFile.sha256Checksum)) {
      throw corrupt('Drive returned an invalid manual PDF SHA-256', listedFile.id);
    }
    if (downloadedFile.sha256Checksum !== pdfSha256) {
      throw corrupt('Drive manual PDF checksum disagrees with downloaded bytes', listedFile.id);
    }
  }

  const freshFile = requireDriveFile(
    await api.getFile({ fileId: listedFile.id, supportsAllDrives: true })
  );
  requireManualSnapshot(freshFile, downloadedFile, parsed, 'metadata refresh', false);
  if (!isNonEmptyString(freshFile.etag)) {
    throw invalidResponse('Manual PDF metadata response is missing an ETag', listedFile.id);
  }
  requireDownloadPermission(freshFile);
  requireEditPermission(freshFile);

  const properties: LotusPdfProperties = {
    lotusSchema: '1',
    lotusCalendarHash: resolvedSource.fingerprint.calendarSha256,
    lotusStudioSlug: parsed.studioSlug,
    lotusMonth: parsed.monthKey,
    lotusInvoiceNumber: parsed.invoiceNumber,
    lotusSourceSha256: resolvedSource.fingerprint.sourceSha256,
    lotusPdfSha256: pdfSha256,
    lotusOperationId: await adoptionOperationId(freshFile, parsed, resolvedSource, pdfSha256),
  };
  const patched = requireDriveFile(
    await api.patchMetadata({
      fileId: freshFile.id,
      properties: { ...properties },
      ifMatch: freshFile.etag,
      supportsAllDrives: true,
    })
  );
  if (
    !stableFileIdentityEqual(freshFile, patched) ||
    patched.size !== freshFile.size ||
    patched.md5Checksum !== freshFile.md5Checksum ||
    patched.sha256Checksum !== freshFile.sha256Checksum ||
    !Object.entries(freshFile.properties).every(
      ([key, value]) => patched.properties[key] === value
    ) ||
    !LOTUS_PROPERTY_KEYS.every((key) => patched.properties[key] === properties[key]) ||
    !isNonEmptyString(patched.etag) ||
    patched.etag === freshFile.etag ||
    patched.version === freshFile.version
  ) {
    throw invalidResponse('Drive returned incoherent metadata after manual adoption', file.id);
  }
  return cloneFile(patched);
}

function entry(
  item: ParsedFile,
  state: DriveInvoiceState,
  message: string | null,
  values: {
    file?: DriveFileRecord;
    sourceSha256?: string | null;
    pdfSha256?: string | null;
  } = {}
): DriveInvoiceEntry {
  return {
    key: item.parsed == null ? null : invoiceKey(item.parsed),
    file: cloneFile(values.file ?? item.file),
    filename: item.file.name,
    invoiceNumber: item.parsed?.invoiceNumber ?? null,
    state,
    sourceSha256: values.sourceSha256 ?? null,
    pdfSha256: values.pdfSha256 ?? null,
    message,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown Drive invoice error';
}

function isLocallyClassifiableError(error: unknown): error is DriveError {
  return (
    error instanceof DriveError &&
    (error.code === 'permission' ||
      error.code === 'corrupt' ||
      error.code === 'conflict' ||
      error.code === 'invalidResponse')
  );
}

async function classifyUniqueFile(
  api: DriveApi,
  item: ParsedFile,
  source: SourceIndexEntry | undefined,
  adoptManual: boolean
): Promise<DriveInvoiceEntry> {
  const parsed = item.parsed!;
  try {
    requirePdf(item.file);
    if (hasManagedMarker(item.file.properties)) {
      const properties = requireManagedProperties(item.file, parsed);
      const pdfSha256 = await verifyDrivePdf(api, item.file);
      requireDownloadPermission(item.file);
      if (source?.count === 1 && source.source != null) {
        const resolvedSource = await resolveCurrentInvoiceSource(
          source.source,
          parsed.invoiceNumber
        );
        requireAdoptionSource(resolvedSource, parsed, item.file.id);
        return entry(
          item,
          properties.lotusSourceSha256 === resolvedSource.fingerprint.sourceSha256
            ? 'fresh'
            : 'stale',
          null,
          { sourceSha256: properties.lotusSourceSha256, pdfSha256 }
        );
      }
      if (source != null && source.count > 1) {
        return entry(item, 'corrupt', 'Multiple current sources map to this invoice identity', {
          sourceSha256: properties.lotusSourceSha256,
          pdfSha256,
        });
      }
      return entry(item, 'fresh', null, {
        sourceSha256: properties.lotusSourceSha256,
        pdfSha256,
      });
    }

    if (source == null) {
      return entry(item, 'unmanaged', 'No current invoice source maps to this manual PDF');
    }
    if (source.count !== 1 || source.source == null) {
      return entry(item, 'unmanaged', 'Multiple current sources map to this manual PDF');
    }
    if (!adoptManual) {
      return entry(item, 'unmanaged', 'Manual PDF adoption is disabled for this scan');
    }
    const adopted = await adoptManualPdf(api, item.file, source.source);
    const properties = requireManagedProperties(adopted, parsed);
    if (!adopted.capabilities.canDownload) {
      return entry(item, 'permission', 'Adopted Drive invoice lacks required capabilities', {
        file: adopted,
        sourceSha256: properties.lotusSourceSha256,
        pdfSha256: properties.lotusPdfSha256,
      });
    }
    return entry(item, 'fresh', null, {
      file: adopted,
      sourceSha256: properties.lotusSourceSha256,
      pdfSha256: properties.lotusPdfSha256,
    });
  } catch (error) {
    if (!isLocallyClassifiableError(error)) throw error;
    return entry(item, error.code === 'permission' ? 'permission' : 'corrupt', errorMessage(error));
  }
}

export async function scanFinalFolder(
  api: DriveApi,
  stagedRoot: StagedDriveRoot,
  sources: readonly CurrentInvoiceSource[],
  options: DriveInvoiceScanOptions = {}
): Promise<DriveInvoiceScan> {
  const files = await listFinalChildren(api, stagedRoot);
  const parsedFiles: ParsedFile[] = files.map((file) => ({
    file,
    parsed: parseFinalizedInvoiceFilename(file.name),
  }));
  const warnings: string[] = [];
  const blockingConflicts: DriveInvoiceConflict[] = [];
  const maxSequenceByYear: Record<string, number> = {};
  const filesByKey = new Map<string, ParsedFile[]>();

  for (const item of parsedFiles) {
    if (item.parsed == null) continue;
    const year = String(item.parsed.invoiceYear);
    maxSequenceByYear[year] = Math.max(maxSequenceByYear[year] ?? 0, item.parsed.sequence);
    const serialized = keyString(invoiceKey(item.parsed));
    const group = filesByKey.get(serialized) ?? [];
    group.push(item);
    filesByKey.set(serialized, group);
  }

  const indexedSources = sourceIndex(sources);
  const entries: DriveInvoiceEntry[] = [];
  for (const item of parsedFiles) {
    if (item.parsed == null) {
      if (hasManagedMarker(item.file.properties)) {
        const message = `Managed Drive invoice has malformed filename: ${item.file.name}`;
        blockingConflicts.push({ scope: 'global', kind: 'sequenceAmbiguity', message });
        entries.push(entry(item, 'corrupt', message));
      } else {
        const message = `Malformed finalized invoice filename: ${item.file.name}`;
        warnings.push(message);
        entries.push(entry(item, 'malformed', message));
      }
      continue;
    }

    const serialized = keyString(invoiceKey(item.parsed));
    const duplicates = filesByKey.get(serialized)!;
    if (duplicates.length > 1) {
      entries.push(
        entry(
          item,
          'duplicate',
          `Multiple Drive files map to ${item.parsed.studioSlug} ${item.parsed.monthKey}`
        )
      );
      if (duplicates[0] === item) {
        blockingConflicts.push({
          scope: 'invoice',
          kind: 'duplicate',
          key: invoiceKey(item.parsed),
          message: `Duplicate invoice ${item.parsed.studioSlug} ${item.parsed.monthKey}: ${duplicates
            .map(({ file }) => file.id)
            .sort()
            .join(', ')}`,
        });
      }
      continue;
    }

    const classified = await classifyUniqueFile(
      api,
      item,
      indexedSources.get(serialized),
      options.adoptManual !== false
    );
    entries.push(classified);
    if (classified.state === 'unmanaged') {
      warnings.push(`${classified.filename}: ${classified.message}`);
    } else if (classified.state === 'corrupt' || classified.state === 'permission') {
      blockingConflicts.push({
        scope: 'invoice',
        kind: classified.state,
        key: invoiceKey(item.parsed),
        message: `${classified.filename}: ${classified.message}`,
      });
    }
  }

  return { entries, warnings, blockingConflicts, maxSequenceByYear };
}
