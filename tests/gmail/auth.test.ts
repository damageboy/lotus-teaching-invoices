import { describe, it, expect } from 'vitest';
import { isTokenExpired, buildConsentUrl } from '../../src/lib/gmail/auth';
import { GOOGLE_CLIENT_ID, OAUTH_SCOPES, OAUTH_AUTH_URL } from '../../src/lib/gmail/constants';

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
  it('includes client_id, redirect_uri, scope, and response_type', () => {
    const url = buildConsentUrl(12345);
    expect(url).toContain(`client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}`);
    expect(url).toContain('redirect_uri=' + encodeURIComponent('http://127.0.0.1:12345'));
    // Verify scope is present by parsing the URL and decoding the param
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe(OAUTH_SCOPES);
    expect(url).toContain('response_type=code');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url.startsWith(OAUTH_AUTH_URL)).toBe(true);
  });
});
