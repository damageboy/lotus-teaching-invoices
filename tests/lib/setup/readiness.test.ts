import { describe, expect, it } from 'vitest';
import {
  deriveSetupReadiness,
  type SetupReadinessInput,
} from '../../../src/lib/setup/readiness.js';

const base: SetupReadinessInput = {
  configLoading: false,
  calendarStatus: 'accessible',
  authorizationLoading: false,
  hasDrive: true,
  driveStatus: 'ready',
  driveSnapshot: {} as SetupReadinessInput['driveSnapshot'],
};

describe('deriveSetupReadiness', () => {
  it('waits for config, authorization, and authorized Drive discovery', () => {
    expect(deriveSetupReadiness({ ...base, configLoading: true }).status).toBe('checking');
    expect(deriveSetupReadiness({ ...base, authorizationLoading: true }).status).toBe('checking');
    expect(
      deriveSetupReadiness({ ...base, driveStatus: 'loading', driveSnapshot: null }).status
    ).toBe('checking');
  });

  it('resolves Drive before Calendar', () => {
    expect(
      deriveSetupReadiness({
        ...base,
        hasDrive: false,
        driveSnapshot: null,
        calendarStatus: 'missing',
      })
    ).toMatchObject({
      status: 'incomplete',
      calendarConfigured: false,
      firstIncompleteStep: 'drive',
    });
    expect(deriveSetupReadiness({ ...base, hasDrive: false, driveSnapshot: null })).toMatchObject({
      status: 'incomplete',
      driveConfigured: false,
      firstIncompleteStep: 'drive',
    });
    expect(deriveSetupReadiness({ ...base, calendarStatus: 'missing' })).toMatchObject({
      status: 'incomplete',
      driveConfigured: true,
      calendarConfigured: false,
      firstIncompleteStep: 'calendar',
    });
  });

  it('waits for Calendar validation only after Drive is configured', () => {
    expect(deriveSetupReadiness({ ...base, calendarStatus: 'checking' })).toMatchObject({
      status: 'checking',
      firstIncompleteStep: 'calendar',
    });
    expect(deriveSetupReadiness({ ...base, calendarStatus: 'unchecked' })).toMatchObject({
      status: 'checking',
      firstIncompleteStep: 'calendar',
    });
    expect(deriveSetupReadiness({ ...base, calendarStatus: 'unavailable' })).toMatchObject({
      status: 'unavailable',
      firstIncompleteStep: 'calendar',
    });
  });

  it('separates a failed initial discovery from a missing remote root', () => {
    expect(
      deriveSetupReadiness({ ...base, driveStatus: 'offline', driveSnapshot: null }).status
    ).toBe('unavailable');
    expect(
      deriveSetupReadiness({ ...base, driveStatus: 'blocked', driveSnapshot: null }).status
    ).toBe('unavailable');
    expect(
      deriveSetupReadiness({ ...base, driveStatus: 'unconfigured', driveSnapshot: null }).status
    ).toBe('incomplete');
  });

  it('keeps a loaded root configured through a later transient Drive error', () => {
    expect(deriveSetupReadiness({ ...base, driveStatus: 'offline' })).toMatchObject({
      status: 'ready',
      driveConfigured: true,
      firstIncompleteStep: null,
    });
  });
});
