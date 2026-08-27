import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createIsolatedE2eRun, removeIsolatedE2eRun } from './helpers.js';

export interface FakeGoogleCalendar {
  baseUrl: string;
  calendarBaseUrl: string;
  driveApiBaseUrl: string;
  driveUploadBaseUrl: string;
  gmailApiBaseUrl: string;
  controlUrl: string;
  close(): Promise<void>;
}

interface CalendarListEntry {
  id: string;
  summary: string;
  accessRole: string;
}

interface FakeEvent {
  id: string;
  etag: string;
  summary?: string;
  description?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  updated?: string;
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  recurrence?: string[];
  e2eMaster?: boolean;
  e2eExceptions?: Array<'summary' | 'description'>;
}

interface Fixture {
  pageSize: number;
  calendarPageSize: number;
  calendarList: CalendarListEntry[];
  events: FakeEvent[];
}

interface DriveFixtureFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  driveId: string | null;
  ownedByMe: boolean;
  properties?: Record<string, string>;
  bytesUtf8?: string;
  capabilities: {
    canListChildren: boolean;
    canAddChildren: boolean;
    canEdit: boolean;
    canDownload: boolean;
  };
}

interface DriveFixture {
  pageSize: number;
  sharedDrives: Array<{ id: string; name: string }>;
  files: DriveFixtureFile[];
}

interface FakeDriveFile extends DriveFixtureFile {
  trashed: boolean;
  version: number;
  etag: string;
  bytes: Buffer;
}

interface CapturedGmailDraft {
  id: string;
  raw: string;
  rawSha256: string;
  attachmentSha256: string | null;
}

export interface FakeGoogleRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  ifMatch?: string;
  body?: unknown;
  authPresent?: boolean;
  metadata?: unknown;
  bodySha256?: string;
  responseStatus?: number;
}

interface ConfiguredError {
  method: string;
  path: string;
  status: number;
  body: unknown;
  nthMatch: number;
  matches: number;
  remaining: number;
}

interface ArmedUploadMutation {
  fileId: string;
  properties: Record<string, string>;
  bytes: Buffer | null;
}

interface CalendarPageCursor {
  kind: 'calendars';
  offset: number;
  snapshot: CalendarListEntry[];
}

interface EventPageCursor {
  kind: 'events';
  calendarId: string;
  mode: 'full' | 'incremental';
  syncToken: string | null;
  singleEvents: 'true';
  maxResults: '250';
  revision: number;
  offset: number;
  snapshot: FakeEvent[];
}

type PageCursor = CalendarPageCursor | EventPageCursor;

const ACCESS_TOKEN = 'e2e-access-token';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PDF_OR_GMAIL_BODY_BYTES = 10 * 1024 * 1024;
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const raw = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(raw),
    ...headers,
  });
  response.end(raw);
}

function empty(response: ServerResponse, status = 204): void {
  response.writeHead(status);
  response.end();
}

function googleError(response: ServerResponse, status: number, message: string): void {
  json(response, status, {
    error: {
      code: status,
      message,
      errors: [{ reason: status === 412 ? 'conditionNotMet' : 'invalid' }],
    },
  });
}

async function readBytes(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const bytes = await readBytes(request, maxBytes);
  if (bytes.length === 0) return null;
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function hash(algorithm: 'md5' | 'sha256', bytes: Uint8Array | string): string {
  return createHash(algorithm).update(bytes).digest('hex');
}

function driveFileFromFixture(file: DriveFixtureFile): FakeDriveFile {
  const bytes = Buffer.from(file.bytesUtf8 ?? '', 'utf8');
  return {
    ...clone(file),
    properties: { ...(file.properties ?? {}) },
    trashed: false,
    version: 1,
    etag: `"${file.id}-v1"`,
    bytes,
  };
}

function publicDriveFile(file: FakeDriveFile): Record<string, unknown> {
  const checksummed = file.bytes.length > 0 && file.mimeType !== FOLDER_MIME_TYPE;
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parents: [...file.parents],
    driveId: file.driveId,
    ownedByMe: file.ownedByMe,
    trashed: file.trashed,
    version: String(file.version),
    size: file.mimeType === FOLDER_MIME_TYPE ? null : String(file.bytes.length),
    md5Checksum: checksummed ? hash('md5', file.bytes) : null,
    sha256Checksum: checksummed ? hash('sha256', file.bytes) : null,
    properties: { ...(file.properties ?? {}) },
    capabilities: { ...file.capabilities },
  };
}

function parseMultipart(
  contentType: string | undefined,
  body: Buffer
): { metadata: Record<string, unknown>; bytes: Buffer } {
  const match = /^multipart\/related;\s*boundary=(?:"([^"]+)"|([^;\s]+))$/i.exec(contentType ?? '');
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new Error('multipart/related boundary is required');
  const opening = Buffer.from(`--${boundary}\r\n`);
  const separator = Buffer.from(`\r\n--${boundary}\r\n`);
  const closing = Buffer.from(`\r\n--${boundary}--`);
  if (!body.subarray(0, opening.length).equals(opening)) {
    throw new Error('invalid multipart opening boundary');
  }
  const secondBoundary = body.indexOf(separator, opening.length);
  const closingBoundary = body.indexOf(closing, secondBoundary + separator.length);
  if (secondBoundary < 0 || closingBoundary < 0) throw new Error('invalid multipart framing');
  const metadataPart = body.subarray(opening.length, secondBoundary);
  const metadataHeaderEnd = metadataPart.indexOf(Buffer.from('\r\n\r\n'));
  const mediaPart = body.subarray(secondBoundary + separator.length, closingBoundary);
  const mediaHeaderEnd = mediaPart.indexOf(Buffer.from('\r\n\r\n'));
  if (metadataHeaderEnd < 0 || mediaHeaderEnd < 0) throw new Error('invalid multipart headers');
  if (!metadataPart.subarray(0, metadataHeaderEnd).toString().includes('application/json')) {
    throw new Error('multipart metadata must be JSON');
  }
  const metadata = JSON.parse(
    metadataPart.subarray(metadataHeaderEnd + 4).toString('utf8')
  ) as unknown;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('multipart metadata must be an object');
  }
  return {
    metadata: metadata as Record<string, unknown>,
    bytes: Buffer.from(mediaPart.subarray(mediaHeaderEnd + 4)),
  };
}

function parseV2Properties(value: unknown): Record<string, string> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error('Drive v2 properties must be an array');
  const properties: Record<string, string> = {};
  for (const property of value) {
    if (
      typeof property !== 'object' ||
      property === null ||
      Array.isArray(property) ||
      typeof (property as Record<string, unknown>).key !== 'string' ||
      typeof (property as Record<string, unknown>).value !== 'string' ||
      (property as Record<string, unknown>).visibility !== 'PUBLIC'
    ) {
      throw new Error('invalid Drive v2 public property');
    }
    const entry = property as { key: string; value: string };
    properties[entry.key] = entry.value;
  }
  return properties;
}

function extractAttachmentSha256(raw: string): string | null {
  try {
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    const match =
      /Content-Type: application\/pdf[^]*?Content-Transfer-Encoding: base64[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/i.exec(
        mime
      );
    if (!match) return null;
    return hash('sha256', Buffer.from(match[1]!.replace(/\s/g, ''), 'base64'));
  } catch {
    return null;
  }
}

function decodeDriveQueryValue(value: string): string {
  return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function driveQueryString(query: string, expression: RegExp): string | null {
  const match = expression.exec(query);
  return match ? decodeDriveQueryValue(match[1]!) : null;
}

function publicEvent(event: FakeEvent): Record<string, unknown> {
  const { e2eMaster: _master, e2eExceptions: _exceptions, ...visible } = clone(event);
  return visible;
}

function exactPatch(value: unknown): value is { summary: string } | { description: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length === 1 &&
    (entries[0]?.[0] === 'summary' || entries[0]?.[0] === 'description') &&
    typeof entries[0]?.[1] === 'string'
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function isFakeEventMutation(value: unknown): value is FakeEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const allowed = new Set([
    'id',
    'etag',
    'summary',
    'description',
    'status',
    'start',
    'end',
    'updated',
    'recurringEventId',
    'originalStartTime',
    'recurrence',
    'e2eMaster',
    'e2eExceptions',
  ]);
  return (
    Object.keys(event).every((key) => allowed.has(key)) &&
    typeof event.id === 'string' &&
    typeof event.etag === 'string'
  );
}

export async function startFakeGoogleCalendar(fixturePath: string): Promise<FakeGoogleCalendar> {
  const original = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;
  const originalDrive = JSON.parse(
    await readFile(
      fileURLToPath(new URL('../fixtures/e2e-google-drive.json', import.meta.url)),
      'utf8'
    )
  ) as DriveFixture;
  if (!Number.isInteger(original.pageSize) || original.pageSize < 1) {
    throw new Error('Fake Google fixture requires a positive pageSize');
  }
  if (!Number.isInteger(original.calendarPageSize) || original.calendarPageSize < 1) {
    throw new Error('Fake Google fixture requires a positive calendarPageSize');
  }
  if (!Number.isInteger(originalDrive.pageSize) || originalDrive.pageSize < 1) {
    throw new Error('Fake Google Drive fixture requires a positive pageSize');
  }

  let fixture = clone(original);
  let events = new Map(fixture.events.map((event) => [event.id, clone(event)]));
  let revision = 1;
  let etagRevision = 1;
  let requestLog: FakeGoogleRequest[] = [];
  let nextError: ConfiguredError | null = null;
  let pageCursors = new Map<string, PageCursor>();
  let changes = new Map<number, FakeEvent[]>([
    [1, fixture.events.filter((event) => !event.e2eMaster).map(clone)],
  ]);
  let driveFiles = new Map(
    originalDrive.files.map((file) => [file.id, driveFileFromFixture(file)])
  );
  let generatedId = 0;
  let capturedDrafts: CapturedGmailDraft[] = [];
  let interruptNextUpload = false;
  let mutateBeforeUploadPatch: ArmedUploadMutation | null = null;

  const sendConfiguredError = (method: string, path: string, response: ServerResponse): boolean => {
    if (!nextError || nextError.method !== method || nextError.path !== path) return false;
    nextError.matches += 1;
    if (nextError.matches < nextError.nthMatch || nextError.remaining < 1) return false;
    const configured = nextError;
    configured.remaining -= 1;
    if (configured.remaining === 0) nextError = null;
    json(response, configured.status, configured.body);
    return true;
  };

  const issuePageToken = (cursor: PageCursor): string => {
    let token: string;
    do token = randomBytes(24).toString('base64url');
    while (pageCursors.has(token));
    pageCursors.set(token, clone(cursor));
    return token;
  };

  const pageCursor = (token: string, kind: PageCursor['kind']): PageCursor | null => {
    const cursor = pageCursors.get(token);
    return cursor?.kind === kind ? clone(cursor) : null;
  };

  const resetState = () => {
    fixture = clone(original);
    events = new Map(fixture.events.map((event) => [event.id, clone(event)]));
    revision = 1;
    etagRevision = 1;
    requestLog = [];
    nextError = null;
    pageCursors = new Map();
    changes = new Map([[1, fixture.events.filter((event) => !event.e2eMaster).map(clone)]]);
    driveFiles = new Map(originalDrive.files.map((file) => [file.id, driveFileFromFixture(file)]));
    generatedId = 0;
    capturedDrafts = [];
    interruptNextUpload = false;
    mutateBeforeUploadPatch = null;
  };

  const recordChanges = (changed: FakeEvent[]) => {
    revision += 1;
    changes.set(revision, changed.map(clone));
  };

  const nextEtag = (id: string) => `\"${id}-v${++etagRevision}\"`;

  const hasValidAuthorization = (request: IncomingMessage): boolean =>
    [ACCESS_TOKEN, DESKTOP_TOKEN, ANDROID_TOKEN].some(
      (token) => request.headers.authorization === `Bearer ${token}`
    );

  const recordRequest = (
    request: IncomingMessage,
    method: string,
    url: URL,
    details: Pick<FakeGoogleRequest, 'body' | 'metadata' | 'bodySha256'> = {}
  ): void => {
    requestLog.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ...(request.headers['if-match'] ? { ifMatch: String(request.headers['if-match']) } : {}),
      authPresent: request.headers.authorization?.startsWith('Bearer ') === true,
      ...details,
    });
  };

  const requireDriveFile = (
    fileId: string,
    supportsAllDrives: boolean,
    response: ServerResponse,
    allowTrashed = false
  ): FakeDriveFile | null => {
    const file = driveFiles.get(fileId === 'root' ? 'my-drive-root' : fileId);
    if (!file || (!allowTrashed && file.trashed)) {
      googleError(response, 404, 'Drive file not found');
      return null;
    }
    if (file.driveId !== null && !supportsAllDrives) {
      googleError(response, 400, 'Shared Drive operation requires supportsAllDrives=true');
      return null;
    }
    return file;
  };

  const writeDriveFile = (response: ServerResponse, file: FakeDriveFile, status = 200): void =>
    json(response, status, publicDriveFile(file), { ETag: file.etag });

  const nextDriveVersion = (file: FakeDriveFile): void => {
    file.version += 1;
    file.etag = `"${file.id}-v${file.version}"`;
  };

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? '';
      const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
      const url = new URL(request.url ?? '/', origin);

      if (url.pathname.startsWith('/__e2e__/')) {
        if (method === 'GET' && url.pathname === '/__e2e__/requests' && !url.search) {
          json(response, 200, requestLog);
          return;
        }
        if (method === 'POST' && url.pathname === '/__e2e__/reset' && !url.search) {
          if ((await readJson(request)) !== null) {
            googleError(response, 400, 'reset accepts no body');
            return;
          }
          resetState();
          empty(response);
          return;
        }
        if (method === 'GET' && url.pathname === '/__e2e__/state' && !url.search) {
          json(response, 200, {
            files: [...driveFiles.values()].map((file) => ({
              ...publicDriveFile(file),
              etag: file.etag,
              bodySha256: hash('sha256', file.bytes),
              bytesBase64: file.bytes.toString('base64'),
            })),
            drafts: clone(capturedDrafts),
          });
          return;
        }
        if (method === 'POST' && url.pathname === '/__e2e__/interrupt-next-upload' && !url.search) {
          if ((await readJson(request)) !== null) {
            googleError(response, 400, 'interrupt-next-upload accepts no body');
            return;
          }
          interruptNextUpload = true;
          empty(response);
          return;
        }
        if (
          method === 'POST' &&
          url.pathname === '/__e2e__/mutate-before-upload-patch' &&
          !url.search
        ) {
          const candidate = (await readJson(request)) as Record<string, unknown> | null;
          const patch = candidate?.patch as Record<string, unknown> | undefined;
          if (
            !candidate ||
            !hasExactKeys(candidate, ['fileId', 'patch']) ||
            typeof candidate.fileId !== 'string' ||
            !driveFiles.has(candidate.fileId) ||
            !patch ||
            Object.keys(patch).some((key) => key !== 'properties' && key !== 'bytesBase64') ||
            (patch.properties !== undefined &&
              (typeof patch.properties !== 'object' ||
                patch.properties === null ||
                Array.isArray(patch.properties) ||
                Object.values(patch.properties).some((value) => typeof value !== 'string'))) ||
            (patch.bytesBase64 !== undefined && typeof patch.bytesBase64 !== 'string')
          ) {
            googleError(response, 400, 'invalid upload pre-mutation');
            return;
          }
          mutateBeforeUploadPatch = {
            fileId: candidate.fileId,
            properties: { ...((patch.properties as Record<string, string> | undefined) ?? {}) },
            bytes:
              typeof patch.bytesBase64 === 'string'
                ? Buffer.from(patch.bytesBase64, 'base64')
                : null,
          };
          empty(response);
          return;
        }
        if (method === 'POST' && url.pathname === '/__e2e__/next-error' && !url.search) {
          const candidate = await readJson(request);
          const candidateRecord = candidate as Record<string, unknown> | null;
          const candidateKeys = candidateRecord ? Object.keys(candidateRecord) : [];
          const allowedKeys = new Set(['body', 'method', 'nthMatch', 'path', 'status', 'times']);
          if (
            typeof candidate !== 'object' ||
            candidate === null ||
            Array.isArray(candidate) ||
            !['body', 'method', 'path', 'status'].every((key) => candidateKeys.includes(key)) ||
            candidateKeys.some((key) => !allowedKeys.has(key)) ||
            typeof candidateRecord?.method !== 'string' ||
            typeof candidateRecord.path !== 'string' ||
            !Number.isInteger(candidateRecord.status) ||
            (candidateRecord.nthMatch !== undefined &&
              (!Number.isInteger(candidateRecord.nthMatch) ||
                Number(candidateRecord.nthMatch) < 1)) ||
            (candidateRecord.times !== undefined &&
              (!Number.isInteger(candidateRecord.times) || Number(candidateRecord.times) < 1))
          ) {
            googleError(response, 400, 'invalid configured error');
            return;
          }
          nextError = {
            method: candidateRecord.method,
            path: candidateRecord.path,
            status: Number(candidateRecord.status),
            body: clone(candidateRecord.body),
            nthMatch: Number(candidateRecord.nthMatch ?? 1),
            matches: 0,
            remaining: Number(candidateRecord.times ?? 1),
          };
          empty(response);
          return;
        }
        if (method === 'POST' && url.pathname === '/__e2e__/mutate' && !url.search) {
          const mutation = (await readJson(request)) as Record<string, unknown> | null;
          if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
            googleError(response, 400, 'invalid mutation');
            return;
          }
          if (
            mutation.type === 'driveReset' &&
            hasExactKeys(mutation, ['type', 'unconfigured']) &&
            typeof mutation.unconfigured === 'boolean'
          ) {
            driveFiles = new Map(
              originalDrive.files
                .filter(
                  (file) => !mutation.unconfigured || file.properties?.lotusConfigSchema !== '1'
                )
                .map((file) => [file.id, driveFileFromFixture(file)])
            );
            generatedId = 0;
            capturedDrafts = [];
            interruptNextUpload = false;
            empty(response);
            return;
          }
          if (
            mutation.type === 'drivePatch' &&
            hasExactKeys(mutation, ['type', 'fileId', 'patch']) &&
            typeof mutation.fileId === 'string' &&
            typeof mutation.patch === 'object' &&
            mutation.patch !== null &&
            !Array.isArray(mutation.patch)
          ) {
            const file = driveFiles.get(mutation.fileId);
            if (!file) {
              googleError(response, 404, 'Drive file not found');
              return;
            }
            const patch = mutation.patch as Record<string, unknown>;
            const allowed = new Set([
              'name',
              'properties',
              'bytesBase64',
              'capabilities',
              'trashed',
            ]);
            if (Object.keys(patch).some((key) => !allowed.has(key))) {
              googleError(response, 400, 'unsupported Drive patch');
              return;
            }
            if (typeof patch.name === 'string') file.name = patch.name;
            if (
              typeof patch.properties === 'object' &&
              patch.properties !== null &&
              !Array.isArray(patch.properties)
            ) {
              file.properties = {
                ...(file.properties ?? {}),
                ...(patch.properties as Record<string, string>),
              };
            }
            if (typeof patch.bytesBase64 === 'string') {
              file.bytes = Buffer.from(patch.bytesBase64, 'base64');
            }
            if (
              typeof patch.capabilities === 'object' &&
              patch.capabilities !== null &&
              !Array.isArray(patch.capabilities)
            ) {
              file.capabilities = {
                ...file.capabilities,
                ...(patch.capabilities as Partial<FakeDriveFile['capabilities']>),
              };
            }
            if (typeof patch.trashed === 'boolean') file.trashed = patch.trashed;
            file.version += 1;
            file.etag = `"${file.id}-v${file.version}"`;
            empty(response);
            return;
          }
          if (
            mutation.type === 'driveUpsert' &&
            hasExactKeys(mutation, ['type', 'file']) &&
            typeof mutation.file === 'object' &&
            mutation.file !== null &&
            !Array.isArray(mutation.file)
          ) {
            const candidate = mutation.file as Record<string, unknown>;
            if (
              typeof candidate.id !== 'string' ||
              typeof candidate.name !== 'string' ||
              typeof candidate.mimeType !== 'string' ||
              !Array.isArray(candidate.parents) ||
              !candidate.parents.every((parent) => typeof parent === 'string') ||
              !(candidate.driveId === null || typeof candidate.driveId === 'string') ||
              typeof candidate.ownedByMe !== 'boolean' ||
              typeof candidate.bytesBase64 !== 'string'
            ) {
              googleError(response, 400, 'invalid Drive upsert');
              return;
            }
            const prior = driveFiles.get(candidate.id);
            const version = prior ? prior.version + 1 : 1;
            driveFiles.set(candidate.id, {
              id: candidate.id,
              name: candidate.name,
              mimeType: candidate.mimeType,
              parents: [...(candidate.parents as string[])],
              driveId: candidate.driveId as string | null,
              ownedByMe: candidate.ownedByMe,
              properties: { ...((candidate.properties as Record<string, string>) ?? {}) },
              capabilities: {
                canListChildren: false,
                canAddChildren: false,
                canEdit: true,
                canDownload: true,
                ...((candidate.capabilities as Partial<FakeDriveFile['capabilities']>) ?? {}),
              },
              trashed: candidate.trashed === true,
              version,
              etag: `"${candidate.id}-v${version}"`,
              bytes: Buffer.from(candidate.bytesBase64, 'base64'),
            });
            empty(response);
            return;
          }
          if (
            mutation.type === 'patch' &&
            hasExactKeys(mutation, ['type', 'eventId', 'patch']) &&
            typeof mutation.eventId === 'string' &&
            exactPatch(mutation.patch)
          ) {
            const event = events.get(mutation.eventId);
            if (!event) {
              googleError(response, 404, 'event not found');
              return;
            }
            Object.assign(event, mutation.patch);
            event.etag = nextEtag(event.id);
            event.updated = `2026-08-01T10:00:${String(revision).padStart(2, '0')}.000Z`;
            recordChanges(event.e2eMaster ? [] : [event]);
            empty(response);
            return;
          }
          if (
            mutation.type === 'delete' &&
            hasExactKeys(mutation, ['type', 'eventId']) &&
            typeof mutation.eventId === 'string'
          ) {
            const event = events.get(mutation.eventId);
            if (!event || event.e2eMaster) {
              googleError(response, 404, 'expanded event not found');
              return;
            }
            event.status = 'cancelled';
            event.etag = nextEtag(event.id);
            recordChanges([event]);
            empty(response);
            return;
          }
          if (
            mutation.type === 'upsert' &&
            hasExactKeys(mutation, ['type', 'event']) &&
            isFakeEventMutation(mutation.event)
          ) {
            const event = clone(mutation.event);
            events.set(event.id, event);
            recordChanges(event.e2eMaster ? [] : [event]);
            empty(response);
            return;
          }
          googleError(response, 400, 'unsupported mutation');
          return;
        }
        googleError(response, 404, 'unexpected control endpoint');
        return;
      }

      if (
        url.pathname.startsWith('/drive/v3/') ||
        url.pathname.startsWith('/upload/drive/v3/') ||
        url.pathname.startsWith('/drive/v2/') ||
        url.pathname.startsWith('/upload/drive/v2/') ||
        url.pathname.startsWith('/gmail/v1/')
      ) {
        if (!hasValidAuthorization(request)) {
          recordRequest(request, method, url);
          googleError(response, 401, 'invalid test authorization');
          return;
        }

        if (method === 'GET' && url.pathname === '/drive/v3/drives') {
          const allowed = new Set(['fields', 'pageSize', 'pageToken']);
          if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
            googleError(response, 400, 'unexpected Shared Drives query');
            return;
          }
          recordRequest(request, method, url);
          if (sendConfiguredError(method, url.pathname, response)) return;
          const pageSize = Number(url.searchParams.get('pageSize') ?? originalDrive.pageSize);
          const pageToken = url.searchParams.get('pageToken');
          const offset =
            pageToken === null ? 0 : Number(/^shared-drives:(\d+)$/.exec(pageToken)?.[1]);
          if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(offset)) {
            googleError(response, 400, 'invalid Shared Drives pagination');
            return;
          }
          const drives = originalDrive.sharedDrives.slice(offset, offset + pageSize).map(clone);
          const nextOffset = offset + drives.length;
          json(response, 200, {
            drives,
            ...(nextOffset < originalDrive.sharedDrives.length
              ? { nextPageToken: `shared-drives:${nextOffset}` }
              : {}),
          });
          return;
        }

        if (method === 'GET' && url.pathname === '/drive/v3/files/generateIds') {
          recordRequest(request, method, url);
          const count = Number(url.searchParams.get('count'));
          if (
            !Number.isSafeInteger(count) ||
            count < 1 ||
            url.searchParams.get('space') !== 'drive'
          ) {
            googleError(response, 400, 'invalid generated ID request');
            return;
          }
          if (sendConfiguredError(method, url.pathname, response)) return;
          const ids = Array.from({ length: count }, () => `generated-${++generatedId}`);
          json(response, 200, { ids });
          return;
        }

        if (method === 'GET' && url.pathname === '/drive/v3/files') {
          recordRequest(request, method, url);
          const corpora = url.searchParams.get('corpora');
          const includeAll = url.searchParams.get('includeItemsFromAllDrives') === 'true';
          const supportsAll = url.searchParams.get('supportsAllDrives') === 'true';
          const driveId = url.searchParams.get('driveId');
          if (
            (corpora !== 'user' && corpora !== 'drive') ||
            (corpora === 'drive' && (!driveId || !includeAll || !supportsAll))
          ) {
            googleError(response, 400, 'invalid Drive file listing flags');
            return;
          }
          if (sendConfiguredError(method, url.pathname, response)) return;
          const query = url.searchParams.get('q') ?? '';
          const parentId = driveQueryString(query, /'((?:\\'|[^'])*)' in parents/);
          const name = driveQueryString(query, /name = '((?:\\'|[^'])*)'/);
          const mimeType = driveQueryString(query, /mimeType = '((?:\\'|[^'])*)'/);
          const property =
            /properties has \{ key='((?:\\'|[^'])*)' and value='((?:\\'|[^'])*)' \}/.exec(query);
          const propertyKey = property ? decodeDriveQueryValue(property[1]!) : null;
          const propertyValue = property ? decodeDriveQueryValue(property[2]!) : null;
          const trashedMatch = /(?:^| and )trashed = (true|false)(?:$| and )/.exec(query);
          const trashed = trashedMatch ? trashedMatch[1] === 'true' : null;
          if (parentId) {
            const parent = driveFiles.get(parentId);
            if (parent && !parent.capabilities.canListChildren) {
              googleError(response, 403, 'Drive parent cannot list children');
              return;
            }
          }
          const matches = [...driveFiles.values()]
            .filter((file) => {
              if (corpora === 'drive' && file.driveId !== driveId) return false;
              if (!includeAll && file.driveId !== null) return false;
              if (parentId && !file.parents.includes(parentId)) return false;
              if (name && file.name !== name) return false;
              if (mimeType && file.mimeType !== mimeType) return false;
              if (trashed !== null && file.trashed !== trashed) return false;
              if (propertyKey && file.properties?.[propertyKey] !== propertyValue) return false;
              return true;
            })
            .sort((left, right) => left.id.localeCompare(right.id));
          const requestedPageSize = Number(
            url.searchParams.get('pageSize') ?? originalDrive.pageSize
          );
          const pageSize = Math.min(requestedPageSize, originalDrive.pageSize);
          const pageToken = url.searchParams.get('pageToken');
          const offset =
            pageToken === null ? 0 : Number(/^drive-files:(\d+)$/.exec(pageToken)?.[1]);
          if (
            !Number.isSafeInteger(requestedPageSize) ||
            requestedPageSize < 1 ||
            !Number.isSafeInteger(offset)
          ) {
            googleError(response, 400, 'invalid Drive files pagination');
            return;
          }
          const files = matches.slice(offset, offset + pageSize).map(publicDriveFile);
          const nextOffset = offset + files.length;
          json(response, 200, {
            files,
            ...(nextOffset < matches.length ? { nextPageToken: `drive-files:${nextOffset}` } : {}),
          });
          return;
        }

        if (method === 'POST' && url.pathname === '/drive/v3/files') {
          const bodyBytes = await readBytes(request);
          const body = JSON.parse(bodyBytes.toString('utf8')) as Record<string, unknown>;
          recordRequest(request, method, url, {
            metadata: clone(body),
            bodySha256: hash('sha256', bodyBytes),
          });
          if (url.searchParams.get('supportsAllDrives') !== 'true') {
            googleError(response, 400, 'create folder requires supportsAllDrives=true');
            return;
          }
          if (sendConfiguredError(method, url.pathname, response)) return;
          const parents = body.parents;
          if (
            body.mimeType !== FOLDER_MIME_TYPE ||
            typeof body.name !== 'string' ||
            !Array.isArray(parents) ||
            parents.length !== 1 ||
            typeof parents[0] !== 'string'
          ) {
            googleError(response, 400, 'invalid Drive folder metadata');
            return;
          }
          const parent = driveFiles.get(parents[0] === 'root' ? 'my-drive-root' : parents[0]);
          if (!parent || !parent.capabilities.canAddChildren) {
            googleError(response, 403, 'Drive parent cannot add children');
            return;
          }
          const id = `generated-${++generatedId}`;
          const file: FakeDriveFile = {
            id,
            name: body.name,
            mimeType: FOLDER_MIME_TYPE,
            parents: [parent.id],
            driveId: parent.driveId,
            ownedByMe: parent.driveId === null,
            properties: { ...((body.properties as Record<string, string>) ?? {}) },
            capabilities: {
              canListChildren: true,
              canAddChildren: true,
              canEdit: true,
              canDownload: false,
            },
            trashed: false,
            version: 1,
            etag: `"${id}-v1"`,
            bytes: Buffer.alloc(0),
          };
          driveFiles.set(id, file);
          writeDriveFile(response, file);
          return;
        }

        const exactFileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
        if (exactFileMatch && method === 'GET') {
          recordRequest(request, method, url);
          const fileId = decodeURIComponent(exactFileMatch[1]!);
          if (sendConfiguredError(method, url.pathname, response)) return;
          const file = requireDriveFile(
            fileId,
            url.searchParams.get('supportsAllDrives') === 'true',
            response,
            true
          );
          if (!file) return;
          if (url.searchParams.get('alt') === 'media') {
            if (!file.capabilities.canDownload) {
              googleError(response, 403, 'Drive file cannot be downloaded');
              return;
            }
            response.writeHead(200, {
              'Content-Type': file.mimeType,
              'Content-Length': file.bytes.length,
              ETag: file.etag,
            });
            response.end(file.bytes);
          } else {
            writeDriveFile(response, file);
          }
          return;
        }

        const exactV2FileMatch = /^\/drive\/v2\/files\/([^/]+)$/.exec(url.pathname);
        if (exactV2FileMatch && method === 'GET') {
          recordRequest(request, method, url);
          const fileId = decodeURIComponent(exactV2FileMatch[1]!);
          if (sendConfiguredError(method, url.pathname, response)) return;
          const file = requireDriveFile(
            fileId,
            url.searchParams.get('supportsAllDrives') === 'true',
            response,
            true
          );
          if (!file) return;
          if (url.searchParams.get('fields') !== 'etag') {
            googleError(response, 400, 'Drive v2 ETag lookup requires fields=etag');
            return;
          }
          json(response, 200, { etag: file.etag });
          return;
        }

        if (exactFileMatch && method === 'PATCH') {
          const bodyBytes = await readBytes(request);
          const body = JSON.parse(bodyBytes.toString('utf8')) as Record<string, unknown>;
          recordRequest(request, method, url, {
            metadata: clone(body),
            bodySha256: hash('sha256', bodyBytes),
          });
          const fileId = decodeURIComponent(exactFileMatch[1]!);
          const file = requireDriveFile(
            fileId,
            url.searchParams.get('supportsAllDrives') === 'true',
            response
          );
          if (!file) return;
          if (!file.capabilities.canEdit) {
            googleError(response, 403, 'Drive file cannot be edited');
            return;
          }
          if (request.headers['if-match'] !== file.etag) {
            const logged = requestLog.at(-1);
            if (logged?.method === method && logged.path === url.pathname) {
              logged.responseStatus = 412;
            }
            googleError(response, 412, 'Drive ETag conflict');
            return;
          }
          if (sendConfiguredError(method, url.pathname, response)) return;
          if (typeof body.name === 'string') file.name = body.name;
          if (
            typeof body.properties === 'object' &&
            body.properties !== null &&
            !Array.isArray(body.properties)
          ) {
            file.properties = {
              ...(file.properties ?? {}),
              ...(body.properties as Record<string, string>),
            };
          }
          const addParent = url.searchParams.get('addParents');
          const removeParent = url.searchParams.get('removeParents');
          if (addParent) file.parents = [...new Set([...file.parents, addParent])];
          if (removeParent) file.parents = file.parents.filter((parent) => parent !== removeParent);
          nextDriveVersion(file);
          writeDriveFile(response, file);
          return;
        }

        if (exactV2FileMatch && method === 'PATCH') {
          const bodyBytes = await readBytes(request);
          const body = JSON.parse(bodyBytes.toString('utf8')) as Record<string, unknown>;
          recordRequest(request, method, url, {
            metadata: clone(body),
            bodySha256: hash('sha256', bodyBytes),
          });
          const fileId = decodeURIComponent(exactV2FileMatch[1]!);
          const file = requireDriveFile(
            fileId,
            url.searchParams.get('supportsAllDrives') === 'true',
            response
          );
          if (!file) return;
          if (!file.capabilities.canEdit) {
            googleError(response, 403, 'Drive file cannot be edited');
            return;
          }
          if (request.headers['if-match'] !== file.etag) {
            const logged = requestLog.at(-1);
            if (logged?.method === method && logged.path === url.pathname) {
              logged.responseStatus = 412;
            }
            googleError(response, 412, 'Drive ETag conflict');
            return;
          }
          if (sendConfiguredError(method, url.pathname, response)) return;
          if (typeof body.title === 'string') file.name = body.title;
          const properties = parseV2Properties(body.properties);
          if (properties) file.properties = { ...(file.properties ?? {}), ...properties };
          const addParent = url.searchParams.get('addParents');
          const removeParent = url.searchParams.get('removeParents');
          if (addParent) file.parents = [...new Set([...file.parents, addParent])];
          if (removeParent) file.parents = file.parents.filter((parent) => parent !== removeParent);
          nextDriveVersion(file);
          json(response, 200, { etag: file.etag });
          return;
        }

        const v2TrashMatch = /^\/drive\/v2\/files\/([^/]+)\/trash$/.exec(url.pathname);
        if (v2TrashMatch && method === 'POST') {
          recordRequest(request, method, url);
          const fileId = decodeURIComponent(v2TrashMatch[1]!);
          const file = requireDriveFile(
            fileId,
            url.searchParams.get('supportsAllDrives') === 'true',
            response
          );
          if (!file) return;
          if (!file.capabilities.canEdit) {
            googleError(response, 403, 'Drive file cannot be edited');
            return;
          }
          if (request.headers['if-match'] !== file.etag) {
            const logged = requestLog.at(-1);
            if (logged?.method === method && logged.path === url.pathname) {
              logged.responseStatus = 412;
            }
            googleError(response, 412, 'Drive ETag conflict');
            return;
          }
          if (sendConfiguredError(method, url.pathname, response)) return;
          file.trashed = true;
          nextDriveVersion(file);
          json(response, 200, { etag: file.etag });
          return;
        }

        const uploadMatch = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
        if (uploadMatch && (method === 'POST' || method === 'PATCH')) {
          const bodyBytes = await readBytes(request, MAX_PDF_OR_GMAIL_BODY_BYTES);
          const parsed = parseMultipart(
            typeof request.headers['content-type'] === 'string'
              ? request.headers['content-type']
              : undefined,
            bodyBytes
          );
          const isPdfUpload = parsed.metadata.mimeType === 'application/pdf';
          if (!isPdfUpload && bodyBytes.length > MAX_BODY_BYTES) {
            googleError(response, 413, 'non-PDF multipart body exceeds fake service limit');
            return;
          }
          recordRequest(request, method, url, {
            metadata: clone(parsed.metadata),
            bodySha256: hash('sha256', parsed.bytes),
          });
          if (
            url.searchParams.get('uploadType') !== 'multipart' ||
            url.searchParams.get('supportsAllDrives') !== 'true'
          ) {
            googleError(response, 400, 'invalid Drive multipart flags');
            return;
          }
          if (interruptNextUpload && isPdfUpload) {
            interruptNextUpload = false;
            request.socket.destroy();
            return;
          }
          if (sendConfiguredError(method, url.pathname, response)) return;
          if (method === 'POST') {
            const metadata = parsed.metadata;
            if (
              typeof metadata.id !== 'string' ||
              typeof metadata.name !== 'string' ||
              typeof metadata.mimeType !== 'string' ||
              !Array.isArray(metadata.parents) ||
              metadata.parents.length !== 1 ||
              typeof metadata.parents[0] !== 'string' ||
              driveFiles.has(metadata.id)
            ) {
              googleError(response, 400, 'invalid Drive create multipart metadata');
              return;
            }
            const parent = driveFiles.get(
              metadata.parents[0] === 'root' ? 'my-drive-root' : metadata.parents[0]
            );
            if (!parent) {
              googleError(response, 404, 'Drive parent not found');
              return;
            }
            if (!parent.capabilities.canAddChildren) {
              googleError(response, 403, 'Drive parent cannot add children');
              return;
            }
            const file: FakeDriveFile = {
              id: metadata.id,
              name: metadata.name,
              mimeType: metadata.mimeType,
              parents: [parent.id],
              driveId: parent.driveId,
              ownedByMe: parent.driveId === null,
              properties: { ...((metadata.properties as Record<string, string>) ?? {}) },
              capabilities: {
                canListChildren: false,
                canAddChildren: false,
                canEdit: true,
                canDownload: true,
              },
              trashed: false,
              version: 1,
              etag: `"${metadata.id}-v1"`,
              bytes: parsed.bytes,
            };
            driveFiles.set(file.id, file);
            writeDriveFile(response, file);
            return;
          }
          const fileId = decodeURIComponent(uploadMatch[1]!);
          const file = requireDriveFile(fileId, true, response);
          if (!file) return;
          if (mutateBeforeUploadPatch?.fileId === fileId) {
            const external = mutateBeforeUploadPatch;
            mutateBeforeUploadPatch = null;
            file.properties = { ...(file.properties ?? {}), ...external.properties };
            if (external.bytes !== null) file.bytes = external.bytes;
            nextDriveVersion(file);
          }
          if (!file.capabilities.canEdit) {
            googleError(response, 403, 'Drive file cannot be edited');
            return;
          }
          if (request.headers['if-match'] !== file.etag) {
            const logged = requestLog.at(-1);
            if (logged?.method === method && logged.path === url.pathname) {
              logged.responseStatus = 412;
            }
            googleError(response, 412, 'Drive ETag conflict');
            return;
          }
          if (typeof parsed.metadata.name === 'string') file.name = parsed.metadata.name;
          if (typeof parsed.metadata.mimeType === 'string')
            file.mimeType = parsed.metadata.mimeType;
          if (
            typeof parsed.metadata.properties === 'object' &&
            parsed.metadata.properties !== null &&
            !Array.isArray(parsed.metadata.properties)
          ) {
            file.properties = {
              ...(file.properties ?? {}),
              ...(parsed.metadata.properties as Record<string, string>),
            };
          }
          file.bytes = parsed.bytes;
          nextDriveVersion(file);
          writeDriveFile(response, file);
          return;
        }

        const v2UploadMatch = /^\/upload\/drive\/v2\/files\/([^/]+)$/.exec(url.pathname);
        if (v2UploadMatch && method === 'PUT') {
          const bodyBytes = await readBytes(request, MAX_PDF_OR_GMAIL_BODY_BYTES);
          const parsed = parseMultipart(
            typeof request.headers['content-type'] === 'string'
              ? request.headers['content-type']
              : undefined,
            bodyBytes
          );
          const isPdfUpload = parsed.metadata.mimeType === 'application/pdf';
          if (!isPdfUpload && bodyBytes.length > MAX_BODY_BYTES) {
            googleError(response, 413, 'non-PDF multipart body exceeds fake service limit');
            return;
          }
          recordRequest(request, method, url, {
            metadata: clone(parsed.metadata),
            bodySha256: hash('sha256', parsed.bytes),
          });
          if (
            url.searchParams.get('uploadType') !== 'multipart' ||
            url.searchParams.get('supportsAllDrives') !== 'true' ||
            url.searchParams.get('fields') !== 'etag'
          ) {
            googleError(response, 400, 'invalid Drive v2 multipart flags');
            return;
          }
          const fileId = decodeURIComponent(v2UploadMatch[1]!);
          const file = requireDriveFile(fileId, true, response);
          if (!file) return;
          if (mutateBeforeUploadPatch?.fileId === fileId) {
            const external = mutateBeforeUploadPatch;
            mutateBeforeUploadPatch = null;
            file.properties = { ...(file.properties ?? {}), ...external.properties };
            if (external.bytes !== null) file.bytes = external.bytes;
            nextDriveVersion(file);
          }
          if (!file.capabilities.canEdit) {
            googleError(response, 403, 'Drive file cannot be edited');
            return;
          }
          if (request.headers['if-match'] !== file.etag) {
            const logged = requestLog.at(-1);
            if (logged?.method === method && logged.path === url.pathname) {
              logged.responseStatus = 412;
            }
            googleError(response, 412, 'Drive ETag conflict');
            return;
          }
          if (sendConfiguredError(method, url.pathname, response)) return;
          if (typeof parsed.metadata.title === 'string') file.name = parsed.metadata.title;
          if (typeof parsed.metadata.mimeType === 'string') {
            file.mimeType = parsed.metadata.mimeType;
          }
          const properties = parseV2Properties(parsed.metadata.properties);
          if (properties) file.properties = { ...(file.properties ?? {}), ...properties };
          const addParent = url.searchParams.get('addParents');
          const removeParent = url.searchParams.get('removeParents');
          if (addParent) file.parents = [...new Set([...file.parents, addParent])];
          if (removeParent) file.parents = file.parents.filter((parent) => parent !== removeParent);
          file.bytes = parsed.bytes;
          nextDriveVersion(file);
          json(response, 200, { etag: file.etag });
          return;
        }

        if (method === 'POST' && url.pathname === '/gmail/v1/users/me/drafts') {
          const bodyBytes = await readBytes(request, MAX_PDF_OR_GMAIL_BODY_BYTES);
          const body = JSON.parse(bodyBytes.toString('utf8')) as {
            message?: { raw?: unknown };
          };
          recordRequest(request, method, url, { bodySha256: hash('sha256', bodyBytes) });
          if (sendConfiguredError(method, url.pathname, response)) return;
          const raw = body.message?.raw;
          if (typeof raw !== 'string' || raw.length === 0) {
            googleError(response, 400, 'Gmail draft raw message is required');
            return;
          }
          const draft: CapturedGmailDraft = {
            id: `draft-${capturedDrafts.length + 1}`,
            raw,
            rawSha256: hash('sha256', raw),
            attachmentSha256: extractAttachmentSha256(raw),
          };
          capturedDrafts.push(draft);
          json(response, 200, { id: draft.id, message: { id: `message-${draft.id}` } });
          return;
        }

        recordRequest(request, method, url);
        googleError(response, 404, 'unexpected fake Google Drive or Gmail endpoint');
        return;
      }

      const body = method === 'PATCH' ? await readJson(request) : undefined;
      const logged: FakeGoogleRequest = {
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        ...(request.headers['if-match'] ? { ifMatch: String(request.headers['if-match']) } : {}),
        ...(body === undefined ? {} : { body }),
      };
      requestLog.push({
        ...logged,
        authPresent: request.headers.authorization?.startsWith('Bearer ') === true,
      });

      if (!hasValidAuthorization(request)) {
        googleError(response, 401, 'invalid test authorization');
        return;
      }

      if (method === 'GET' && url.pathname === '/calendar/v3/users/me/calendarList') {
        const queryKeys = [...url.searchParams.keys()];
        if (
          new Set(queryKeys).size !== queryKeys.length ||
          queryKeys.some((key) => key !== 'pageToken')
        ) {
          googleError(response, 400, 'unexpected CalendarList query');
          return;
        }
        const pageToken = url.searchParams.get('pageToken');
        const cursor = pageToken === null ? null : pageCursor(pageToken, 'calendars');
        if (pageToken !== null && (!cursor || cursor.kind !== 'calendars')) {
          googleError(response, 400, 'invalid CalendarList page token');
          return;
        }
        const snapshot =
          cursor?.kind === 'calendars' ? cursor.snapshot : clone(fixture.calendarList);
        const start = cursor?.kind === 'calendars' ? cursor.offset : 0;
        if (start >= snapshot.length) {
          googleError(response, 400, 'invalid CalendarList page token');
          return;
        }
        if (sendConfiguredError(method, url.pathname, response)) return;
        if (pageToken !== null) pageCursors.delete(pageToken);
        const items = snapshot.slice(start, start + fixture.calendarPageSize);
        const nextStart = start + fixture.calendarPageSize;
        json(response, 200, {
          items,
          ...(nextStart < snapshot.length
            ? {
                nextPageToken: issuePageToken({
                  kind: 'calendars',
                  offset: nextStart,
                  snapshot,
                }),
              }
            : {}),
        });
        return;
      }

      const match = url.pathname.match(
        /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/
      );
      if (!match) {
        googleError(response, 404, 'unexpected Google Calendar endpoint');
        return;
      }
      const calendarId = decodeURIComponent(match[1]!);
      const eventId = match[2] ? decodeURIComponent(match[2]) : null;
      if (calendarId !== 'teaching@example.test') {
        googleError(response, 404, 'calendar not found');
        return;
      }

      if (method === 'GET' && eventId !== null) {
        if (url.search) {
          googleError(response, 400, 'event GET accepts no query');
          return;
        }
        const event = events.get(eventId);
        if (!event) {
          googleError(response, 404, 'event not found');
          return;
        }
        if (sendConfiguredError(method, url.pathname, response)) return;
        json(response, 200, publicEvent(event));
        return;
      }

      if (method === 'PATCH' && eventId !== null) {
        if (url.search || !exactPatch(body)) {
          googleError(response, 400, 'PATCH must contain exactly summary or description');
          return;
        }
        const event = events.get(eventId);
        if (!event) {
          googleError(response, 404, 'event not found');
          return;
        }
        if (request.headers['if-match'] !== event.etag) {
          googleError(response, 412, 'etag conflict');
          return;
        }
        if (sendConfiguredError(method, url.pathname, response)) return;
        const [field, value] = Object.entries(body)[0]! as ['summary' | 'description', string];
        event[field] = value;
        event.etag = nextEtag(event.id);
        const changed: FakeEvent[] = [];
        if (event.e2eMaster) {
          for (const instance of events.values()) {
            if (
              instance.recurringEventId === event.id &&
              !instance.e2eExceptions?.includes(field)
            ) {
              instance[field] = value;
              instance.etag = nextEtag(instance.id);
              changed.push(instance);
            }
          }
        } else {
          event.e2eExceptions = [...new Set([...(event.e2eExceptions ?? []), field])];
          changed.push(event);
        }
        recordChanges(changed);
        json(response, 200, publicEvent(event));
        return;
      }

      if (method === 'GET' && eventId === null) {
        const allowed = new Set(['singleEvents', 'maxResults', 'syncToken', 'pageToken']);
        const queryKeys = [...url.searchParams.keys()];
        if (
          new Set(queryKeys).size !== queryKeys.length ||
          queryKeys.some((key) => !allowed.has(key)) ||
          url.searchParams.get('singleEvents') !== 'true' ||
          url.searchParams.get('maxResults') !== '250'
        ) {
          googleError(response, 400, 'unexpected expanded-events query');
          return;
        }
        const requestedSyncToken = url.searchParams.get('syncToken');
        const pageToken = url.searchParams.get('pageToken');
        let cursor: EventPageCursor;
        if (pageToken !== null) {
          const stored = pageCursor(pageToken, 'events');
          if (
            !stored ||
            stored.kind !== 'events' ||
            stored.calendarId !== calendarId ||
            stored.singleEvents !== url.searchParams.get('singleEvents') ||
            stored.maxResults !== url.searchParams.get('maxResults') ||
            stored.syncToken !== requestedSyncToken
          ) {
            googleError(response, 400, 'event page token does not match its originating query');
            return;
          }
          cursor = stored;
        } else {
          const snapshotRevision = revision;
          let selected: FakeEvent[];
          if (requestedSyncToken === null) {
            selected = [...events.values()].filter(
              (event) => !event.e2eMaster && event.status !== 'cancelled'
            );
          } else {
            const tokenMatch = requestedSyncToken.match(/^sync-(\d+)$/);
            const tokenRevision = tokenMatch ? Number(tokenMatch[1]) : Number.NaN;
            if (
              !Number.isSafeInteger(tokenRevision) ||
              tokenRevision < 0 ||
              tokenRevision > snapshotRevision
            ) {
              googleError(response, 410, 'sync token expired');
              return;
            }
            const latest = new Map<string, FakeEvent>();
            for (const [changedAt, changedEvents] of changes) {
              if (changedAt <= tokenRevision || changedAt > snapshotRevision) continue;
              for (const changed of changedEvents) latest.set(changed.id, clone(changed));
            }
            selected = [...latest.values()];
          }
          cursor = {
            kind: 'events',
            calendarId,
            mode: requestedSyncToken === null ? 'full' : 'incremental',
            syncToken: requestedSyncToken,
            singleEvents: 'true',
            maxResults: '250',
            revision: snapshotRevision,
            offset: 0,
            snapshot: clone(selected),
          };
        }
        const { snapshot: selected, offset: start } = cursor;
        if (start > 0 && start >= selected.length) {
          googleError(response, 400, 'invalid event page token');
          return;
        }
        if (sendConfiguredError(method, url.pathname, response)) return;
        if (pageToken !== null) pageCursors.delete(pageToken);
        const items = selected.slice(start, start + fixture.pageSize).map(publicEvent);
        const nextStart = start + fixture.pageSize;
        json(response, 200, {
          items,
          ...(nextStart < selected.length
            ? { nextPageToken: issuePageToken({ ...cursor, offset: nextStart }) }
            : { nextSyncToken: `sync-${cursor.revision}` }),
        });
        return;
      }

      googleError(response, 404, 'unexpected method or endpoint');
    } catch (error) {
      googleError(response, 400, error instanceof Error ? error.message : 'invalid request');
    }
  });

  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake server did not bind TCP');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl: `${origin}/calendar/v3`,
    calendarBaseUrl: `${origin}/calendar/v3`,
    driveApiBaseUrl: `${origin}/drive/v3`,
    driveUploadBaseUrl: `${origin}/upload/drive/v3`,
    gmailApiBaseUrl: `${origin}/gmail/v1`,
    controlUrl: `${origin}/__e2e__`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out closing fake Google server')),
          5_000
        );
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections?.();
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

async function requestJson(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

const DESKTOP_TOKEN = 'e2e-desktop-token';
const ANDROID_TOKEN = 'e2e-android-token';
const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

function multipartBody(
  metadata: Record<string, unknown>,
  bytes: Uint8Array
): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = 'lotus-e2e-boundary';
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([prefix, bytes, suffix]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

async function multipartRequest(
  url: string,
  options: {
    method?: 'POST' | 'PATCH' | 'PUT';
    token: string;
    metadata: Record<string, unknown>;
    bytes: Uint8Array;
    ifMatch?: string;
  }
): Promise<Response> {
  const multipart = multipartBody(options.metadata, options.bytes);
  return fetch(url, {
    method: options.method ?? 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': multipart.contentType,
      ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
    },
    body: multipart.body,
  });
}

function managedPdfMetadata(): Record<string, unknown> {
  return {
    id: 'pdf-1',
    name: 'Test-Studio-2026-08-001.pdf',
    mimeType: 'application/pdf',
    parents: ['final-my-drive'],
    properties: {
      lotusSchema: '1',
      lotusCalendarHash: 'c'.repeat(64),
      lotusStudioSlug: 'test-studio',
      lotusMonth: '2026-08',
      lotusInvoiceNumber: '1/2026',
      lotusSourceSha256: 'd'.repeat(64),
      lotusPdfSha256: createHash('sha256').update(PDF_BYTES).digest('hex'),
      lotusOperationId: 'operation-1',
    },
  };
}

function managedPdfV2Metadata(
  properties = managedPdfMetadata().properties as Record<string, string>
): Record<string, unknown> {
  return {
    title: managedPdfMetadata().name,
    mimeType: 'application/pdf',
    properties: Object.entries(properties).map(([key, value]) => ({
      key,
      value,
      visibility: 'PUBLIC',
    })),
  };
}

async function runDriveAndGmailContractTests(server: FakeGoogleCalendar): Promise<void> {
  assert.match(server.calendarBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/calendar\/v3$/);
  assert.match(server.driveApiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/drive\/v3$/);
  assert.match(server.driveUploadBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/upload\/drive\/v3$/);
  assert.match(server.gmailApiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/gmail\/v1$/);

  const auth = { Authorization: `Bearer ${DESKTOP_TOKEN}` };
  const driveV2ApiBaseUrl = server.driveApiBaseUrl.replace(/\/v3$/, '/v2');
  const driveV2UploadBaseUrl = server.driveUploadBaseUrl.replace(/\/v3$/, '/v2');
  const invalidToken = await fetch(`${server.driveApiBaseUrl}/drives?pageSize=1`, {
    headers: { Authorization: 'Bearer not-a-fake-account-token' },
  });
  assert.equal(invalidToken.status, 401, 'invalid bearer values must be rejected directly');
  const firstDrives = await fetch(`${server.driveApiBaseUrl}/drives?pageSize=1`, { headers: auth });
  assert.equal(firstDrives.status, 200);
  const firstDrivesBody = (await firstDrives.json()) as {
    drives: Array<{ id: string; name: string }>;
    nextPageToken?: string;
  };
  assert.deepEqual(firstDrivesBody.drives, [{ id: 'shared-drive-1', name: 'Teaching Shared' }]);
  assert.equal(typeof firstDrivesBody.nextPageToken, 'string');
  const secondDrives = await fetch(
    `${server.driveApiBaseUrl}/drives?pageSize=1&pageToken=${encodeURIComponent(firstDrivesBody.nextPageToken!)}`,
    { headers: auth }
  );
  assert.equal(secondDrives.status, 200);
  assert.deepEqual((await secondDrives.json()) as object, {
    drives: [{ id: 'shared-drive-2', name: 'Archive Shared' }],
  });

  const configQuery = encodeURIComponent(
    "name = 'lotus-invoices-config.yaml' and trashed = false and properties has { key='lotusConfigSchema' and value='1' }"
  );
  const configs = await fetch(
    `${server.driveApiBaseUrl}/files?q=${configQuery}&corpora=user&includeItemsFromAllDrives=true&supportsAllDrives=true&pageSize=1`,
    { headers: auth }
  );
  assert.equal(configs.status, 200);
  const configsBody = (await configs.json()) as {
    files: Array<Record<string, unknown>>;
    nextPageToken?: string;
  };
  assert.equal(configsBody.files.length, 1);
  assert.equal(configsBody.files[0]?.name, 'lotus-invoices-config.yaml');
  assert.equal(configsBody.files[0]?.mimeType, 'application/yaml');
  assert.equal(configsBody.files[0]?.ownedByMe, true);
  assert.equal(configsBody.files[0]?.driveId, null);
  assert.deepEqual(configsBody.files[0]?.properties, { lotusConfigSchema: '1' });
  assert.deepEqual(configsBody.files[0]?.capabilities, {
    canListChildren: false,
    canAddChildren: false,
    canEdit: true,
    canDownload: true,
  });

  const sharedFiles = await fetch(
    `${server.driveApiBaseUrl}/files?q=${encodeURIComponent("'shared-root-1' in parents and trashed = false")}&corpora=drive&driveId=shared-drive-1&includeItemsFromAllDrives=true&supportsAllDrives=true&pageSize=100`,
    { headers: auth }
  );
  assert.equal(sharedFiles.status, 200);
  const sharedFilesBody = (await sharedFiles.json()) as { files: Array<{ id: string }> };
  assert.deepEqual(
    sharedFilesBody.files.map(({ id }) => id),
    ['shared-final-1']
  );

  const missingSharedFlag = await fetch(
    `${server.driveApiBaseUrl}/files/shared-final-1?supportsAllDrives=false`,
    { headers: auth }
  );
  assert.equal(missingSharedFlag.status, 400);

  const generated = await fetch(`${server.driveApiBaseUrl}/files/generateIds?count=2&space=drive`, {
    headers: auth,
  });
  assert.equal(generated.status, 200);
  assert.deepEqual((await generated.json()) as object, { ids: ['generated-1', 'generated-2'] });

  const folder = await fetch(`${server.driveApiBaseUrl}/files?supportsAllDrives=true`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Created Root',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      properties: { purpose: 'invoice-root' },
    }),
  });
  assert.equal(folder.status, 200);
  const folderBody = (await folder.json()) as Record<string, unknown>;
  assert.equal(folderBody.id, 'generated-3');
  assert.deepEqual(folderBody.properties, { purpose: 'invoice-root' });

  const folderEtag = await fetch(
    `${driveV2ApiBaseUrl}/files/generated-3?supportsAllDrives=true&fields=etag`,
    { headers: auth }
  );
  assert.equal(folderEtag.status, 200);
  assert.deepEqual((await folderEtag.json()) as object, { etag: '"generated-3-v1"' });
  const patchedFolder = await fetch(
    `${driveV2ApiBaseUrl}/files/generated-3?supportsAllDrives=true&fields=etag`,
    {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json', 'If-Match': '"generated-3-v1"' },
      body: JSON.stringify({
        title: 'Renamed Root',
        properties: [{ key: 'client', value: 'desktop', visibility: 'PUBLIC' }],
      }),
    }
  );
  assert.equal(patchedFolder.status, 200);
  assert.deepEqual((await patchedFolder.json()) as object, { etag: '"generated-3-v2"' });
  const trashedFolder = await fetch(
    `${driveV2ApiBaseUrl}/files/generated-3/trash?supportsAllDrives=true&fields=etag`,
    { method: 'POST', headers: { ...auth, 'If-Match': '"generated-3-v2"' } }
  );
  assert.equal(trashedFolder.status, 200);
  assert.deepEqual((await trashedFolder.json()) as object, { etag: '"generated-3-v3"' });
  const refreshedTrashedFolder = await fetch(
    `${server.driveApiBaseUrl}/files/generated-3?supportsAllDrives=true`,
    { headers: auth }
  );
  assert.equal(refreshedTrashedFolder.status, 200);
  assert.equal(((await refreshedTrashedFolder.json()) as { trashed: boolean }).trashed, true);
  const refreshedTrashedFolderEtag = await fetch(
    `${driveV2ApiBaseUrl}/files/generated-3?supportsAllDrives=true&fields=etag`,
    { headers: auth }
  );
  assert.equal(refreshedTrashedFolderEtag.status, 200);
  assert.deepEqual((await refreshedTrashedFolderEtag.json()) as object, {
    etag: '"generated-3-v3"',
  });

  const created = await multipartRequest(
    `${server.driveUploadBaseUrl}/files?uploadType=multipart&supportsAllDrives=true`,
    { token: DESKTOP_TOKEN, metadata: managedPdfMetadata(), bytes: PDF_BYTES }
  );
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('etag'), '"pdf-1-v1"');
  const createdBody = (await created.json()) as Record<string, unknown>;
  assert.equal(createdBody.version, '1');
  assert.equal(createdBody.size, String(PDF_BYTES.byteLength));
  assert.equal(createdBody.sha256Checksum, createHash('sha256').update(PDF_BYTES).digest('hex'));
  assert.deepEqual(createdBody.properties, {
    lotusSchema: '1',
    lotusCalendarHash: 'c'.repeat(64),
    lotusStudioSlug: 'test-studio',
    lotusMonth: '2026-08',
    lotusInvoiceNumber: '1/2026',
    lotusSourceSha256: 'd'.repeat(64),
    lotusPdfSha256: createHash('sha256').update(PDF_BYTES).digest('hex'),
    lotusOperationId: 'operation-1',
  });

  const androidVisible = await fetch(
    `${server.driveApiBaseUrl}/files/pdf-1?supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${ANDROID_TOKEN}` } }
  );
  assert.equal(androidVisible.status, 200);
  assert.deepEqual(((await androidVisible.json()) as Record<string, unknown>).properties, {
    ...(managedPdfMetadata().properties as Record<string, string>),
  });

  const download = await fetch(
    `${server.driveApiBaseUrl}/files/pdf-1?alt=media&supportsAllDrives=true`,
    { headers: auth }
  );
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), PDF_BYTES);

  const externalBytes = Uint8Array.from([...PDF_BYTES, 0x41]);
  const armExternalMutation = await fetch(`${server.controlUrl}/mutate-before-upload-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileId: 'pdf-1',
      patch: {
        properties: { externallyTouched: 'android' },
        bytesBase64: Buffer.from(externalBytes).toString('base64'),
      },
    }),
  });
  assert.equal(armExternalMutation.status, 204);
  const conflict = await multipartRequest(
    `${driveV2UploadBaseUrl}/files/pdf-1?uploadType=multipart&supportsAllDrives=true&fields=etag`,
    {
      method: 'PUT',
      token: DESKTOP_TOKEN,
      metadata: managedPdfV2Metadata(),
      bytes: PDF_BYTES,
      ifMatch: '"pdf-1-v1"',
    }
  );
  assert.equal(conflict.status, 412);
  const afterConflict = await fetch(
    `${server.driveApiBaseUrl}/files/pdf-1?supportsAllDrives=true`,
    {
      headers: auth,
    }
  );
  assert.equal(afterConflict.status, 200);
  const afterConflictBody = (await afterConflict.json()) as Record<string, any>;
  assert.equal(afterConflictBody.etag, undefined);
  assert.equal(afterConflictBody.version, '2');
  assert.equal(
    afterConflictBody.sha256Checksum,
    createHash('sha256').update(externalBytes).digest('hex')
  );
  assert.equal(afterConflictBody.properties.externallyTouched, 'android');
  const externalDownload = await fetch(
    `${server.driveApiBaseUrl}/files/pdf-1?alt=media&supportsAllDrives=true`,
    { headers: auth }
  );
  assert.deepEqual(new Uint8Array(await externalDownload.arrayBuffer()), externalBytes);
  const conflictLog = (await (
    await fetch(`${server.controlUrl}/requests`)
  ).json()) as FakeGoogleRequest[];
  const conflictingPatch = conflictLog.findLast(
    (entry) => entry.method === 'PUT' && entry.path === '/upload/drive/v2/files/pdf-1'
  );
  assert.equal(conflictingPatch?.ifMatch, '"pdf-1-v1"');
  assert.equal(conflictingPatch?.responseStatus, 412);

  const updatedBytes = Uint8Array.from([...PDF_BYTES, 0x25]);
  const updated = await multipartRequest(
    `${driveV2UploadBaseUrl}/files/pdf-1?uploadType=multipart&supportsAllDrives=true&fields=etag`,
    {
      method: 'PUT',
      token: ANDROID_TOKEN,
      metadata: managedPdfV2Metadata({ externallyTouched: 'android' }),
      bytes: updatedBytes,
      ifMatch: '"pdf-1-v2"',
    }
  );
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()) as object, { etag: '"pdf-1-v3"' });

  const oversizedMetadataPatch = await fetch(
    `${server.driveApiBaseUrl}/files/pdf-1?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json', 'If-Match': '"pdf-1-v3"' },
      body: JSON.stringify({ properties: { tooLarge: 'x'.repeat(MAX_BODY_BYTES) } }),
    }
  );
  assert.equal(oversizedMetadataPatch.status, 400);
  const largePdf = Buffer.alloc(MAX_BODY_BYTES + 1, 0x50);
  const allowedLargePdf = await multipartRequest(
    `${server.driveUploadBaseUrl}/files?uploadType=multipart&supportsAllDrives=true`,
    {
      token: DESKTOP_TOKEN,
      metadata: { ...managedPdfMetadata(), id: 'large-pdf' },
      bytes: largePdf,
    }
  );
  assert.equal(allowedLargePdf.status, 200);
  const rejectedLargeJson = await multipartRequest(
    `${server.driveUploadBaseUrl}/files?uploadType=multipart&supportsAllDrives=true`,
    {
      token: DESKTOP_TOKEN,
      metadata: {
        id: 'large-json',
        name: 'large.json',
        mimeType: 'application/json',
        parents: ['final-my-drive'],
      },
      bytes: largePdf,
    }
  );
  assert.equal(rejectedLargeJson.status, 413);

  for (const status of [401, 403, 404, 429, 503]) {
    const configured = await fetch(`${server.controlUrl}/next-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        path: '/drive/v3/files/pdf-1',
        status,
        body: { error: { code: status, message: `controlled-${status}` } },
      }),
    });
    assert.equal(configured.status, 204);
    const failure = await fetch(`${server.driveApiBaseUrl}/files/pdf-1?supportsAllDrives=true`, {
      headers: auth,
    });
    assert.equal(failure.status, status);
  }

  const armInterrupt = await fetch(`${server.controlUrl}/interrupt-next-upload`, {
    method: 'POST',
  });
  assert.equal(armInterrupt.status, 204);
  const controlBeforeInterruptedPdf = await multipartRequest(
    `${server.driveUploadBaseUrl}/files?uploadType=multipart&supportsAllDrives=true`,
    {
      token: DESKTOP_TOKEN,
      metadata: {
        id: 'control-before-interrupt',
        name: '.lotus-control.json',
        mimeType: 'application/json',
        parents: ['final-my-drive'],
        properties: {},
      },
      bytes: Buffer.from('{}'),
    }
  );
  assert.equal(controlBeforeInterruptedPdf.status, 200);
  await assert.rejects(
    multipartRequest(
      `${server.driveUploadBaseUrl}/files?uploadType=multipart&supportsAllDrives=true`,
      {
        token: DESKTOP_TOKEN,
        metadata: { ...managedPdfMetadata(), id: 'interrupted-pdf' },
        bytes: PDF_BYTES,
      }
    )
  );

  const raw = Buffer.from(
    `To: invoices@example.test\r\nSubject: Invoice\r\n\r\n${Buffer.from(updatedBytes).toString('base64')}`
  ).toString('base64url');
  const gmail = await fetch(`${server.gmailApiBaseUrl}/users/me/drafts`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
  });
  assert.equal(gmail.status, 200);
  const gmailBody = (await gmail.json()) as { id: string };
  assert.equal(gmailBody.id, 'draft-1');
  const largeGmail = await fetch(`${server.gmailApiBaseUrl}/users/me/drafts`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { raw: Buffer.alloc(MAX_BODY_BYTES + 1, 0x41).toString('base64url') },
    }),
  });
  assert.equal(largeGmail.status, 200, 'Gmail alone may exceed the normal 64 KiB ceiling');

  const state = await fetch(`${server.controlUrl}/state`);
  assert.equal(state.status, 200);
  const captured = (await state.json()) as {
    drafts: Array<{ raw: string; rawSha256: string }>;
    files: Array<{ id: string }>;
  };
  assert.equal(captured.drafts[0]?.raw, raw);
  assert.equal(captured.drafts[0]?.rawSha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(
    captured.files.some(({ id }) => id === 'interrupted-pdf'),
    false
  );

  const log = (await (await fetch(`${server.controlUrl}/requests`)).json()) as Array<
    Record<string, unknown>
  >;
  assert.equal(
    log.some((entry) => JSON.stringify(entry).includes(DESKTOP_TOKEN)),
    false
  );
  assert.equal(
    log.some((entry) => JSON.stringify(entry).includes(ANDROID_TOKEN)),
    false
  );
  assert.equal(
    log.some((entry) => 'authorization' in entry),
    false
  );
  assert.equal(
    log.some((entry) => 'bytes' in entry || 'raw' in entry),
    false
  );
  assert.equal(
    log.some((entry) => entry.authPresent === true && typeof entry.bodySha256 === 'string'),
    true
  );
}

async function runContractTests(): Promise<void> {
  const run = createIsolatedE2eRun();
  assert.equal(run.dataDir.startsWith(`${run.root}/`), true);
  const removedRoot = run.root;
  removeIsolatedE2eRun(run);
  assert.equal(await Bun.file(removedRoot).exists(), false);

  const capability = JSON.parse(
    await readFile(
      join(import.meta.dir, '..', '..', 'src-tauri', 'capabilities', 'default.json'),
      'utf8'
    )
  ) as { permissions: Array<string | { identifier: string; allow: Array<{ path: string }> }> };
  const fsScope = capability.permissions.find(
    (permission): permission is { identifier: string; allow: Array<{ path: string }> } =>
      typeof permission === 'object' && permission.identifier === 'fs:scope'
  );
  assert.deepEqual(
    fsScope?.allow.map(({ path }) => path),
    ['$HOME/**', '/tmp/**', '$TEMP/**'],
    'production FS scope must retain HOME, literal /tmp, and the platform temp directory'
  );

  const fixture = join(import.meta.dir, '..', 'fixtures', 'e2e-google-calendar.json');
  const server = await startFakeGoogleCalendar(fixture);
  try {
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/calendar\/v3$/);
    await runDriveAndGmailContractTests(server);

    const firstCalendars = await requestJson(`${server.baseUrl}/users/me/calendarList`, {
      headers: { Authorization: 'Bearer e2e-access-token' },
    });
    assert.equal(firstCalendars.status, 200);
    const calendarPage = (await firstCalendars.json()) as {
      items: Array<{ id: string; accessRole: string }>;
      nextPageToken?: string;
    };
    assert.equal(calendarPage.items[0]?.accessRole, 'owner');
    assert.match(calendarPage.nextPageToken ?? '', /^[A-Za-z0-9_-]{32}$/);

    const firstEvents = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(firstEvents.status, 200);
    const eventPage = (await firstEvents.json()) as {
      items: Array<{ id: string }>;
      nextPageToken?: string;
    };
    assert.equal(eventPage.items.length, 2);
    assert.match(eventPage.nextPageToken ?? '', /^[A-Za-z0-9_-]{32}$/);
    const crossCalendarReuse = await requestJson(
      `${server.baseUrl}/calendars/other%40example.test/events?singleEvents=true&maxResults=250&pageToken=${encodeURIComponent(eventPage.nextPageToken!)}`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(crossCalendarReuse.status, 404);
    const originatingCalendarPage = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&pageToken=${encodeURIComponent(eventPage.nextPageToken!)}`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(originatingCalendarPage.status, 200);

    const firstIncrementalPage = async (): Promise<string> => {
      const response = await requestJson(
        `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&syncToken=sync-0`,
        { headers: { Authorization: 'Bearer e2e-access-token' } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { nextPageToken?: string };
      assert.match(body.nextPageToken ?? '', /^[A-Za-z0-9_-]{32}$/);
      return body.nextPageToken!;
    };

    const tokenWhoseSyncWillBeDropped = await firstIncrementalPage();
    const missingOriginatingSync = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&pageToken=${encodeURIComponent(tokenWhoseSyncWillBeDropped)}`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(
      missingOriginatingSync.status,
      400,
      'page two must retain the originating incremental sync token'
    );

    const tokenWhoseSyncWillChange = await firstIncrementalPage();
    const changedOriginatingSync = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&syncToken=sync-1&pageToken=${encodeURIComponent(tokenWhoseSyncWillChange)}`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(
      changedOriginatingSync.status,
      400,
      'page two must reject a changed incremental sync token'
    );

    const tokenWithDuplicatedQuery = await firstIncrementalPage();
    const duplicatedRelevantQuery = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&maxResults=251&syncToken=sync-0&pageToken=${encodeURIComponent(tokenWithDuplicatedQuery)}`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(
      duplicatedRelevantQuery.status,
      400,
      'page requests must preserve one exact value for every relevant query parameter'
    );

    const snapshotToken = await firstIncrementalPage();
    const mutateDuringPagination = await requestJson(`${server.controlUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'delete', eventId: 'series-instance-2' }),
    });
    assert.equal(mutateDuringPagination.status, 204);
    const snapshotPageTwo = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&syncToken=sync-0&pageToken=${encodeURIComponent(snapshotToken)}`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(snapshotPageTwo.status, 200);
    const snapshotPageTwoBody = (await snapshotPageTwo.json()) as {
      items: Array<{ id: string; status: string }>;
      nextSyncToken: string;
    };
    assert.equal(snapshotPageTwoBody.items.length, 1);
    assert.equal(snapshotPageTwoBody.items[0]?.id, 'series-instance-2');
    assert.equal(snapshotPageTwoBody.items[0]?.status, 'confirmed');
    assert.equal(snapshotPageTwoBody.nextSyncToken, 'sync-1');

    const resetAfterPagination = await requestJson(`${server.controlUrl}/reset`, {
      method: 'POST',
    });
    assert.equal(resetAfterPagination.status, 204);

    const pageTwoFailure = await requestJson(`${server.controlUrl}/next-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        path: '/calendar/v3/calendars/teaching%40example.test/events',
        nthMatch: 2,
        status: 503,
        body: { error: { message: 'page two failed' } },
      }),
    });
    assert.equal(pageTwoFailure.status, 204);
    const pageBeforeFailure = await firstIncrementalPage();
    const configuredPageTwoFailure = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&syncToken=sync-0&pageToken=${encodeURIComponent(pageBeforeFailure)}`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(configuredPageTwoFailure.status, 503);
    const retryAfterConfiguredPageTwoFailure = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&syncToken=sync-0&pageToken=${encodeURIComponent(pageBeforeFailure)}`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(
      retryAfterConfiguredPageTwoFailure.status,
      200,
      'a transient configured error must not consume the originating page cursor'
    );

    const resetAfterPageFailure = await requestJson(`${server.controlUrl}/reset`, {
      method: 'POST',
    });
    assert.equal(resetAfterPageFailure.status, 204);

    const masterResponse = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events/series-master`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(masterResponse.status, 200);
    const master = (await masterResponse.json()) as { etag: string };

    const patchMaster = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events/series-master`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer e2e-access-token',
          'Content-Type': 'application/json',
          'If-Match': master.etag,
        },
        body: JSON.stringify({ summary: 'Other Studio / Yoga' }),
      }
    );
    assert.equal(patchMaster.status, 200);

    const exceptionResponse = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events/series-instance-2`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    const exception = (await exceptionResponse.json()) as { summary: string };
    assert.equal(exception.summary, 'Cover Studio / Yoga');

    const stalePatch = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events/series-master`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer e2e-access-token',
          'Content-Type': 'application/json',
          'If-Match': master.etag,
        },
        body: JSON.stringify({ description: '9' }),
      }
    );
    assert.equal(stalePatch.status, 412);

    const invalidPatch = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events/lesson-single`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer e2e-access-token',
          'Content-Type': 'application/json',
          'If-Match': '\"single-v1\"',
        },
        body: JSON.stringify({ summary: 'x', description: '9' }),
      }
    );
    assert.equal(invalidPatch.status, 400);

    const logResponse = await requestJson(`${server.controlUrl}/requests`);
    const log = (await logResponse.json()) as Array<Record<string, unknown>>;
    assert.equal(
      log.some((entry) => 'authorization' in entry),
      false
    );
    assert.equal(
      log.some((entry) => entry.method === 'PATCH'),
      true
    );

    const nextError = await requestJson(`${server.controlUrl}/next-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        path: '/calendar/v3/calendars/teaching%40example.test/events/lesson-single',
        status: 503,
        body: { error: { message: 'configured failure' } },
      }),
    });
    assert.equal(nextError.status, 204);
    const malformedBeforeConfiguredFailure = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events/lesson-single?unexpected=true`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(
      malformedBeforeConfiguredFailure.status,
      400,
      'a configured error must not mask a malformed matching request'
    );
    const configuredFailure = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events/lesson-single`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(configuredFailure.status, 503);

    const mutate = await requestJson(`${server.controlUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'patch',
        eventId: 'lesson-single',
        patch: { description: '10' },
      }),
    });
    assert.equal(mutate.status, 204);
    const incremental = await requestJson(
      `${server.baseUrl}/calendars/teaching%40example.test/events?singleEvents=true&maxResults=250&syncToken=sync-1`,
      { headers: { Authorization: 'Bearer e2e-access-token' } }
    );
    assert.equal(incremental.status, 200);
    const incrementalBody = (await incremental.json()) as {
      items: Array<{ id: string; description: string }>;
      nextSyncToken: string;
    };
    assert.equal(
      incrementalBody.items.some((item) => item.description === '10'),
      true
    );
    assert.match(incrementalBody.nextSyncToken, /^sync-\d+$/);

    const unexpectedMutationBody = await requestJson(`${server.controlUrl}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'patch',
        eventId: 'lesson-single',
        patch: { description: '11' },
        unexpected: true,
      }),
    });
    assert.equal(unexpectedMutationBody.status, 400);

    const reset = await requestJson(`${server.controlUrl}/reset`, { method: 'POST' });
    assert.equal(reset.status, 204);
    const afterReset = (await (
      await requestJson(`${server.controlUrl}/requests`)
    ).json()) as unknown[];
    assert.deepEqual(afterReset, []);

    const unexpected = await requestJson(`${server.baseUrl}/unexpected`, {
      headers: { Authorization: 'Bearer e2e-access-token' },
    });
    assert.equal(unexpected.status, 404);
  } finally {
    const closeStartedAt = Date.now();
    await server.close();
    assert.ok(
      Date.now() - closeStartedAt < 1_000,
      'fake server close must not leak timeout handles'
    );
  }
}

if (process.argv.includes('--self-test')) {
  await runContractTests();
  console.log('fake Google Calendar contract tests passed');
}
