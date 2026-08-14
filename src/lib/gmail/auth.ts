import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import {
  BASE_OAUTH_SCOPES,
  CALENDAR_EDIT_OAUTH_SCOPES,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  OAUTH_AUTH_URL,
  OAUTH_TOKEN_URL,
} from './constants.js';
import {
  acceptAuthorizationExchange,
  hasRequiredScopes,
  isVersionedStoredTokens,
  mergeRefreshResponse,
  parseCalendarEditPromptPreference,
  parseStoredTokenRecord,
  type CalendarEditPromptPreference,
  type OAuthTokenResponse,
  type StoredTokenRecord,
} from './auth-record.js';
import { logInfo, logError, logWarn } from '../logger.js';

export interface GetAccessTokenOptions {
  requireCalendarWrite?: boolean;
  forceRefresh?: boolean;
}

let authorizationQueue: Promise<void> = Promise.resolve();

function serializeAuthorization<T>(operation: () => Promise<T>): Promise<T> {
  const result = authorizationQueue.then(operation);
  authorizationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

type OAuthCallbackOutcome =
  | { status: 'success'; code: string }
  | { status: 'accessDenied' }
  | { status: 'timeout' }
  | { status: 'malformedCallback' }
  | { status: 'oauthError'; error: string };

type StorageWriteOutcome =
  | { status: 'durable' }
  | { status: 'committedButDurabilityUncertain' }
  | { status: 'conflict' };

interface LoadedTokenSnapshot {
  raw: string | null;
  record: StoredTokenRecord | null;
}

class StorageWriteConflictError extends Error {}

const MAX_AUTHORIZATION_STORAGE_ATTEMPTS = 3;

/** Returns true if the token is expired or will expire within 60 seconds. */
export function isTokenExpired(expiresAt: number): boolean {
  return Date.now() + 60_000 >= expiresAt;
}

/** Build the Google OAuth consent URL for the given loopback port. */
export function buildConsentUrl(
  port: number,
  oauthState: string,
  scopes: readonly string[] = BASE_OAUTH_SCOPES
): string {
  if (!oauthState) throw new Error('OAuth state is required');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `http://127.0.0.1:${port}`,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: oauthState,
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

async function loadTokens(): Promise<LoadedTokenSnapshot> {
  const raw = await invoke<string | null>('read_auth_tokens');
  return {
    raw,
    record: raw === null ? null : parseStoredTokenRecord(raw),
  };
}

function acceptInstalledWrite(outcome: StorageWriteOutcome, recordName: string): void {
  switch (outcome.status) {
    case 'durable':
      return;
    case 'committedButDurabilityUncertain':
      logWarn(`${recordName} was installed but directory durability could not be confirmed`);
      return;
    case 'conflict':
      throw new StorageWriteConflictError(`${recordName} changed before it could be saved`);
  }
}

async function saveTokens(tokens: StoredTokenRecord, expectedRaw: string | null): Promise<void> {
  const outcome = await invoke<StorageWriteOutcome>('write_auth_tokens', {
    raw: JSON.stringify(tokens, null, 2),
    expectedRaw,
  });
  acceptInstalledWrite(outcome, 'Authorization record');
}

export async function loadCalendarEditPromptPreference(): Promise<CalendarEditPromptPreference | null> {
  try {
    const raw = await invoke<string | null>('read_calendar_edit_prompt_preference');
    return raw === null ? null : parseCalendarEditPromptPreference(raw);
  } catch {
    return null;
  }
}

export async function saveCalendarEditPromptPreference(
  preference: CalendarEditPromptPreference
): Promise<void> {
  const validated = parseCalendarEditPromptPreference(preference);
  if (!validated) throw new Error('Invalid calendar edit prompt preference');
  const outcome = await invoke<StorageWriteOutcome>('write_calendar_edit_prompt_preference', {
    raw: JSON.stringify(validated, null, 2),
  });
  acceptInstalledWrite(outcome, 'Calendar edit prompt preference');
}

async function exchangeCodeForTokens(code: string, port: number): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: `http://127.0.0.1:${port}`,
    grant_type: 'authorization_code',
  });

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as OAuthTokenResponse;
}

async function refreshAccessToken(existing: StoredTokenRecord): Promise<StoredTokenRecord> {
  const body = new URLSearchParams({
    refresh_token: existing.refresh_token,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`Token refresh failed (${resp.status})`);

  const refreshed = mergeRefreshResponse(
    existing,
    (await resp.json()) as OAuthTokenResponse,
    Date.now()
  );
  if (!refreshed) throw new Error('Token refresh returned a malformed response');
  return refreshed;
}

function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)];
}

function createOAuthState(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function authorizationScopes(
  existing: StoredTokenRecord | null,
  requireCalendarWrite: boolean
): string[] {
  const required = requireCalendarWrite ? CALENDAR_EDIT_OAUTH_SCOPES : BASE_OAUTH_SCOPES;
  if (!isVersionedStoredTokens(existing)) return [...required];
  return uniqueScopes([...required, ...existing.granted_scopes]);
}

function callbackCode(outcome: OAuthCallbackOutcome): string {
  switch (outcome.status) {
    case 'success':
      if (!outcome.code) throw new Error('OAuth callback was malformed');
      return outcome.code;
    case 'accessDenied':
      throw new Error('Calendar authorization was denied');
    case 'timeout':
      throw new Error('Calendar authorization timed out or the browser was closed');
    case 'malformedCallback':
      throw new Error('OAuth callback was malformed');
    case 'oauthError':
      throw new Error(`OAuth authorization failed: ${outcome.error}`);
  }
}

async function cancelPendingOAuth(): Promise<void> {
  try {
    await invoke('cancel_oauth_server');
  } catch (error) {
    logError(`Could not cancel pending OAuth listener: ${error}`);
  }
}

async function runOAuthFlow(
  existing: StoredTokenRecord | null,
  expectedRaw: string | null,
  requireCalendarWrite: boolean
): Promise<StoredTokenRecord> {
  const requestedScopes = authorizationScopes(existing, requireCalendarWrite);
  const oauthState = createOAuthState();
  logInfo('Starting Google OAuth flow...');
  const port = await invoke<number>('start_oauth_server', { expectedState: oauthState });
  let outcome: OAuthCallbackOutcome;
  try {
    await open(buildConsentUrl(port, oauthState, requestedScopes));
    logInfo('Waiting for authorization in browser...');
    outcome = await invoke<OAuthCallbackOutcome>('wait_oauth_code', { timeoutSecs: 120 });
  } catch (error) {
    await cancelPendingOAuth();
    throw error;
  }
  const code = callbackCode(outcome);
  logInfo('Authorization code received, exchanging for tokens...');
  const response = await exchangeCodeForTokens(code, port);
  const tokens = acceptAuthorizationExchange(existing, response, requestedScopes, Date.now());
  if (!tokens) {
    throw new Error('Authorization response did not include all required scopes and tokens');
  }
  await saveTokens(tokens, expectedRaw);
  logInfo('Google authorization complete');
  return tokens;
}

/**
 * Get a valid access token. Existing Gmail/calendar-read callers remain compatible.
 * Calendar writes require a current, explicitly recorded write grant.
 */
async function getAccessTokenAttempt(options: GetAccessTokenOptions): Promise<string> {
  const requireCalendarWrite = options.requireCalendarWrite === true;
  const snapshot = await loadTokens();
  const stored = snapshot.record;

  if (stored) {
    if (requireCalendarWrite && !hasRequiredScopes(stored, CALENDAR_EDIT_OAUTH_SCOPES)) {
      return (await runOAuthFlow(stored, snapshot.raw, true)).access_token;
    }

    if (options.forceRefresh === true || isTokenExpired(stored.expires_at)) {
      try {
        logInfo('Refreshing Google access token...');
        const refreshed = await refreshAccessToken(stored);
        await saveTokens(refreshed, snapshot.raw);
        return refreshed.access_token;
      } catch (error) {
        if (error instanceof StorageWriteConflictError) throw error;
        logError(`Token refresh failed, re-authorizing: ${error}`);
      }

      return (await runOAuthFlow(stored, snapshot.raw, requireCalendarWrite)).access_token;
    }

    return stored.access_token;
  }

  return (await runOAuthFlow(null, snapshot.raw, requireCalendarWrite)).access_token;
}

async function getAccessTokenWithStorageRetry(options: GetAccessTokenOptions): Promise<string> {
  for (let attempt = 0; attempt < MAX_AUTHORIZATION_STORAGE_ATTEMPTS; attempt += 1) {
    try {
      return await getAccessTokenAttempt(options);
    } catch (error) {
      if (!(error instanceof StorageWriteConflictError)) throw error;
      if (attempt === MAX_AUTHORIZATION_STORAGE_ATTEMPTS - 1) {
        throw new Error('Authorization storage changed repeatedly; please retry');
      }
    }
  }

  throw new Error('Authorization storage changed repeatedly; please retry');
}

export function getAccessToken(options: GetAccessTokenOptions = {}): Promise<string> {
  return serializeAuthorization(() => getAccessTokenWithStorageRetry(options));
}
