import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { BASE_OAUTH_SCOPES, CALENDAR_EVENTS_SCOPE, DRIVE_SCOPE } from '../gmail/constants.js';

export interface GetAccessTokenOptions {
  requireCalendarWrite?: boolean;
  requireDrive?: boolean;
  forceRefresh?: boolean;
  interactive?: boolean;
}

export type MobileAuthorizeResult =
  | { status: 'authorized'; accessToken: string; grantedScopes: string[] }
  | { status: 'needsUserAction' }
  | { status: 'denied' };

export class AuthorizationRequiredError extends Error {
  readonly code = 'authorizationRequired';

  constructor(message = 'Google authorization requires user action') {
    super(message);
    this.name = 'AuthorizationRequiredError';
  }
}

type MobileInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface MobileAuthorizationDependencies {
  invoke: MobileInvoke;
}

const defaultDependencies: MobileAuthorizationDependencies = {
  invoke: tauriInvoke,
};

let ephemeralAccessToken: string | null = null;

export function requiredScopes(options: GetAccessTokenOptions = {}): string[] {
  return [
    ...new Set([
      ...BASE_OAUTH_SCOPES,
      ...(options.requireCalendarWrite ? [CALENDAR_EVENTS_SCOPE] : []),
      ...(options.requireDrive ? [DRIVE_SCOPE] : []),
    ]),
  ];
}

function validateAuthorizedResult(
  result: Extract<MobileAuthorizeResult, { status: 'authorized' }>,
  scopes: readonly string[]
): void {
  const granted = new Set(result.grantedScopes);
  if (scopes.includes(DRIVE_SCOPE) && !granted.has(DRIVE_SCOPE)) {
    throw new Error('Google did not grant Drive access');
  }
  if (scopes.includes(CALENDAR_EVENTS_SCOPE) && !granted.has(CALENDAR_EVENTS_SCOPE)) {
    throw new Error('Google did not grant Calendar write access');
  }
  if (!scopes.every((scope) => granted.has(scope))) {
    throw new Error('Google did not grant all required access');
  }
  if (!result.accessToken) throw new Error('Google authorization returned no access token');
}

export async function clearEphemeralAccessToken(
  dependencies: MobileAuthorizationDependencies = defaultDependencies
): Promise<void> {
  const accessToken = ephemeralAccessToken;
  if (accessToken === null) return;
  await dependencies.invoke('plugin:lotus-mobile|clearAccessToken', {
    request: { accessToken },
  });
  if (ephemeralAccessToken === accessToken) ephemeralAccessToken = null;
}

export async function authorizeOnAndroid(
  options: GetAccessTokenOptions = {},
  dependencies: MobileAuthorizationDependencies = defaultDependencies
): Promise<Extract<MobileAuthorizeResult, { status: 'authorized' }>> {
  if (options.forceRefresh) await clearEphemeralAccessToken(dependencies);

  const scopes = requiredScopes(options);
  const result = await dependencies.invoke<MobileAuthorizeResult>('plugin:lotus-mobile|authorize', {
    request: {
      scopes,
      interactive: options.interactive === true,
    },
  });

  if (result.status === 'needsUserAction') throw new AuthorizationRequiredError();
  if (result.status === 'denied') throw new Error('Google authorization was denied');

  validateAuthorizedResult(result, scopes);
  ephemeralAccessToken = result.accessToken;
  return result;
}

export function isAndroidRuntime(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}
