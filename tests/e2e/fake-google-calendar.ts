import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { createIsolatedE2eRun, removeIsolatedE2eRun } from './helpers.js';

export interface FakeGoogleCalendar {
  baseUrl: string;
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

export interface FakeGoogleRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  ifMatch?: string;
  body?: unknown;
}

interface ConfiguredError {
  method: string;
  path: string;
  status: number;
  body: unknown;
  nthMatch: number;
  matches: number;
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(raw),
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
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
  if (!Number.isInteger(original.pageSize) || original.pageSize < 1) {
    throw new Error('Fake Google fixture requires a positive pageSize');
  }
  if (!Number.isInteger(original.calendarPageSize) || original.calendarPageSize < 1) {
    throw new Error('Fake Google fixture requires a positive calendarPageSize');
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

  const sendConfiguredError = (method: string, path: string, response: ServerResponse): boolean => {
    if (!nextError || nextError.method !== method || nextError.path !== path) return false;
    nextError.matches += 1;
    if (nextError.matches !== nextError.nthMatch) return false;
    const configured = nextError;
    nextError = null;
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
  };

  const recordChanges = (changed: FakeEvent[]) => {
    revision += 1;
    changes.set(revision, changed.map(clone));
  };

  const nextEtag = (id: string) => `\"${id}-v${++etagRevision}\"`;

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
        if (method === 'POST' && url.pathname === '/__e2e__/next-error' && !url.search) {
          const candidate = await readJson(request);
          const candidateRecord = candidate as Record<string, unknown> | null;
          const candidateKeys = candidateRecord
            ? Object.keys(candidateRecord).sort().join(',')
            : '';
          if (
            typeof candidate !== 'object' ||
            candidate === null ||
            Array.isArray(candidate) ||
            (candidateKeys !== 'body,method,path,status' &&
              candidateKeys !== 'body,method,nthMatch,path,status') ||
            typeof candidateRecord?.method !== 'string' ||
            typeof candidateRecord.path !== 'string' ||
            !Number.isInteger(candidateRecord.status) ||
            (candidateRecord.nthMatch !== undefined &&
              (!Number.isInteger(candidateRecord.nthMatch) || Number(candidateRecord.nthMatch) < 1))
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

      const body = method === 'PATCH' ? await readJson(request) : undefined;
      const logged: FakeGoogleRequest = {
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        ...(request.headers['if-match'] ? { ifMatch: String(request.headers['if-match']) } : {}),
        ...(body === undefined ? {} : { body }),
      };
      requestLog.push(logged);

      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
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
