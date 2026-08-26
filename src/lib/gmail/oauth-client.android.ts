import type { OAuthTokenResponse, StoredTokenRecord } from './auth-record.js';

const UNAVAILABLE = 'Desktop OAuth token operations are unavailable on Android';

export async function exchangeCodeForTokens(
  _code: string,
  _port: number
): Promise<OAuthTokenResponse> {
  throw new Error(UNAVAILABLE);
}

export async function refreshAccessToken(_existing: StoredTokenRecord): Promise<StoredTokenRecord> {
  throw new Error(UNAVAILABLE);
}
