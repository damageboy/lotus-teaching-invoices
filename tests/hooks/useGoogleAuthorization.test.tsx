import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import {
  AUTHORIZATION_SCHEMA_VERSION,
  BASE_OAUTH_SCOPES,
  CALENDAR_EDIT_OAUTH_SCOPES,
  DRIVE_OAUTH_SCOPES,
} from '../../src/lib/gmail/constants.js';

const restoreDom = installReactTestEnvironment();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useGoogleAuthorization } = await import('../../src/hooks/useGoogleAuthorization.js');

const mocks = {
  readAuthTokens: vi.fn(),
  getAccessToken: vi.fn(),
  loadPreference: vi.fn(),
  savePreference: vi.fn(),
  isAndroid: vi.fn(),
};

const dependencies = {
  ...mocks,
  loadPreference: mocks.loadPreference,
  savePreference: mocks.savePreference,
};

function authorizationRecord(scopes: readonly string[]) {
  return JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: Date.now() + 3_600_000,
    authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    granted_scopes: [...scopes],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAndroid.mockReturnValue(false);
  mocks.loadPreference.mockResolvedValue(null);
  mocks.savePreference.mockResolvedValue(undefined);
});

describe('useGoogleAuthorization Drive state', () => {
  it('derives desktop Drive capability from the durable versioned record', async () => {
    mocks.readAuthTokens.mockResolvedValue(authorizationRecord(DRIVE_OAUTH_SCOPES));

    const { result } = renderHook(() => useGoogleAuthorization(dependencies));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasDrive).toBe(true);
    expect(result.current.hasCalendarWrite).toBe(false);
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it('uses interactive authorization only when Drive is explicitly allowed', async () => {
    mocks.readAuthTokens.mockResolvedValue(authorizationRecord(CALENDAR_EDIT_OAUTH_SCOPES));
    mocks.getAccessToken.mockResolvedValue('drive-token');

    const { result } = renderHook(() => useGoogleAuthorization(dependencies));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => result.current.allowDrive());

    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      requireDrive: true,
      interactive: true,
    });
    expect(result.current.hasCalendarWrite).toBe(true);
    expect(result.current.hasDrive).toBe(true);
    expect(result.current.authorizationIncarnation).toBe(1);
  });

  it('leaves existing Calendar capability unchanged when Drive is denied', async () => {
    mocks.readAuthTokens.mockResolvedValue(authorizationRecord(CALENDAR_EDIT_OAUTH_SCOPES));
    mocks.getAccessToken.mockRejectedValue(new Error('Google authorization was denied'));

    const { result } = renderHook(() => useGoogleAuthorization(dependencies));
    await waitFor(() => expect(result.current.hasCalendarWrite).toBe(true));

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.allowDrive();
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toEqual(
      expect.objectContaining({ message: 'Google authorization was denied' })
    );
    expect(result.current.error).toBe('Google authorization was denied');
    expect(result.current.hasCalendarWrite).toBe(true);
    expect(result.current.hasDrive).toBe(false);
    expect(result.current.authorizationIncarnation).toBe(0);
  });

  it('checks Android capabilities passively without reading desktop credentials', async () => {
    mocks.isAndroid.mockReturnValue(true);
    mocks.getAccessToken.mockImplementation(async (options) => {
      if (options.requireCalendarWrite) return 'calendar-token';
      throw Object.assign(new Error('Authorization required'), {
        code: 'authorizationRequired',
      });
    });

    const { result } = renderHook(() => useGoogleAuthorization(dependencies));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mocks.getAccessToken.mock.calls).toEqual([
      [{ requireCalendarWrite: true, interactive: false }],
      [{ requireDrive: true, interactive: false }],
    ]);
    expect(mocks.readAuthTokens).not.toHaveBeenCalled();
    expect(result.current.hasCalendarWrite).toBe(true);
    expect(result.current.hasDrive).toBe(false);
  });

  it('keeps legacy base-only desktop records without Drive capability', async () => {
    mocks.readAuthTokens.mockResolvedValue(authorizationRecord(BASE_OAUTH_SCOPES));

    const { result } = renderHook(() => useGoogleAuthorization(dependencies));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasDrive).toBe(false);
  });
});

afterEach(() => cleanup());
afterAll(() => restoreDom());
