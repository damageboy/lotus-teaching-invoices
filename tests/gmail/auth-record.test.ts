import { describe, expect, it } from 'vitest';
import {
  acceptAuthorizationExchange,
  calendarEditAuthorizationState,
  hasRequiredScopes,
  mergeRefreshResponse,
  parseStoredTokenRecord,
  type LegacyStoredTokens,
  type VersionedStoredTokens,
} from '../../src/lib/gmail/auth-record';
import {
  AUTHORIZATION_SCHEMA_VERSION,
  BASE_OAUTH_SCOPES,
  CALENDAR_EDIT_OAUTH_SCOPES,
  CALENDAR_EVENTS_SCOPE,
} from '../../src/lib/gmail/constants';

const NOW = 1_700_000_000_000;

const legacy: LegacyStoredTokens = {
  access_token: 'legacy-access',
  refresh_token: 'legacy-refresh',
  expires_at: NOW + 60_000,
};

const versioned: VersionedStoredTokens = {
  access_token: 'old-access',
  refresh_token: 'old-refresh',
  expires_at: NOW + 60_000,
  authorization_version: AUTHORIZATION_SCHEMA_VERSION,
  granted_scopes: [...CALENDAR_EDIT_OAUTH_SCOPES, 'scope.extra'],
};

describe('stored authorization records', () => {
  it('keeps a legacy token readable but never write-capable', () => {
    const parsed = parseStoredTokenRecord(JSON.stringify(legacy));

    expect(parsed).toEqual(legacy);
    expect(hasRequiredScopes(parsed, BASE_OAUTH_SCOPES)).toBe(false);
    expect(hasRequiredScopes(parsed, [CALENDAR_EVENTS_SCOPE])).toBe(false);
    expect(calendarEditAuthorizationState(parsed, null)).toBe('prompt');
  });

  it('records the complete grant using the actual returned scopes and current version', () => {
    const actualScopes = ['scope.extra', ...CALENDAR_EDIT_OAUTH_SCOPES];

    const accepted = acceptAuthorizationExchange(
      legacy,
      {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: actualScopes.join(' '),
      },
      CALENDAR_EDIT_OAUTH_SCOPES,
      NOW
    );

    expect(accepted).toEqual({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_at: NOW + 3_600_000,
      authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      granted_scopes: actualScopes,
    });
    expect(calendarEditAuthorizationState(accepted, null)).toBe('authorized');
  });

  it('rejects a grant missing calendar write without replacing the old record', () => {
    const before = JSON.stringify(versioned);

    const accepted = acceptAuthorizationExchange(
      versioned,
      {
        access_token: 'partial-access',
        refresh_token: 'partial-refresh',
        expires_in: 3600,
        scope: BASE_OAUTH_SCOPES.join(' '),
      },
      CALENDAR_EDIT_OAUTH_SCOPES,
      NOW
    );

    expect(accepted).toBeNull();
    expect(JSON.stringify(versioned)).toBe(before);
  });

  it.each(BASE_OAUTH_SCOPES)(
    'rejects a grant missing required existing scope %s without replacing the old record',
    (missingScope) => {
      const before = JSON.stringify(versioned);
      const returnedScopes = CALENDAR_EDIT_OAUTH_SCOPES.filter((scope) => scope !== missingScope);

      const accepted = acceptAuthorizationExchange(
        versioned,
        {
          access_token: 'partial-access',
          refresh_token: 'partial-refresh',
          expires_in: 3600,
          scope: returnedScopes.join(' '),
        },
        CALENDAR_EDIT_OAUTH_SCOPES,
        NOW
      );

      expect(accepted).toBeNull();
      expect(JSON.stringify(versioned)).toBe(before);
    }
  );

  it('rejects an exchange whose response omits the actual scope list', () => {
    expect(
      acceptAuthorizationExchange(
        versioned,
        {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        },
        CALENDAR_EDIT_OAUTH_SCOPES,
        NOW
      )
    ).toBeNull();
  });

  it('preserves the existing refresh token when the exchange omits a new one', () => {
    const accepted = acceptAuthorizationExchange(
      versioned,
      {
        access_token: 'new-access',
        expires_in: 3600,
        scope: CALENDAR_EDIT_OAUTH_SCOPES.join(' '),
      },
      CALENDAR_EDIT_OAUTH_SCOPES,
      NOW
    );

    expect(accepted?.refresh_token).toBe('old-refresh');
  });

  it('rejects a first authorization that supplies no refresh token', () => {
    expect(
      acceptAuthorizationExchange(
        null,
        {
          access_token: 'new-access',
          expires_in: 3600,
          scope: CALENDAR_EDIT_OAUTH_SCOPES.join(' '),
        },
        CALENDAR_EDIT_OAUTH_SCOPES,
        NOW
      )
    ).toBeNull();
  });

  it('preserves scopes and authorization version across refresh', () => {
    const refreshed = mergeRefreshResponse(
      versioned,
      {
        access_token: 'refreshed-access',
        expires_in: 1800,
        scope: BASE_OAUTH_SCOPES.join(' '),
      },
      NOW
    );

    expect(refreshed).toEqual({
      ...versioned,
      access_token: 'refreshed-access',
      expires_at: NOW + 1_800_000,
    });
  });

  it('refreshes a legacy record without inventing version or scopes', () => {
    expect(
      mergeRefreshResponse(
        legacy,
        { access_token: 'refreshed-access', expires_in: 1800, scope: CALENDAR_EVENTS_SCOPE },
        NOW
      )
    ).toEqual({
      ...legacy,
      access_token: 'refreshed-access',
      expires_at: NOW + 1_800_000,
    });
  });

  it('suppresses a declined prompt only for the current authorization version', () => {
    expect(
      calendarEditAuthorizationState(legacy, {
        dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      })
    ).toBe('dismissed');
    expect(
      calendarEditAuthorizationState(legacy, {
        dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION - 1,
      })
    ).toBe('prompt');
  });
});
