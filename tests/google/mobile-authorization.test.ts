import { describe, expect, it, vi } from 'vitest';
import {
  authorizeOnAndroid,
  clearEphemeralAccessToken,
  requiredScopes,
} from '../../src/lib/google/mobile-authorization.js';
import {
  CALENDAR_READONLY_SCOPE,
  DRIVE_SCOPE,
  GMAIL_COMPOSE_SCOPE,
} from '../../src/lib/gmail/constants.js';

describe('Android Google authorization', () => {
  it('defaults omitted interaction to a passive native authorization request', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'needsUserAction' });

    await expect(authorizeOnAndroid({}, { invoke })).rejects.toMatchObject({
      code: 'authorizationRequired',
    });
    expect(invoke).toHaveBeenCalledWith('plugin:lotus-mobile|authorize', {
      request: expect.objectContaining({ interactive: false }),
    });
  });

  it('requires the full Drive grant in addition to existing scopes', () => {
    expect(requiredScopes({ requireDrive: true })).toEqual([
      GMAIL_COMPOSE_SCOPE,
      CALENDAR_READONLY_SCOPE,
      DRIVE_SCOPE,
    ]);
  });

  it('rejects a native token whose result omitted Drive', async () => {
    const invoke = vi.fn().mockResolvedValue({
      status: 'authorized',
      accessToken: 'mobile-token',
      grantedScopes: [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE],
    });

    await expect(
      authorizeOnAndroid({ requireDrive: true, interactive: true }, { invoke })
    ).rejects.toThrow('Google did not grant Drive access');
  });

  it('does not launch Android consent during a passive capability check', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'needsUserAction' });

    await expect(
      authorizeOnAndroid({ requireDrive: true, interactive: false }, { invoke })
    ).rejects.toMatchObject({ code: 'authorizationRequired' });
    expect(invoke).toHaveBeenCalledWith('plugin:lotus-mobile|authorize', {
      request: expect.objectContaining({ interactive: false }),
    });
  });

  it('clears the current native token before forcing a replacement', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'authorized',
        accessToken: 'first-mobile-token',
        grantedScopes: [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE, DRIVE_SCOPE],
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'authorized',
        accessToken: 'replacement-mobile-token',
        grantedScopes: [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE, DRIVE_SCOPE],
      });

    await authorizeOnAndroid({ requireDrive: true, interactive: true }, { invoke });
    await expect(
      authorizeOnAndroid({ requireDrive: true, forceRefresh: true, interactive: true }, { invoke })
    ).resolves.toEqual({
      status: 'authorized',
      accessToken: 'replacement-mobile-token',
      grantedScopes: [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE, DRIVE_SCOPE],
    });

    expect(invoke.mock.calls).toEqual([
      [
        'plugin:lotus-mobile|authorize',
        {
          request: {
            scopes: [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE, DRIVE_SCOPE],
            interactive: true,
          },
        },
      ],
      ['plugin:lotus-mobile|clearAccessToken', { request: { accessToken: 'first-mobile-token' } }],
      [
        'plugin:lotus-mobile|authorize',
        {
          request: {
            scopes: [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE, DRIVE_SCOPE],
            interactive: true,
          },
        },
      ],
    ]);

    await clearEphemeralAccessToken({ invoke });
    expect(invoke).toHaveBeenLastCalledWith('plugin:lotus-mobile|clearAccessToken', {
      request: { accessToken: 'replacement-mobile-token' },
    });
  });

  it('retains the ephemeral token when clearing fails so the clear can be retried', async () => {
    const authorize = vi.fn().mockResolvedValue({
      status: 'authorized',
      accessToken: 'retryable-mobile-token',
      grantedScopes: [GMAIL_COMPOSE_SCOPE, CALENDAR_READONLY_SCOPE, DRIVE_SCOPE],
    });
    await authorizeOnAndroid({ requireDrive: true, interactive: true }, { invoke: authorize });

    const clear = vi
      .fn()
      .mockRejectedValueOnce(new Error('Google token clear failed'))
      .mockResolvedValueOnce(null);
    await expect(clearEphemeralAccessToken({ invoke: clear })).rejects.toThrow(
      'Google token clear failed'
    );
    await expect(clearEphemeralAccessToken({ invoke: clear })).resolves.toBeUndefined();

    expect(clear).toHaveBeenCalledTimes(2);
  });
});
