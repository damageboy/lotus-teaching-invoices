import type { DriveApi } from './api.js';
import { DriveError, type DriveFileRecord, type InvoiceKey } from './types.js';

const CONTROL_FILE_NAME = '.lotus-teaching-invoices.json';
const CONTROL_MIME_TYPE = 'application/json';
const CONTROL_PROPERTY_KEY = 'lotusConfigSchema';
const CONTROL_PROPERTY_VALUE = '1';
const PAGE_SIZE = 100;
const CONTROL_QUERY =
  "name = '.lotus-teaching-invoices.json' and trashed = false and properties has { key='lotusConfigSchema' and value='1' }";

export interface InvoiceReservation {
  operationId: string;
  year: number;
  invoiceNumber: string;
  studioSlug: string;
  month: string;
  fileId: string;
  sourceSha256: string;
  startedAt: string;
}

export interface DriveRootPointer {
  folderId: string;
  driveId: string | null;
  folderName: string;
}

export interface DriveControl {
  schemaVersion: 1;
  generation: number;
  root: DriveRootPointer;
  finalFolderId: string;
  sequenceByYear: Record<string, number>;
  reservation: InvoiceReservation | null;
}

export interface ControlSnapshot {
  file: DriveFileRecord;
  control: DriveControl;
}

export type ControlDiscovery =
  | { kind: 'unconfigured' }
  | { kind: 'configured'; snapshot: ControlSnapshot }
  | { kind: 'conflict'; fileIds: string[] };

export interface ReserveInvoiceRequest {
  operationId: string;
  year: number;
  studioSlug: InvoiceKey['studioSlug'];
  month: InvoiceKey['monthKey'];
  fileId: string;
  sourceSha256: string;
  startedAt: string;
}

export interface ReserveExistingInvoiceRequest extends ReserveInvoiceRequest {
  invoiceNumber: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function corrupt(message: string, fileId?: string): DriveError {
  return new DriveError('corrupt', message, false, undefined, fileId);
}

function invalidResponse(message: string, fileId?: string): DriveError {
  return new DriveError('invalidResponse', message, false, undefined, fileId);
}

function conflict(message: string, fileId?: string): DriveError {
  return new DriveError('conflict', message, false, 409, fileId);
}

function cloneReservation(reservation: InvoiceReservation | null): InvoiceReservation | null {
  return reservation == null ? null : { ...reservation };
}

function reservationsEqual(left: InvoiceReservation, right: InvoiceReservation): boolean {
  return (
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

function cloneControl(control: DriveControl): DriveControl {
  return {
    ...control,
    root: { ...control.root },
    sequenceByYear: { ...control.sequenceByYear },
    reservation: cloneReservation(control.reservation),
  };
}

function cloneFile(file: DriveFileRecord): DriveFileRecord {
  return {
    ...file,
    parents: [...file.parents],
    properties: { ...file.properties },
    capabilities: { ...file.capabilities },
  };
}

function cloneSnapshot(snapshot: ControlSnapshot, control: DriveControl): ControlSnapshot {
  return { file: cloneFile(snapshot.file), control: cloneControl(control) };
}

function requireYear(value: unknown, message: string, fileId?: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 9999) {
    throw corrupt(message, fileId);
  }
  return value as number;
}

function validateReservation(
  value: unknown,
  sequenceByYear: Readonly<Record<string, number>>,
  fileId?: string
): InvoiceReservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'operationId',
      'year',
      'invoiceNumber',
      'studioSlug',
      'month',
      'fileId',
      'sourceSha256',
      'startedAt',
    ])
  ) {
    throw corrupt('Control reservation is invalid', fileId);
  }

  const year = requireYear(value.year, 'Control reservation year is invalid', fileId);
  if (
    !isNonEmptyString(value.operationId) ||
    !isNonEmptyString(value.invoiceNumber) ||
    !isNonEmptyString(value.studioSlug) ||
    !isNonEmptyString(value.month) ||
    !isNonEmptyString(value.fileId) ||
    !isNonEmptyString(value.sourceSha256) ||
    !isNonEmptyString(value.startedAt)
  ) {
    throw corrupt('Control reservation identity is invalid', fileId);
  }

  const monthMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value.month);
  if (monthMatch == null || Number(monthMatch[1]) !== year) {
    throw corrupt('Control reservation month does not match its year', fileId);
  }

  const numberMatch = /^([1-9]\d*)\/(\d{4})$/.exec(value.invoiceNumber);
  const sequence = sequenceByYear[String(year)] ?? 0;
  const invoiceSequence = numberMatch == null ? Number.NaN : Number(numberMatch[1]);
  const nextSequence = sequence === Number.MAX_SAFE_INTEGER ? null : sequence + 1;
  if (
    numberMatch == null ||
    !Number.isSafeInteger(invoiceSequence) ||
    invoiceSequence < 1 ||
    (invoiceSequence > sequence && invoiceSequence !== nextSequence) ||
    Number(numberMatch[2]) !== year
  ) {
    throw corrupt('Control reservation number does not match its sequence', fileId);
  }

  if (!Number.isFinite(Date.parse(value.startedAt))) {
    throw corrupt('Control reservation start time is invalid', fileId);
  }

  return {
    operationId: value.operationId,
    year,
    invoiceNumber: value.invoiceNumber,
    studioSlug: value.studioSlug,
    month: value.month,
    fileId: value.fileId,
    sourceSha256: value.sourceSha256,
    startedAt: value.startedAt,
  };
}

function validateControl(value: unknown, fileId?: string): DriveControl {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'generation',
      'root',
      'finalFolderId',
      'sequenceByYear',
      'reservation',
    ])
  ) {
    throw corrupt('Drive control content is invalid', fileId);
  }
  if (value.schemaVersion !== 1) {
    throw corrupt('Drive control schema version is unsupported', fileId);
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw corrupt('Drive control generation is invalid', fileId);
  }
  if (!isRecord(value.root) || !hasExactKeys(value.root, ['folderId', 'driveId', 'folderName'])) {
    throw corrupt('Drive control root is invalid', fileId);
  }
  if (
    !isNonEmptyString(value.root.folderId) ||
    (value.root.driveId !== null && !isNonEmptyString(value.root.driveId)) ||
    !isNonEmptyString(value.root.folderName)
  ) {
    throw corrupt('Drive control root fields are invalid', fileId);
  }
  if (!isNonEmptyString(value.finalFolderId)) {
    throw corrupt('Drive control final folder is invalid', fileId);
  }
  if (!isRecord(value.sequenceByYear)) {
    throw corrupt('Drive control sequence map is invalid', fileId);
  }

  const sequenceByYear: Record<string, number> = {};
  for (const [year, sequence] of Object.entries(value.sequenceByYear)) {
    if (!/^[1-9]\d{3}$/.test(year) || !Number.isSafeInteger(sequence) || (sequence as number) < 0) {
      throw corrupt('Drive control sequence entry is invalid', fileId);
    }
    sequenceByYear[year] = sequence as number;
  }

  const reservation =
    value.reservation === null
      ? null
      : validateReservation(value.reservation, sequenceByYear, fileId);

  return {
    schemaVersion: 1,
    generation: value.generation as number,
    root: {
      folderId: value.root.folderId,
      driveId: value.root.driveId as string | null,
      folderName: value.root.folderName,
    },
    finalFolderId: value.finalFolderId,
    sequenceByYear,
    reservation,
  };
}

function isControlCandidate(file: DriveFileRecord): boolean {
  return (
    file.name === CONTROL_FILE_NAME &&
    file.mimeType === CONTROL_MIME_TYPE &&
    file.properties[CONTROL_PROPERTY_KEY] === CONTROL_PROPERTY_VALUE &&
    file.ownedByMe === true &&
    file.driveId === null &&
    file.trashed === false
  );
}

function requireExactControlFile(file: DriveFileRecord, expectedFileId: string): DriveFileRecord {
  if (file.id !== expectedFileId || !isControlCandidate(file)) {
    throw invalidResponse('Drive returned a different control file', expectedFileId);
  }
  if (!isNonEmptyString(file.etag)) {
    throw invalidResponse('Drive control file response is missing an ETag', expectedFileId);
  }
  return file;
}

function stringMapEquals(
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

function exactFilesAreCoherent(metadata: DriveFileRecord, media: DriveFileRecord): boolean {
  return (
    metadata.etag === media.etag &&
    metadata.id === media.id &&
    metadata.name === media.name &&
    metadata.mimeType === media.mimeType &&
    metadata.parents.length === media.parents.length &&
    metadata.parents.every((parent, index) => parent === media.parents[index]) &&
    metadata.driveId === media.driveId &&
    metadata.ownedByMe === media.ownedByMe &&
    metadata.trashed === media.trashed &&
    stringMapEquals(metadata.properties, media.properties) &&
    metadata.capabilities.canListChildren === media.capabilities.canListChildren &&
    metadata.capabilities.canAddChildren === media.capabilities.canAddChildren &&
    metadata.capabilities.canEdit === media.capabilities.canEdit &&
    metadata.capabilities.canDownload === media.capabilities.canDownload
  );
}

function parseControlBytes(bytes: Uint8Array, fileId: string): DriveControl {
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw corrupt('Drive control file is not valid JSON', fileId);
  }
  return validateControl(parsed, fileId);
}

export class DriveControlRepository {
  constructor(private readonly api: DriveApi) {}

  private async listCandidates(): Promise<DriveFileRecord[]> {
    const candidatesById = new Map<string, DriveFileRecord>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;

    do {
      const page = await this.api.listFiles({
        query: CONTROL_QUERY,
        corpora: 'user',
        ...(pageToken == null ? {} : { pageToken }),
        pageSize: PAGE_SIZE,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      for (const candidate of page.items.filter(isControlCandidate)) {
        if (!candidatesById.has(candidate.id)) candidatesById.set(candidate.id, candidate);
      }

      if (page.nextPageToken == null) return [...candidatesById.values()];
      if (!isNonEmptyString(page.nextPageToken)) {
        throw invalidResponse('Drive returned a blank control-file page token');
      }
      if (seenPageTokens.has(page.nextPageToken)) {
        throw invalidResponse('Drive repeated a control-file page token');
      }
      seenPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    } while (true);
  }

  private async load(fileId: string): Promise<ControlSnapshot> {
    const metadata = await this.api.getFile({ fileId, supportsAllDrives: true });
    requireExactControlFile(metadata, fileId);

    const downloaded = await this.api.downloadFile({ fileId, supportsAllDrives: true });
    const exactFile = requireExactControlFile(downloaded.file, fileId);
    if (!exactFilesAreCoherent(metadata, exactFile)) {
      throw invalidResponse('Drive control metadata and media are incoherent', fileId);
    }
    return {
      file: cloneFile(exactFile),
      control: parseControlBytes(downloaded.bytes, fileId),
    };
  }

  async discover(): Promise<ControlDiscovery> {
    const candidates = await this.listCandidates();
    if (candidates.length === 0) return { kind: 'unconfigured' };
    if (candidates.length > 1) {
      return { kind: 'conflict', fileIds: candidates.map(({ id }) => id).sort() };
    }
    return { kind: 'configured', snapshot: await this.load(candidates[0]!.id) };
  }

  async create(initial: DriveControl): Promise<ControlSnapshot> {
    const validated = validateControl(initial);
    const generatedIds = await this.api.generateFileIds(1);
    if (generatedIds.length !== 1 || !isNonEmptyString(generatedIds[0])) {
      throw invalidResponse('Drive did not return exactly one generated file ID');
    }
    const fileId = generatedIds[0];

    const before = await this.listCandidates();
    if (before.length !== 0) {
      throw conflict('A Drive control file appeared during setup', before[0]?.id);
    }

    await this.api.createFile({
      fileId,
      name: CONTROL_FILE_NAME,
      mimeType: CONTROL_MIME_TYPE,
      parents: ['root'],
      properties: { [CONTROL_PROPERTY_KEY]: CONTROL_PROPERTY_VALUE },
      bytes: Array.from(new TextEncoder().encode(JSON.stringify(validated))),
      supportsAllDrives: true,
    });

    const after = await this.listCandidates();
    if (after.length !== 1 || after[0]?.id !== fileId) {
      throw conflict('Drive control-file creation raced with another setup', fileId);
    }
    return this.load(fileId);
  }

  async replace(snapshot: ControlSnapshot, next: DriveControl): Promise<ControlSnapshot> {
    const current = validateControl(snapshot.control, snapshot.file.id);
    requireExactControlFile(snapshot.file, snapshot.file.id);
    const validatedNext = validateControl(next, snapshot.file.id);
    if (current.generation === Number.MAX_SAFE_INTEGER) {
      throw corrupt('Drive control generation cannot be incremented', snapshot.file.id);
    }
    const updatedControl = { ...validatedNext, generation: current.generation + 1 };

    const updatedFile = await this.api.updateFile({
      fileId: snapshot.file.id,
      name: CONTROL_FILE_NAME,
      mimeType: CONTROL_MIME_TYPE,
      parents: [...snapshot.file.parents],
      properties: {
        ...snapshot.file.properties,
        [CONTROL_PROPERTY_KEY]: CONTROL_PROPERTY_VALUE,
      },
      bytes: Array.from(new TextEncoder().encode(JSON.stringify(updatedControl))),
      supportsAllDrives: true,
      ifMatch: snapshot.file.etag!,
    });
    requireExactControlFile(updatedFile, snapshot.file.id);
    return { file: cloneFile(updatedFile), control: cloneControl(updatedControl) };
  }
}

export function reserveNextInvoice(
  snapshot: ControlSnapshot,
  request: ReserveInvoiceRequest
): ControlSnapshot {
  const current = validateControl(snapshot.control, snapshot.file.id);
  const year = requireYear(request.year, 'Reservation year is invalid', snapshot.file.id);
  const sequence = current.sequenceByYear[String(year)] ?? 0;
  if (sequence === Number.MAX_SAFE_INTEGER) {
    throw corrupt('Invoice sequence cannot be incremented', snapshot.file.id);
  }

  const reservation = validateReservation(
    {
      ...request,
      year,
      invoiceNumber: `${sequence + 1}/${year}`,
    },
    current.sequenceByYear,
    snapshot.file.id
  );
  if (current.reservation !== null) {
    if (reservationsEqual(current.reservation, reservation)) {
      return cloneSnapshot(snapshot, current);
    }
    throw conflict('A different Drive invoice reservation already exists', snapshot.file.id);
  }
  return cloneSnapshot(snapshot, { ...current, reservation });
}

export function reserveExistingInvoice(
  snapshot: ControlSnapshot,
  request: ReserveExistingInvoiceRequest
): ControlSnapshot {
  const current = validateControl(snapshot.control, snapshot.file.id);
  const year = requireYear(request.year, 'Reservation year is invalid', snapshot.file.id);
  const numberMatch = /^([1-9]\d*)\/(\d{4})$/.exec(request.invoiceNumber);
  const invoiceSequence = numberMatch == null ? Number.NaN : Number(numberMatch[1]);
  const sequence = current.sequenceByYear[String(year)] ?? 0;
  if (
    numberMatch == null ||
    !Number.isSafeInteger(invoiceSequence) ||
    invoiceSequence < 1 ||
    invoiceSequence > sequence ||
    Number(numberMatch[2]) !== year
  ) {
    throw corrupt('Existing invoice lease number does not match its sequence', snapshot.file.id);
  }
  const reservation = validateReservation(request, current.sequenceByYear, snapshot.file.id);
  if (current.reservation !== null) {
    if (reservationsEqual(current.reservation, reservation)) {
      return cloneSnapshot(snapshot, current);
    }
    throw conflict('A different Drive invoice reservation already exists', snapshot.file.id);
  }
  return cloneSnapshot(snapshot, { ...current, reservation });
}

export function commitReservation(snapshot: ControlSnapshot, operationId: string): ControlSnapshot {
  const current = validateControl(snapshot.control, snapshot.file.id);
  if (current.reservation === null || current.reservation.operationId !== operationId) {
    throw conflict('Drive invoice reservation does not match this operation', snapshot.file.id);
  }
  const reservation = validateReservation(
    current.reservation,
    current.sequenceByYear,
    snapshot.file.id
  );
  const number = Number(reservation.invoiceNumber.slice(0, reservation.invoiceNumber.indexOf('/')));
  const currentSequence = current.sequenceByYear[String(reservation.year)] ?? 0;
  return cloneSnapshot(snapshot, {
    ...current,
    sequenceByYear: {
      ...current.sequenceByYear,
      [String(reservation.year)]: Math.max(currentSequence, number),
    },
    reservation: null,
  });
}
