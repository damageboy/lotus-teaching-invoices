export const GOOGLE_CLIENT_ID =
  '918178070743-m12oc3dv1rp40blkdomhc1767oigocpr.apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = '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';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

export const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
export const TOKEN_FILE = 'gmail-tokens.json';
