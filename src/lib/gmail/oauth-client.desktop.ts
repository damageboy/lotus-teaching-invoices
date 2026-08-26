import { fetch } from '@tauri-apps/plugin-http';
import { GOOGLE_CLIENT_ID, OAUTH_TOKEN_URL } from './constants.js';
import {
  mergeRefreshResponse,
  type OAuthTokenResponse,
  type StoredTokenRecord,
} from './auth-record.js';

export async function exchangeCodeForTokens(
  code: string,
  port: number,
  codeVerifier: string
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `http://127.0.0.1:${port}`,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }
  return (await response.json()) as OAuthTokenResponse;
}

export async function refreshAccessToken(existing: StoredTokenRecord): Promise<StoredTokenRecord> {
  const body = new URLSearchParams({
    refresh_token: existing.refresh_token,
    client_id: GOOGLE_CLIENT_ID,
    grant_type: 'refresh_token',
  });

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`Token refresh failed (${response.status})`);

  const refreshed = mergeRefreshResponse(
    existing,
    (await response.json()) as OAuthTokenResponse,
    Date.now()
  );
  if (!refreshed) throw new Error('Token refresh returned a malformed response');
  return refreshed;
}
