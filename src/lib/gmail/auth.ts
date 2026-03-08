import { readTextFile, writeTextFile, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  OAUTH_SCOPES,
  OAUTH_AUTH_URL,
  OAUTH_TOKEN_URL,
  TOKEN_FILE,
} from './constants';
import { logInfo, logError } from '../logger';

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

/** Returns true if the token is expired or will expire within 60 seconds. */
export function isTokenExpired(expiresAt: number): boolean {
  return Date.now() + 60_000 >= expiresAt;
}

/** Build the Google OAuth consent URL for the given loopback port. */
export function buildConsentUrl(port: number): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `http://127.0.0.1:${port}`,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    if (!(await exists(TOKEN_FILE, { baseDir: BaseDirectory.AppData }))) return null;
    const raw = await readTextFile(TOKEN_FILE, { baseDir: BaseDirectory.AppData });
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await writeTextFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), {
    baseDir: BaseDirectory.AppData,
  });
}

async function exchangeCodeForTokens(code: string, port: number): Promise<StoredTokens> {
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

  const data = await resp.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status})`);
  }

  const data = await resp.json();
  return {
    access_token: data.access_token,
    refresh_token: refreshToken, // refresh token is not rotated
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

async function runOAuthFlow(): Promise<StoredTokens> {
  logInfo('Starting Gmail OAuth flow...');
  const port: number = await invoke('start_oauth_server');
  const consentUrl = buildConsentUrl(port);
  await open(consentUrl);
  logInfo('Waiting for authorization in browser...');
  const code: string = await invoke('wait_oauth_code', { timeoutSecs: 120 });
  logInfo('Authorization code received, exchanging for tokens...');
  const tokens = await exchangeCodeForTokens(code, port);
  await saveTokens(tokens);
  logInfo('Gmail authorization complete');
  return tokens;
}

/**
 * Get a valid Gmail access token.
 * Loads from storage, refreshes if expired, or runs full OAuth flow if needed.
 */
export async function getAccessToken(): Promise<string> {
  const stored = await loadTokens();

  if (stored) {
    if (!isTokenExpired(stored.expires_at)) {
      return stored.access_token;
    }
    // Try refresh
    try {
      logInfo('Refreshing Gmail access token...');
      const refreshed = await refreshAccessToken(stored.refresh_token);
      await saveTokens(refreshed);
      return refreshed.access_token;
    } catch (e) {
      logError(`Token refresh failed, re-authorizing: ${e}`);
    }
  }

  // Full OAuth flow
  const tokens = await runOAuthFlow();
  return tokens.access_token;
}
