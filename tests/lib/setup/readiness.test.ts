import { describe, expect, it } from 'vitest';
import {
  deriveSetupReadiness,
  type SetupReadinessInput,
} from '../../../src/lib/setup/readiness.js';

const base: SetupReadinessInput = {
  configLoading: false,
  calendarId: 'teaching@example.test',
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

  it('requires a non-blank Calendar id and a current authorized snapshot', () => {
    expect(deriveSetupReadiness({ ...base, calendarId: '  ' })).toMatchObject({
      status: 'incomplete',
      calendarConfigured: false,
      firstIncompleteStep: 'calendar',
    });
    expect(deriveSetupReadiness({ ...base, hasDrive: false, driveSnapshot: null })).toMatchObject({
      status: 'incomplete',
      driveConfigured: false,
      firstIncompleteStep: 'drive',
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
