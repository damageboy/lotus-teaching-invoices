export const GOOGLE_CLIENT_ID =
  '918178070743-m12oc3dv1rp40blkdomhc1767oigocpr.apps.googleusercontent.com';

export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

export const BASE_OAUTH_SCOPES = [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE] as const;
export const CALENDAR_EDIT_OAUTH_SCOPES = [...BASE_OAUTH_SCOPES, CALENDAR_EVENTS_SCOPE] as const;
export const DRIVE_OAUTH_SCOPES = [...BASE_OAUTH_SCOPES, DRIVE_SCOPE] as const;

export const AUTHORIZATION_SCHEMA_VERSION = 1;

/** @deprecated Prefer BASE_OAUTH_SCOPES so scope checks remain explicit. */
export const OAUTH_SCOPES = BASE_OAUTH_SCOPES.join(' ');

export const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
export const TOKEN_FILE = 'google-tokens.json';
