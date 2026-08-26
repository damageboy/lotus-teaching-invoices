import {
  AUTHORIZATION_SCHEMA_VERSION,
  CALENDAR_EDIT_OAUTH_SCOPES,
  DRIVE_OAUTH_SCOPES,
} from './constants.js';

export interface LegacyStoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface VersionedStoredTokens extends LegacyStoredTokens {
  authorization_version: number;
  granted_scopes: string[];
}

export type StoredTokenRecord = LegacyStoredTokens | VersionedStoredTokens;

export interface CalendarEditPromptPreference {
  dismissed_authorization_version: number;
}

export interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export type CalendarEditAuthorizationState = 'authorized' | 'prompt' | 'dismissed';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isVersionedStoredTokens(
  record: StoredTokenRecord | null
): record is VersionedStoredTokens {
  return (
    record !== null &&
    'authorization_version' in record &&
    'granted_scopes' in record &&
    Number.isInteger(record.authorization_version) &&
    record.granted_scopes.every(isNonEmptyString)
  );
}

export function parseStoredTokenRecord(raw: string | unknown): StoredTokenRecord | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (
    !isRecord(value) ||
    !isNonEmptyString(value.access_token) ||
    !isNonEmptyString(value.refresh_token) ||
    !isFiniteNumber(value.expires_at)
  ) {
    return null;
  }

  const legacy: LegacyStoredTokens = {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: value.expires_at,
  };

  const hasAuthorizationVersion = 'authorization_version' in value;
  const hasGrantedScopes = 'granted_scopes' in value;
  if (!hasAuthorizationVersion && !hasGrantedScopes) return legacy;

  if (
    !Number.isInteger(value.authorization_version) ||
    !Array.isArray(value.granted_scopes) ||
    !value.granted_scopes.every(isNonEmptyString)
  ) {
    return null;
  }

  return {
    ...legacy,
    authorization_version: value.authorization_version as number,
    granted_scopes: [...value.granted_scopes],
  };
}

export function parseCalendarEditPromptPreference(
  raw: string | unknown
): CalendarEditPromptPreference | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (
    !isRecord(value) ||
    !Number.isInteger(value.dismissed_authorization_version) ||
    (value.dismissed_authorization_version as number) < 0
  ) {
    return null;
  }

  return {
    dismissed_authorization_version: value.dismissed_authorization_version as number,
  };
}

export function hasRequiredScopes(
  record: StoredTokenRecord | null,
  requiredScopes: readonly string[]
): boolean {
  if (
    !isVersionedStoredTokens(record) ||
    record.authorization_version !== AUTHORIZATION_SCHEMA_VERSION
  ) {
    return false;
  }

  const granted = new Set(record.granted_scopes);
  return requiredScopes.every((scope) => granted.has(scope));
}

export function hasDriveAuthorization(record: StoredTokenRecord | null): boolean {
  return hasRequiredScopes(record, DRIVE_OAUTH_SCOPES);
}

function parseReturnedScopes(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}

function parseTokenResponseLifetime(
  response: OAuthTokenResponse,
  now: number
): { accessToken: string; expiresAt: number } | null {
  if (
    !isNonEmptyString(response.access_token) ||
    !isFiniteNumber(response.expires_in) ||
    response.expires_in <= 0
  ) {
    return null;
  }

  return {
    accessToken: response.access_token,
    expiresAt: now + response.expires_in * 1000,
  };
}

export function acceptAuthorizationExchange(
  existing: StoredTokenRecord | null,
  response: OAuthTokenResponse,
  requiredScopes: readonly string[],
  now: number
): VersionedStoredTokens | null {
  const lifetime = parseTokenResponseLifetime(response, now);
  const grantedScopes = parseReturnedScopes(response.scope);
  if (!lifetime || !grantedScopes) return null;

  const granted = new Set(grantedScopes);
  if (!requiredScopes.every((scope) => granted.has(scope))) return null;

  const refreshToken = isNonEmptyString(response.refresh_token)
    ? response.refresh_token
    : existing?.refresh_token;
  if (!refreshToken) return null;

  return {
    access_token: lifetime.accessToken,
    refresh_token: refreshToken,
    expires_at: lifetime.expiresAt,
    authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    granted_scopes: grantedScopes,
  };
}

export function mergeRefreshResponse(
  existing: StoredTokenRecord,
  response: OAuthTokenResponse,
  now: number
): StoredTokenRecord | null {
  const lifetime = parseTokenResponseLifetime(response, now);
  if (!lifetime) return null;

  const refreshedBase: LegacyStoredTokens = {
    access_token: lifetime.accessToken,
    refresh_token: isNonEmptyString(response.refresh_token)
      ? response.refresh_token
      : existing.refresh_token,
    expires_at: lifetime.expiresAt,
  };

  if (!isVersionedStoredTokens(existing)) return refreshedBase;

  return {
    ...refreshedBase,
    authorization_version: existing.authorization_version,
    granted_scopes: [...existing.granted_scopes],
  };
}

export function calendarEditAuthorizationState(
  record: StoredTokenRecord | null,
  preference: CalendarEditPromptPreference | null
): CalendarEditAuthorizationState {
  if (hasRequiredScopes(record, CALENDAR_EDIT_OAUTH_SCOPES)) return 'authorized';
  if (preference?.dismissed_authorization_version === AUTHORIZATION_SCHEMA_VERSION) {
    return 'dismissed';
  }
  return 'prompt';
}
