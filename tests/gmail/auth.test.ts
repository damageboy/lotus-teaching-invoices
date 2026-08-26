import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sharedMocks = {
  fetch: vi.fn(),
  invoke: vi.fn(),
  openUrl: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
};

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: sharedMocks.fetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: sharedMocks.invoke }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: sharedMocks.openUrl }));
vi.mock('../../src/lib/logger', () => ({
  logInfo: sharedMocks.logInfo,
  logError: sharedMocks.logError,
  logWarn: sharedMocks.logWarn,
}));

const httpMocks = await import('@tauri-apps/plugin-http');
const coreMocks = await import('@tauri-apps/api/core');
const openerMocks = await import('@tauri-apps/plugin-opener');
const loggerMocks = await import('../../src/lib/logger.js');
const {
  buildConsentUrl,
  getAccessToken,
  isTokenExpired,
  loadCalendarEditPromptPreference,
  requiredScopes,
  saveCalendarEditPromptPreference,
} = await import('../../src/lib/gmail/auth.js');
const {
  AUTHORIZATION_SCHEMA_VERSION,
  BASE_OAUTH_SCOPES,
  CALENDAR_EDIT_OAUTH_SCOPES,
  CALENDAR_READONLY_SCOPE,
  DRIVE_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GOOGLE_CLIENT_ID,
  OAUTH_AUTH_URL,
} = await import('../../src/lib/gmail/constants.js');

const future = Date.now() + 3_600_000;
let storedRaw: string | null;
let promptRaw: string | null;
let authWriteOutcome: { status: string };
let promptWriteOutcome: { status: string };

function versionedRecord(scopes = CALENDAR_EDIT_OAUTH_SCOPES) {
  return {
    access_token: 'stored-access',
    refresh_token: 'stored-refresh',
    expires_at: future,
    authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    granted_scopes: [...scopes],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

let freshAuthContextId = 0;

async function importFreshAuthContext() {
  freshAuthContextId += 1;
  if (freshAuthContextId === 1) {
    return import('../../src/lib/gmail/auth.js?test-context=first');
  }
  return import('../../src/lib/gmail/auth.js?test-context=second');
}

beforeEach(() => {
  vi.clearAllMocks();
  storedRaw = null;
  promptRaw = null;
  authWriteOutcome = { status: 'durable' };
  promptWriteOutcome = { status: 'durable' };
  coreMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'read_auth_tokens':
        return storedRaw;
      case 'write_auth_tokens':
        if (args?.expectedRaw !== storedRaw) return { status: 'conflict' };
        storedRaw = args?.raw as string;
        return authWriteOutcome;
      case 'read_calendar_edit_prompt_preference':
        return promptRaw;
      case 'write_calendar_edit_prompt_preference':
        promptRaw = args?.raw as string;
        return promptWriteOutcome;
      case 'start_oauth_server':
        return 12345;
      case 'cancel_oauth_server':
        return null;
      case 'wait_oauth_code':
        return { status: 'success', code: 'authorization-code' };
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
  openerMocks.openUrl.mockResolvedValue(undefined);
});

describe('isTokenExpired', () => {
  it('returns true when expires_at is in the past', () => {
    expect(isTokenExpired(Date.now() - 1000)).toBe(true);
  });

  it('returns true when expires_at is within 60s buffer', () => {
    expect(isTokenExpired(Date.now() + 30_000)).toBe(true);
  });

  it('returns false when token has time remaining', () => {
    expect(isTokenExpired(Date.now() + 120_000)).toBe(false);
  });
});

describe('buildConsentUrl', () => {
  it('includes the base scopes and incremental authorization flag', () => {
    const url = buildConsentUrl(12345, 'oauth-state', 'test-code-challenge');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:12345');
    expect(parsed.searchParams.get('scope')).toBe(BASE_OAUTH_SCOPES.join(' '));
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('include_granted_scopes')).toBe('true');
    expect(parsed.searchParams.get('state')).toBe('oauth-state');
    expect(parsed.searchParams.get('code_challenge')).toBe('test-code-challenge');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.startsWith(OAUTH_AUTH_URL)).toBe(true);
  });

  it('includes Gmail, calendar read, and calendar write in the upgrade URL', () => {
    const parsed = new URL(
      buildConsentUrl(12345, 'oauth-state', 'test-code-challenge', CALENDAR_EDIT_OAUTH_SCOPES)
    );

    expect(parsed.searchParams.get('scope')?.split(' ')).toEqual(CALENDAR_EDIT_OAUTH_SCOPES);
    expect(parsed.searchParams.get('include_granted_scopes')).toBe('true');
  });
});

describe('requiredScopes', () => {
  it('combines Calendar write and Drive without duplicating base scopes', () => {
    expect(requiredScopes({ requireCalendarWrite: true, requireDrive: true })).toEqual([
      GMAIL_COMPOSE_SCOPE,
      CALENDAR_READONLY_SCOPE,
      'https://www.googleapis.com/auth/calendar.events',
      DRIVE_SCOPE,
    ]);
  });
});

describe('getAccessToken', () => {
  it('keeps a legacy record usable for existing Gmail and read-only calls', async () => {
    storedRaw = JSON.stringify({
      access_token: 'legacy-access',
      refresh_token: 'legacy-refresh',
      expires_at: future,
    });

    await expect(getAccessToken()).resolves.toBe('legacy-access');
    expect(httpMocks.fetch).not.toHaveBeenCalled();
    expect(openerMocks.openUrl).not.toHaveBeenCalled();
  });

  it('upgrades a base-only record only after a complete actual grant', async () => {
    storedRaw = JSON.stringify(versionedRecord(BASE_OAUTH_SCOPES));
    httpMocks.fetch.mockResolvedValue(
      jsonResponse({
        access_token: 'upgraded-access',
        refresh_token: 'upgraded-refresh',
        expires_in: 3600,
        scope: CALENDAR_EDIT_OAUTH_SCOPES.join(' '),
      })
    );

    await expect(getAccessToken({ requireCalendarWrite: true })).resolves.toBe('upgraded-access');

    const opened = new URL(openerMocks.openUrl.mock.calls[0][0]);
    expect(opened.searchParams.get('scope')?.split(' ')).toEqual(CALENDAR_EDIT_OAUTH_SCOPES);
    expect(opened.searchParams.get('include_granted_scopes')).toBe('true');
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256');
    const tokenRequest = new URLSearchParams(
      String(httpMocks.fetch.mock.calls[0]?.[1]?.body ?? '')
    );
    const codeVerifier = tokenRequest.get('code_verifier');
    expect(codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(opened.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(codeVerifier!).digest('base64url')
    );
    expect(tokenRequest.has('client_secret')).toBe(false);
    const expectedState = coreMocks.invoke.mock.calls.find(
      ([command]) => command === 'start_oauth_server'
    )?.[1]?.expectedState;
    expect(expectedState).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.searchParams.get('state')).toBe(expectedState);
    expect(JSON.parse(storedRaw!)).toMatchObject({
      access_token: 'upgraded-access',
      authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      granted_scopes: CALENDAR_EDIT_OAUTH_SCOPES,
    });
  });

  it('does not open desktop consent when a passive Drive check needs an upgrade', async () => {
    storedRaw = JSON.stringify(versionedRecord(BASE_OAUTH_SCOPES));

    await expect(getAccessToken({ requireDrive: true, interactive: false })).rejects.toMatchObject({
      code: 'authorizationRequired',
    });

    expect(openerMocks.openUrl).not.toHaveBeenCalled();
    expect(httpMocks.fetch).not.toHaveBeenCalled();
  });

  it('does not open desktop consent after a passive refresh failure', async () => {
    storedRaw = JSON.stringify({
      ...versionedRecord(),
      expires_at: Date.now() - 1,
    });
    httpMocks.fetch.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(getAccessToken({ interactive: false })).rejects.toMatchObject({
      code: 'authorizationRequired',
    });

    expect(httpMocks.fetch).toHaveBeenCalledTimes(1);
    expect(openerMocks.openUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['access denial', { status: 'accessDenied' }],
    ['browser close or timeout', { status: 'timeout' }],
    ['malformed callback', { status: 'malformedCallback' }],
  ])('retains the previous record byte-for-byte after %s', async (_name, outcome) => {
    storedRaw = JSON.stringify(versionedRecord(BASE_OAUTH_SCOPES), null, 4);
    const before = storedRaw;
    coreMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_auth_tokens') return storedRaw;
      if (command === 'write_auth_tokens') {
        storedRaw = args?.raw as string;
        return { status: 'durable' };
      }
      if (command === 'start_oauth_server') return 12345;
      if (command === 'wait_oauth_code') return outcome;
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(getAccessToken({ requireCalendarWrite: true })).rejects.toThrow();

    expect(storedRaw).toBe(before);
    expect(httpMocks.fetch).not.toHaveBeenCalled();
  });

  it('retains the previous record byte-for-byte after token exchange failure', async () => {
    storedRaw = JSON.stringify(versionedRecord(BASE_OAUTH_SCOPES), null, 4);
    const before = storedRaw;
    httpMocks.fetch.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(getAccessToken({ requireCalendarWrite: true })).rejects.toThrow(
      'Token exchange failed'
    );
    expect(storedRaw).toBe(before);
  });

  it('retains the previous record byte-for-byte after a partial grant', async () => {
    storedRaw = JSON.stringify(versionedRecord(BASE_OAUTH_SCOPES), null, 4);
    const before = storedRaw;
    httpMocks.fetch.mockResolvedValue(
      jsonResponse({
        access_token: 'partial-access',
        refresh_token: 'partial-refresh',
        expires_in: 3600,
        scope: BASE_OAUTH_SCOPES.join(' '),
      })
    );

    await expect(getAccessToken({ requireCalendarWrite: true })).rejects.toThrow('required scopes');
    expect(storedRaw).toBe(before);
  });

  it('force-refreshes exactly once while preserving version and granted scopes', async () => {
    storedRaw = JSON.stringify(versionedRecord());
    httpMocks.fetch.mockResolvedValue(
      jsonResponse({ access_token: 'refreshed-access', expires_in: 3600 })
    );

    await expect(getAccessToken({ forceRefresh: true })).resolves.toBe('refreshed-access');

    expect(httpMocks.fetch).toHaveBeenCalledTimes(1);
    const tokenRequest = new URLSearchParams(
      String(httpMocks.fetch.mock.calls[0]?.[1]?.body ?? '')
    );
    expect(tokenRequest.get('grant_type')).toBe('refresh_token');
    expect(tokenRequest.has('client_secret')).toBe(false);
    expect(openerMocks.openUrl).not.toHaveBeenCalled();
    expect(JSON.parse(storedRaw!)).toMatchObject({
      access_token: 'refreshed-access',
      authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      granted_scopes: CALENDAR_EDIT_OAUTH_SCOPES,
    });
  });

  it('uses a committed auth write after parent sync failure without reauthorizing', async () => {
    storedRaw = JSON.stringify(versionedRecord());
    authWriteOutcome = { status: 'committedButDurabilityUncertain' };
    httpMocks.fetch.mockResolvedValue(
      jsonResponse({ access_token: 'uncertain-refreshed-access', expires_in: 3600 })
    );

    await expect(getAccessToken({ forceRefresh: true })).resolves.toBe(
      'uncertain-refreshed-access'
    );

    expect(httpMocks.fetch).toHaveBeenCalledTimes(1);
    expect(openerMocks.openUrl).not.toHaveBeenCalled();
    expect(
      coreMocks.invoke.mock.calls.filter(([command]) => command === 'write_auth_tokens')
    ).toHaveLength(1);
    expect(loggerMocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining('installed but directory durability could not be confirmed')
    );
    expect(loggerMocks.logWarn.mock.calls.flat().join(' ')).not.toContain(
      'uncertain-refreshed-access'
    );
  });

  it('requests every known scope when refresh failure falls back to reauthorization', async () => {
    const knownScopes = [...CALENDAR_EDIT_OAUTH_SCOPES, 'scope.extra'];
    storedRaw = JSON.stringify(versionedRecord(knownScopes));
    httpMocks.fetch
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'reauthorized-access',
          refresh_token: 'reauthorized-refresh',
          expires_in: 3600,
          scope: knownScopes.join(' '),
        })
      );

    await expect(getAccessToken({ forceRefresh: true })).resolves.toBe('reauthorized-access');

    expect(httpMocks.fetch).toHaveBeenCalledTimes(2);
    const opened = new URL(openerMocks.openUrl.mock.calls[0][0]);
    expect(opened.searchParams.get('scope')?.split(' ')).toEqual(knownScopes);
  });

  it('serializes an upgrade before a forced refresh without downgrading the saved grant', async () => {
    storedRaw = JSON.stringify({
      ...versionedRecord(BASE_OAUTH_SCOPES),
      expires_at: Date.now() - 1,
    });
    const upgradeExchange = deferred<ReturnType<typeof jsonResponse>>();
    const refreshExchange = deferred<ReturnType<typeof jsonResponse>>();
    const upgradeStarted = deferred<void>();
    const refreshStarted = deferred<void>();
    httpMocks.fetch.mockImplementation(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.includes('grant_type=authorization_code')) {
        upgradeStarted.resolve();
        return upgradeExchange.promise;
      }
      if (body.includes('grant_type=refresh_token')) {
        refreshStarted.resolve();
        return refreshExchange.promise;
      }
      throw new Error(`Unexpected token request: ${body}`);
    });

    const upgrade = getAccessToken({ requireCalendarWrite: true });
    await upgradeStarted.promise;
    const forcedRefresh = getAccessToken({ forceRefresh: true });
    await flushMicrotasks();
    const refreshStartedBeforeUpgradeSaved = httpMocks.fetch.mock.calls.length > 1;

    upgradeExchange.resolve(
      jsonResponse({
        access_token: 'upgraded-access',
        refresh_token: 'upgraded-refresh',
        expires_in: 3600,
        scope: CALENDAR_EDIT_OAUTH_SCOPES.join(' '),
      })
    );
    await expect(upgrade).resolves.toBe('upgraded-access');
    await refreshStarted.promise;
    refreshExchange.resolve(
      jsonResponse({
        access_token: 'post-upgrade-refreshed-access',
        expires_in: 3600,
      })
    );
    await expect(forcedRefresh).resolves.toBe('post-upgrade-refreshed-access');

    expect(refreshStartedBeforeUpgradeSaved).toBe(false);
    expect(JSON.parse(storedRaw!)).toMatchObject({
      access_token: 'post-upgrade-refreshed-access',
      refresh_token: 'upgraded-refresh',
      authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      granted_scopes: CALENDAR_EDIT_OAUTH_SCOPES,
    });
  });

  it('uses CAS across isolated module contexts and retries a stale refresh from upgraded storage', async () => {
    const originalRaw = JSON.stringify({
      ...versionedRecord(BASE_OAUTH_SCOPES),
      expires_at: Date.now() - 1,
    });
    storedRaw = originalRaw;
    const contextA = await importFreshAuthContext();
    const contextB = await importFreshAuthContext();
    coreMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_auth_tokens') return storedRaw;
      if (command === 'write_auth_tokens') {
        if (args?.expectedRaw !== storedRaw) return { status: 'conflict' };
        storedRaw = args.raw as string;
        return { status: 'durable' };
      }
      if (command === 'start_oauth_server') return 12345;
      if (command === 'wait_oauth_code') {
        return { status: 'success', code: 'authorization-code' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const upgradeExchange = deferred<ReturnType<typeof jsonResponse>>();
    const staleRefreshExchange = deferred<ReturnType<typeof jsonResponse>>();
    const upgradeStarted = deferred<void>();
    const staleRefreshStarted = deferred<void>();
    const refreshTokens: string[] = [];
    httpMocks.fetch.mockImplementation(async (_url, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      if (params.get('grant_type') === 'authorization_code') {
        upgradeStarted.resolve();
        return upgradeExchange.promise;
      }
      const refreshToken = params.get('refresh_token') ?? '';
      refreshTokens.push(refreshToken);
      if (refreshToken === 'stored-refresh') {
        staleRefreshStarted.resolve();
        return staleRefreshExchange.promise;
      }
      if (refreshToken === 'upgraded-refresh') {
        return jsonResponse({ access_token: 'post-conflict-access', expires_in: 3600 });
      }
      throw new Error('Unexpected refresh credential');
    });

    const upgrade = contextA.getAccessToken({ requireCalendarWrite: true });
    await upgradeStarted.promise;
    const staleRefresh = contextB.getAccessToken({ forceRefresh: true });
    await staleRefreshStarted.promise;
    upgradeExchange.resolve(
      jsonResponse({
        access_token: 'upgraded-access',
        refresh_token: 'upgraded-refresh',
        expires_in: 3600,
        scope: CALENDAR_EDIT_OAUTH_SCOPES.join(' '),
      })
    );
    await expect(upgrade).resolves.toBe('upgraded-access');
    staleRefreshExchange.resolve(
      jsonResponse({ access_token: 'discarded-stale-access', expires_in: 3600 })
    );

    await expect(staleRefresh).resolves.toBe('post-conflict-access');
    expect(refreshTokens).toEqual(['stored-refresh', 'upgraded-refresh']);
    expect(JSON.parse(storedRaw!)).toMatchObject({
      access_token: 'post-conflict-access',
      refresh_token: 'upgraded-refresh',
      authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      granted_scopes: CALENDAR_EDIT_OAUTH_SCOPES,
    });
  });

  it('bounds repeated CAS conflicts and leaves stored credentials unchanged', async () => {
    const originalRaw = JSON.stringify(versionedRecord());
    storedRaw = originalRaw;
    coreMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'read_auth_tokens') return storedRaw;
      if (command === 'write_auth_tokens') return { status: 'conflict' };
      throw new Error(`Unexpected command: ${command}`);
    });
    httpMocks.fetch.mockResolvedValue(
      jsonResponse({ access_token: 'must-be-discarded', expires_in: 3600 })
    );

    await expect(getAccessToken({ forceRefresh: true })).rejects.toThrow(
      'Authorization storage changed repeatedly'
    );

    expect(httpMocks.fetch).toHaveBeenCalledTimes(3);
    expect(storedRaw).toBe(originalRaw);
    expect(openerMocks.openUrl).not.toHaveBeenCalled();

    await expect(getAccessToken()).resolves.toBe('stored-access');
    expect(httpMocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('passes null as the expected snapshot when no auth file exists', async () => {
    storedRaw = null;
    httpMocks.fetch.mockResolvedValue(
      jsonResponse({
        access_token: 'first-access',
        refresh_token: 'first-refresh',
        expires_in: 3600,
        scope: BASE_OAUTH_SCOPES.join(' '),
      })
    );

    await expect(getAccessToken()).resolves.toBe('first-access');

    const write = coreMocks.invoke.mock.calls.find(([command]) => command === 'write_auth_tokens');
    expect(write?.[1]?.expectedRaw).toBeNull();
  });

  it('passes malformed existing auth bytes as the exact expected snapshot', async () => {
    storedRaw = '{malformed existing auth';
    const malformedRaw = storedRaw;
    httpMocks.fetch.mockResolvedValue(
      jsonResponse({
        access_token: 'replacement-access',
        refresh_token: 'replacement-refresh',
        expires_in: 3600,
        scope: BASE_OAUTH_SCOPES.join(' '),
      })
    );

    await expect(getAccessToken()).resolves.toBe('replacement-access');

    const write = coreMocks.invoke.mock.calls.find(([command]) => command === 'write_auth_tokens');
    expect(write?.[1]?.expectedRaw).toBe(malformedRaw);
  });

  it('releases the authorization queue after a rejected operation', async () => {
    storedRaw = JSON.stringify(versionedRecord(BASE_OAUTH_SCOPES));
    const callback = deferred<{ status: 'accessDenied' }>();
    const callbackStarted = deferred<void>();
    let readCount = 0;
    coreMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_auth_tokens') {
        readCount += 1;
        return storedRaw;
      }
      if (command === 'write_auth_tokens') {
        storedRaw = args?.raw as string;
        return { status: 'durable' };
      }
      if (command === 'start_oauth_server') return 12345;
      if (command === 'wait_oauth_code') {
        callbackStarted.resolve();
        return callback.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const rejectedUpgrade = getAccessToken({ requireCalendarWrite: true });
    await callbackStarted.promise;
    const nextRead = getAccessToken();
    await flushMicrotasks();
    const readsBeforeRejection = readCount;
    callback.resolve({ status: 'accessDenied' });

    await expect(rejectedUpgrade).rejects.toThrow('denied');
    await expect(nextRead).resolves.toBe('stored-access');
    expect(readsBeforeRejection).toBe(1);
    expect(readCount).toBe(2);
  });

  it('cancels a pending listener after browser launch fails so authorization can retry', async () => {
    storedRaw = JSON.stringify(versionedRecord(BASE_OAUTH_SCOPES));
    let listenerPending = false;
    coreMocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_auth_tokens') return storedRaw;
      if (command === 'write_auth_tokens') {
        storedRaw = args?.raw as string;
        return { status: 'durable' };
      }
      if (command === 'start_oauth_server') {
        if (listenerPending) throw new Error('OAuth authorization is already in progress');
        listenerPending = true;
        return 12345;
      }
      if (command === 'cancel_oauth_server') {
        listenerPending = false;
        return null;
      }
      if (command === 'wait_oauth_code') {
        listenerPending = false;
        return { status: 'success', code: 'authorization-code' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    openerMocks.openUrl
      .mockRejectedValueOnce(new Error('Browser launch failed'))
      .mockResolvedValueOnce(undefined);
    httpMocks.fetch.mockResolvedValue(
      jsonResponse({
        access_token: 'upgraded-access',
        refresh_token: 'upgraded-refresh',
        expires_in: 3600,
        scope: CALENDAR_EDIT_OAUTH_SCOPES.join(' '),
      })
    );

    await expect(getAccessToken({ requireCalendarWrite: true })).rejects.toThrow(
      'Browser launch failed'
    );
    await expect(getAccessToken({ requireCalendarWrite: true })).resolves.toBe('upgraded-access');

    expect(
      coreMocks.invoke.mock.calls.filter(([command]) => command === 'cancel_oauth_server')
    ).toHaveLength(1);
  });
});

describe('calendar edit prompt preference', () => {
  it('loads the separate versioned prompt preference', async () => {
    promptRaw = JSON.stringify({
      dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    });

    await expect(loadCalendarEditPromptPreference()).resolves.toEqual({
      dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    });
  });

  it('persists Not now separately without mutating credentials', async () => {
    storedRaw = JSON.stringify(versionedRecord(BASE_OAUTH_SCOPES), null, 4);
    const before = storedRaw;

    await saveCalendarEditPromptPreference({
      dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    });

    expect(storedRaw).toBe(before);
    expect(JSON.parse(promptRaw!)).toEqual({
      dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    });
  });

  it('treats a committed prompt write as installed when parent sync is uncertain', async () => {
    promptWriteOutcome = { status: 'committedButDurabilityUncertain' };

    await expect(
      saveCalendarEditPromptPreference({
        dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      })
    ).resolves.toBeUndefined();

    expect(loggerMocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining('installed but directory durability could not be confirmed')
    );
    expect(loggerMocks.logWarn.mock.calls.flat().join(' ')).not.toContain(
      'dismissed_authorization_version'
    );
  });
});
