import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReactTestEnvironment } from '../helpers/react-test-env.js';
import {
  AUTHORIZATION_SCHEMA_VERSION,
  BASE_OAUTH_SCOPES,
  CALENDAR_EDIT_OAUTH_SCOPES,
} from '../../src/lib/gmail/constants.js';
import { parsedClass } from '../helpers/calendar-fixtures.js';

const mocks = {
  invoke: vi.fn(),
  listCalendars: vi.fn(),
  getAccessToken: vi.fn(),
  loadPreference: vi.fn(),
  savePreference: vi.fn(),
};

const authorizationDependencies = {
  readAuthTokens: () => mocks.invoke('read_auth_tokens') as Promise<string | null>,
  getAccessToken: mocks.getAccessToken,
  loadPreference: mocks.loadPreference,
  savePreference: mocks.savePreference,
};

const restoreDom = installReactTestEnvironment();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useCalendarEditing } = await import('../../src/hooks/useCalendarEditing.js');
const { useGoogleAuthorization } = await import('../../src/hooks/useGoogleAuthorization.js');

function authorizationRecord(scopes: readonly string[]) {
  return JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: Date.now() + 3_600_000,
    authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    granted_scopes: [...scopes],
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useCalendarEditing', () => {
  beforeEach(() => {
    mocks.listCalendars.mockReset();
  });

  it.each(['owner', 'writer'] as const)(
    'enables editing only after a fresh %s role with a complete write grant',
    async (accessRole) => {
      let resolveCalendars!: (value: unknown) => void;
      mocks.listCalendars.mockReturnValue(
        new Promise((resolve) => {
          resolveCalendars = resolve;
        })
      );

      const { result } = renderHook(() =>
        useCalendarEditing({
          calendarId: 'calendar-1',
          persistedAccessRole: accessRole,
          hasCalendarWrite: true,
          authorizationLoading: false,
          loadCalendars: mocks.listCalendars,
        })
      );

      expect(result.current.status).toBe('roleStale');
      expect(result.current.accessRole).toBe(accessRole);
      expect(result.current.roleFresh).toBe(false);
      expect(result.current.canEdit).toBe(false);

      await act(async () => {
        resolveCalendars([{ id: 'calendar-1', summary: 'Teaching', accessRole }]);
      });

      await waitFor(() => expect(result.current.status).toBe('enabled'));
      expect(result.current.roleFresh).toBe(true);
      expect(result.current.canEdit).toBe(true);
    }
  );

  it('reports a missing calendar.events grant without calling CalendarList', () => {
    const { result } = renderHook(() =>
      useCalendarEditing({
        calendarId: 'calendar-1',
        persistedAccessRole: 'owner',
        hasCalendarWrite: false,
        authorizationLoading: false,
        loadCalendars: mocks.listCalendars,
      })
    );

    expect(result.current.status).toBe('scopeMissing');
    expect(result.current.canEdit).toBe(false);
    expect(mocks.listCalendars).not.toHaveBeenCalled();
  });

  it.each(['reader', 'freeBusyReader'] as const)(
    'keeps a fresh %s calendar read-only',
    async (accessRole) => {
      mocks.listCalendars.mockResolvedValue([
        { id: 'calendar-1', summary: 'Teaching', accessRole },
      ]);

      const { result } = renderHook(() =>
        useCalendarEditing({
          calendarId: 'calendar-1',
          persistedAccessRole: 'owner',
          hasCalendarWrite: true,
          authorizationLoading: false,
          loadCalendars: mocks.listCalendars,
        })
      );

      await waitFor(() => expect(result.current.status).toBe('calendarReadOnly'));
      expect(result.current.accessRole).toBe(accessRole);
      expect(result.current.roleFresh).toBe(true);
      expect(result.current.canEdit).toBe(false);
    }
  );

  it('treats an unknown fresh role as read-only', async () => {
    mocks.listCalendars.mockResolvedValue([
      { id: 'calendar-1', summary: 'Teaching', accessRole: 'unknownFutureRole' },
    ]);

    const { result } = renderHook(() =>
      useCalendarEditing({
        calendarId: 'calendar-1',
        persistedAccessRole: 'owner',
        hasCalendarWrite: true,
        authorizationLoading: false,
        loadCalendars: mocks.listCalendars,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('calendarReadOnly'));
    expect(result.current.canEdit).toBe(false);
  });

  it.each(['rateLimited', 'network', 'server'] as const)(
    'keeps the last fresh capability across a transient %s CalendarList failure',
    async (code) => {
      mocks.listCalendars
        .mockResolvedValueOnce([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'writer' }])
        .mockRejectedValueOnce({ code, message: 'Temporary Calendar failure' });

      const { result } = renderHook(() =>
        useCalendarEditing({
          calendarId: 'calendar-1',
          persistedAccessRole: 'reader',
          hasCalendarWrite: true,
          authorizationLoading: false,
          loadCalendars: mocks.listCalendars,
        })
      );

      await waitFor(() => expect(result.current.status).toBe('enabled'));

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.status).toBe('retryable');
      expect(result.current.canEdit).toBe(true);
      expect(result.current.accessRole).toBe('writer');
      expect(result.current.error).toBe('Temporary Calendar failure');
    }
  );

  it.each(['permissionDenied', 'unauthorized'] as const)(
    'disables editing after confirmed %s permission loss',
    async (code) => {
      mocks.listCalendars
        .mockResolvedValueOnce([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'writer' }])
        .mockRejectedValueOnce({ code, message: 'Calendar permission was lost' });

      const { result } = renderHook(() =>
        useCalendarEditing({
          calendarId: 'calendar-1',
          persistedAccessRole: 'writer',
          hasCalendarWrite: true,
          authorizationLoading: false,
          loadCalendars: mocks.listCalendars,
        })
      );

      await waitFor(() => expect(result.current.status).toBe('enabled'));
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.status).toBe('scopeMissing');
      expect(result.current.canEdit).toBe(false);
      expect(result.current.accessRole).toBeUndefined();
      expect(result.current.roleFresh).toBe(false);
      expect(result.current.error).toBe('Calendar permission was lost');
    }
  );

  it('disables editing after a fresh role loss and after a confirmed scope loss', async () => {
    mocks.listCalendars
      .mockResolvedValueOnce([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' }])
      .mockResolvedValueOnce([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'reader' }]);

    const props = {
      calendarId: 'calendar-1',
      persistedAccessRole: 'owner' as const,
      hasCalendarWrite: true,
      authorizationLoading: false,
      loadCalendars: mocks.listCalendars,
    };
    const { result, rerender } = renderHook(
      ({ hasCalendarWrite }) => useCalendarEditing({ ...props, hasCalendarWrite }),
      { initialProps: { hasCalendarWrite: true } }
    );

    await waitFor(() => expect(result.current.status).toBe('enabled'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toBe('calendarReadOnly');
    expect(result.current.canEdit).toBe(false);

    rerender({ hasCalendarWrite: false });
    expect(result.current.status).toBe('scopeMissing');
    expect(result.current.canEdit).toBe(false);
  });

  it('ignores an older owner response after a newer reader response', async () => {
    const older = deferred<Array<{ id: string; summary: string; accessRole: 'owner' }>>();
    const newer = deferred<Array<{ id: string; summary: string; accessRole: 'reader' }>>();
    mocks.listCalendars.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const { result } = renderHook(() =>
      useCalendarEditing({
        calendarId: 'calendar-1',
        persistedAccessRole: 'owner',
        hasCalendarWrite: true,
        authorizationLoading: false,
        loadCalendars: mocks.listCalendars,
      })
    );
    await waitFor(() => expect(mocks.listCalendars).toHaveBeenCalledTimes(1));

    let newerRefresh!: Promise<void>;
    act(() => {
      newerRefresh = result.current.refresh();
    });
    await waitFor(() => expect(mocks.listCalendars).toHaveBeenCalledTimes(2));

    await act(async () => {
      newer.resolve([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'reader' }]);
      await newerRefresh;
    });
    expect(result.current.status).toBe('calendarReadOnly');
    expect(result.current.accessRole).toBe('reader');

    await act(async () => {
      older.resolve([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' }]);
      await older.promise;
    });
    expect(result.current.status).toBe('calendarReadOnly');
    expect(result.current.accessRole).toBe('reader');
    expect(result.current.refreshing).toBe(false);
  });

  it('ignores an older error after a newer successful refresh', async () => {
    const older = deferred<never>();
    const newer = deferred<Array<{ id: string; summary: string; accessRole: 'writer' }>>();
    mocks.listCalendars.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const { result } = renderHook(() =>
      useCalendarEditing({
        calendarId: 'calendar-1',
        persistedAccessRole: 'reader',
        hasCalendarWrite: true,
        authorizationLoading: false,
        loadCalendars: mocks.listCalendars,
      })
    );
    await waitFor(() => expect(mocks.listCalendars).toHaveBeenCalledTimes(1));

    let newerRefresh!: Promise<void>;
    act(() => {
      newerRefresh = result.current.refresh();
    });
    await waitFor(() => expect(mocks.listCalendars).toHaveBeenCalledTimes(2));

    await act(async () => {
      newer.resolve([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'writer' }]);
      await newerRefresh;
    });
    expect(result.current.status).toBe('enabled');

    await act(async () => {
      older.reject({ code: 'rateLimited', message: 'Stale quota error' });
      await older.promise.catch(() => undefined);
    });
    expect(result.current.status).toBe('enabled');
    expect(result.current.accessRole).toBe('writer');
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
  });

  it('preflights, applies, and reloads one occurrence studio change', async () => {
    mocks.listCalendars.mockResolvedValue([
      { id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' },
    ]);
    const lesson = parsedClass({
      studioName: 'Old Studio',
      sourceSummary: 'Old Studio / Flow',
      eventIdentity: {
        calendarId: 'calendar-1',
        eventId: 'event-1',
        etag: 'etag-1',
      },
    });
    const preflight = {
      identity: lesson.eventIdentity,
      currentSummary: 'Old Studio / Flow',
      proposedSummary: 'New Studio / Flow',
    };
    const preflightOccurrenceStudioEdit = vi.fn(async () => preflight);
    const applyOccurrenceStudioEdit = vi.fn(async () => ({
      identity: { ...lesson.eventIdentity, etag: 'etag-2' },
      summary: 'New Studio / Flow',
      description: '5',
      start: '2026-08-16T09:00:00+02:00',
      end: '2026-08-16T10:00:00+02:00',
      status: 'confirmed',
    }));
    const reloadCache = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useCalendarEditing({
        calendarId: 'calendar-1',
        persistedAccessRole: 'owner',
        hasCalendarWrite: true,
        authorizationLoading: false,
        loadCalendars: mocks.listCalendars,
        preflightOccurrenceStudioEdit,
        applyOccurrenceStudioEdit,
        reloadCache,
      })
    );
    await waitFor(() => expect(result.current.canEdit).toBe(true));

    await act(async () => {
      await result.current.reassignOccurrenceStudio(lesson, 'New Studio');
    });

    expect(preflightOccurrenceStudioEdit).toHaveBeenCalledWith({
      identity: lesson.eventIdentity,
      studioName: 'New Studio',
    });
    expect(applyOccurrenceStudioEdit).toHaveBeenCalledWith(preflight);
    expect(reloadCache).toHaveBeenCalledOnce();
    expect(result.current.saveError).toBeNull();
  });

  it('prepares and saves one occurrence value change before reloading the cache', async () => {
    mocks.listCalendars.mockResolvedValue([
      { id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' },
    ]);
    const lesson = parsedClass({
      studentCount: 5,
      sourceDescription: '5/30EUR',
      eventIdentity: {
        calendarId: 'calendar-1',
        eventId: 'event-1',
        etag: 'etag-1',
      },
    });
    const preflight = {
      identity: lesson.eventIdentity,
      currentDescription: '5/30EUR',
      proposedDescription: '12/30EUR',
      requiresConfirmation: false,
    };
    const preflightOccurrenceValueEdit = vi.fn(async () => preflight);
    const applyOccurrenceValueEdit = vi.fn(async () => ({
      identity: { ...lesson.eventIdentity, etag: 'etag-2' },
      summary: lesson.sourceSummary,
      description: '12/30EUR',
      start: '2026-08-16T09:00:00+02:00',
      end: '2026-08-16T10:00:00+02:00',
      status: 'confirmed',
    }));
    const reloadCache = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useCalendarEditing({
        calendarId: 'calendar-1',
        persistedAccessRole: 'owner',
        hasCalendarWrite: true,
        authorizationLoading: false,
        loadCalendars: mocks.listCalendars,
        preflightOccurrenceValueEdit,
        applyOccurrenceValueEdit,
        reloadCache,
      })
    );
    await waitFor(() => expect(result.current.canEdit).toBe(true));

    let prepared: typeof preflight | undefined;
    await act(async () => {
      prepared = await result.current.prepareOccurrenceValueEdit(lesson, {
        operation: 'setStudents',
        studentCount: 12,
      });
    });
    expect(preflightOccurrenceValueEdit).toHaveBeenCalledWith({
      identity: lesson.eventIdentity,
      operation: 'setStudents',
      studentCount: 12,
    });

    await act(async () => {
      await result.current.saveOccurrenceValueEdit(prepared!, false);
    });
    expect(applyOccurrenceValueEdit).toHaveBeenCalledWith(preflight, false);
    expect(reloadCache).toHaveBeenCalledOnce();
  });

  it('reloads the Calendar cache when an apply reports a post-save reconciliation failure', async () => {
    mocks.listCalendars.mockResolvedValue([
      { id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' },
    ]);
    const lesson = parsedClass({
      studioName: 'Old Studio',
      eventIdentity: { calendarId: 'calendar-1', eventId: 'event-1', etag: 'etag-1' },
    });
    const preflight = {
      identity: lesson.eventIdentity,
      currentSummary: 'Old Studio / Flow',
      proposedSummary: 'New Studio / Flow',
    };
    const failure = new Error(
      'Google Calendar was updated, but invoice status could not be updated.'
    );
    const reloadCache = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useCalendarEditing({
        calendarId: 'calendar-1',
        persistedAccessRole: 'owner',
        hasCalendarWrite: true,
        authorizationLoading: false,
        loadCalendars: mocks.listCalendars,
        preflightOccurrenceStudioEdit: vi.fn(async () => preflight),
        applyOccurrenceStudioEdit: vi.fn(async () => {
          throw failure;
        }),
        reloadCache,
      })
    );
    await waitFor(() => expect(result.current.canEdit).toBe(true));

    await act(async () => {
      await expect(result.current.reassignOccurrenceStudio(lesson, 'New Studio')).rejects.toBe(
        failure
      );
    });

    expect(reloadCache).toHaveBeenCalledOnce();
    expect(result.current.saveError).toBe(failure.message);
  });

  it('preflights, applies, and reloads an entire recurring series', async () => {
    mocks.listCalendars.mockResolvedValue([
      { id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' },
    ]);
    const lesson = parsedClass({
      eventIdentity: {
        calendarId: 'calendar-1',
        eventId: 'instance-1',
        recurringEventId: 'master-1',
        etag: 'instance-etag',
      },
    });
    const preflight = {
      calendarId: 'calendar-1',
      selectedEventId: 'instance-1',
      masterEventId: 'master-1',
      masterEtag: 'master-etag',
      currentSummary: 'Studio / Flow',
      proposedSummary: 'New Studio / Flow',
      instanceCount: 2,
      titleExceptionCount: 1,
    };
    const preflightSeriesStudioEdit = vi.fn(async () => preflight);
    const applySeriesStudioEdit = vi.fn(async () => ({
      applied: {
        calendarId: 'calendar-1',
        masterEventId: 'master-1',
        proposedSummary: 'New Studio / Flow',
      },
      reconciliationPending: false,
    }));
    const reloadCache = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useCalendarEditing({
        calendarId: 'calendar-1',
        persistedAccessRole: 'owner',
        hasCalendarWrite: true,
        authorizationLoading: false,
        loadCalendars: mocks.listCalendars,
        preflightSeriesStudioEdit,
        applySeriesStudioEdit,
        reloadCache,
      })
    );
    await waitFor(() => expect(result.current.canEdit).toBe(true));

    let prepared: typeof preflight | undefined;
    await act(async () => {
      prepared = await result.current.prepareSeriesStudioEdit(lesson, 'New Studio');
    });
    await act(async () => {
      expect(await result.current.saveSeriesStudioEdit(prepared!)).toBe(false);
    });

    expect(preflightSeriesStudioEdit).toHaveBeenCalledWith({
      selectedIdentity: lesson.eventIdentity,
      studioName: 'New Studio',
    });
    expect(applySeriesStudioEdit).toHaveBeenCalledWith(preflight);
    expect(reloadCache).toHaveBeenCalledOnce();
  });

  it('ignores calendar A while calendar B is the current pending request', async () => {
    const calendarA = deferred<Array<{ id: string; summary: string; accessRole: 'owner' }>>();
    const calendarB = deferred<Array<{ id: string; summary: string; accessRole: 'reader' }>>();
    mocks.listCalendars
      .mockReturnValueOnce(calendarA.promise)
      .mockReturnValueOnce(calendarB.promise);

    const { result, rerender } = renderHook(
      ({ calendarId, persistedAccessRole }) =>
        useCalendarEditing({
          calendarId,
          persistedAccessRole,
          hasCalendarWrite: true,
          authorizationLoading: false,
          loadCalendars: mocks.listCalendars,
        }),
      {
        initialProps: {
          calendarId: 'calendar-a',
          persistedAccessRole: 'owner' as const,
        },
      }
    );
    await waitFor(() => expect(mocks.listCalendars).toHaveBeenCalledTimes(1));

    rerender({ calendarId: 'calendar-b', persistedAccessRole: 'reader' });
    await waitFor(() => expect(mocks.listCalendars).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('roleStale');
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      calendarA.resolve([{ id: 'calendar-a', summary: 'A', accessRole: 'owner' }]);
      await calendarA.promise;
    });
    expect(result.current.status).toBe('roleStale');
    expect(result.current.accessRole).toBe('reader');
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      calendarB.resolve([{ id: 'calendar-b', summary: 'B', accessRole: 'reader' }]);
      await calendarB.promise;
    });
    expect(result.current.status).toBe('calendarReadOnly');
    expect(result.current.accessRole).toBe('reader');
    expect(result.current.roleFresh).toBe(true);
    expect(result.current.refreshing).toBe(false);
  });

  it('invalidates an in-flight role request and clears loading after scope loss', async () => {
    const pending = deferred<Array<{ id: string; summary: string; accessRole: 'owner' }>>();
    mocks.listCalendars.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ hasCalendarWrite }) =>
        useCalendarEditing({
          calendarId: 'calendar-1',
          persistedAccessRole: 'owner',
          hasCalendarWrite,
          authorizationLoading: false,
          loadCalendars: mocks.listCalendars,
        }),
      { initialProps: { hasCalendarWrite: true } }
    );
    await waitFor(() => expect(result.current.refreshing).toBe(true));

    rerender({ hasCalendarWrite: false });
    expect(result.current.status).toBe('scopeMissing');
    expect(result.current.canEdit).toBe(false);
    expect(result.current.refreshing).toBe(false);

    await act(async () => {
      pending.resolve([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' }]);
      await pending.promise;
    });
    expect(result.current.status).toBe('scopeMissing');
    expect(result.current.canEdit).toBe(false);
    expect(result.current.refreshing).toBe(false);
  });

  it('requires a fresh role after scope loss and re-grant', async () => {
    const revalidation = deferred<Array<{ id: string; summary: string; accessRole: 'owner' }>>();
    mocks.listCalendars
      .mockResolvedValueOnce([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' }])
      .mockReturnValueOnce(revalidation.promise);
    const { result, rerender } = renderHook(
      ({ hasCalendarWrite }) =>
        useCalendarEditing({
          calendarId: 'calendar-1',
          persistedAccessRole: 'owner',
          hasCalendarWrite,
          authorizationLoading: false,
          loadCalendars: mocks.listCalendars,
        }),
      { initialProps: { hasCalendarWrite: true } }
    );
    await waitFor(() => expect(result.current.status).toBe('enabled'));

    rerender({ hasCalendarWrite: false });
    expect(result.current.status).toBe('scopeMissing');
    expect(result.current.roleFresh).toBe(false);
    expect(result.current.canEdit).toBe(false);

    rerender({ hasCalendarWrite: true });
    expect(result.current.status).toBe('roleStale');
    expect(result.current.roleFresh).toBe(false);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.canEdit).toBe(false);

    await act(async () => {
      revalidation.resolve([{ id: 'calendar-1', summary: 'Teaching', accessRole: 'owner' }]);
      await revalidation.promise;
    });
    expect(result.current.status).toBe('enabled');
    expect(result.current.roleFresh).toBe(true);
    expect(result.current.canEdit).toBe(true);
  });
});

describe('useGoogleAuthorization', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.getAccessToken.mockReset();
    mocks.loadPreference.mockReset();
    mocks.savePreference.mockReset();
    mocks.loadPreference.mockResolvedValue(null);
    mocks.savePreference.mockResolvedValue(undefined);
  });

  it('opens immediately for an existing base-only grant and persists only current-version dismissal', async () => {
    mocks.invoke.mockResolvedValue(authorizationRecord(BASE_OAUTH_SCOPES));

    const { result } = renderHook(() => useGoogleAuthorization(authorizationDependencies));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasCalendarWrite).toBe(false);
    expect(result.current.promptOpen).toBe(true);

    await act(async () => {
      await result.current.dismissCalendarEditingPrompt();
    });

    expect(mocks.savePreference).toHaveBeenCalledWith({
      dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    });
    expect(mocks.invoke).toHaveBeenCalledWith('read_auth_tokens');
    expect(mocks.invoke).not.toHaveBeenCalledWith('write_auth_tokens', expect.anything());
    expect(result.current.promptOpen).toBe(false);

    act(() => result.current.openCalendarEditingPrompt());
    expect(result.current.promptOpen).toBe(true);
  });

  it('suppresses the prompt after a WebView reload for the same authorization version', async () => {
    mocks.invoke.mockResolvedValue(authorizationRecord(BASE_OAUTH_SCOPES));
    mocks.loadPreference.mockResolvedValue({
      dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    });

    const { result } = renderHook(() => useGoogleAuthorization(authorizationDependencies));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.promptOpen).toBe(false);
    expect(result.current.hasCalendarWrite).toBe(false);
  });

  it('starts the write-scope upgrade and enables scope only after it succeeds', async () => {
    mocks.invoke.mockResolvedValue(authorizationRecord(BASE_OAUTH_SCOPES));
    mocks.getAccessToken.mockResolvedValue('upgraded-access-token');

    const { result } = renderHook(() => useGoogleAuthorization(authorizationDependencies));
    await waitFor(() => expect(result.current.promptOpen).toBe(true));

    await act(async () => {
      await result.current.allowCalendarEditing();
    });

    expect(mocks.getAccessToken).toHaveBeenCalledWith({
      requireCalendarWrite: true,
      interactive: true,
    });
    expect(result.current.hasCalendarWrite).toBe(true);
    expect(result.current.promptOpen).toBe(false);
    expect(mocks.savePreference).not.toHaveBeenCalled();
  });

  it.each([
    'Calendar authorization was denied',
    'Calendar authorization timed out or the browser was closed',
  ])(
    'keeps the app read-only and dismisses this version when upgrade fails: %s',
    async (message) => {
      mocks.invoke.mockResolvedValue(authorizationRecord(BASE_OAUTH_SCOPES));
      mocks.getAccessToken.mockRejectedValue(new Error(message));

      const { result } = renderHook(() => useGoogleAuthorization(authorizationDependencies));
      await waitFor(() => expect(result.current.promptOpen).toBe(true));

      await act(async () => {
        await result.current.allowCalendarEditing();
      });

      expect(result.current.hasCalendarWrite).toBe(false);
      expect(result.current.promptOpen).toBe(false);
      expect(result.current.error).toBe(message);
      expect(mocks.savePreference).toHaveBeenCalledWith({
        dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      });
    }
  );

  it.each([
    'Authorization response did not include all required scopes and tokens',
    'Token exchange failed (400): invalid_grant',
    'Authorization record changed before it could be saved',
  ])('keeps a retryable authorization failure visible: %s', async (message) => {
    mocks.invoke.mockResolvedValue(authorizationRecord(BASE_OAUTH_SCOPES));
    mocks.getAccessToken
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce('upgraded-access-token');

    const { result } = renderHook(() => useGoogleAuthorization(authorizationDependencies));
    await waitFor(() => expect(result.current.promptOpen).toBe(true));

    await act(async () => {
      await result.current.allowCalendarEditing();
    });

    expect(result.current.hasCalendarWrite).toBe(false);
    expect(result.current.promptOpen).toBe(true);
    expect(result.current.error).toBe(message);
    expect(mocks.savePreference).not.toHaveBeenCalled();

    act(() => result.current.openCalendarEditingPrompt());
    expect(result.current.error).toBe(message);

    await act(async () => {
      await result.current.allowCalendarEditing();
    });
    expect(mocks.getAccessToken).toHaveBeenCalledTimes(2);
    expect(result.current.hasCalendarWrite).toBe(true);
    expect(result.current.promptOpen).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it.each(['close', 'Escape'])(
    'keeps an in-flight upgrade dismissed after %s when it later fails recoverably',
    async () => {
      const pendingUpgrade = deferred<string>();
      const message = 'Authorization response did not include all required scopes and tokens';
      mocks.invoke.mockResolvedValue(authorizationRecord(BASE_OAUTH_SCOPES));
      mocks.getAccessToken.mockReturnValue(pendingUpgrade.promise);

      const { result } = renderHook(() => useGoogleAuthorization(authorizationDependencies));
      await waitFor(() => expect(result.current.promptOpen).toBe(true));

      let upgrade!: Promise<void>;
      act(() => {
        upgrade = result.current.allowCalendarEditing();
      });
      await waitFor(() => expect(result.current.isAuthorizing).toBe(true));

      await act(async () => {
        await result.current.dismissCalendarEditingPrompt();
      });
      expect(result.current.promptOpen).toBe(false);
      expect(mocks.savePreference).toHaveBeenCalledWith({
        dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
      });

      await act(async () => {
        pendingUpgrade.reject(new Error(message));
        await upgrade;
      });
      expect(result.current.isAuthorizing).toBe(false);
      expect(result.current.promptOpen).toBe(false);
      expect(result.current.error).toBe(message);

      act(() => result.current.openCalendarEditingPrompt());
      expect(result.current.promptOpen).toBe(true);
      expect(result.current.error).toBe(message);
    }
  );

  it('recognizes a complete current-version write grant without prompting', async () => {
    mocks.invoke.mockResolvedValue(authorizationRecord(CALENDAR_EDIT_OAUTH_SCOPES));

    const { result } = renderHook(() => useGoogleAuthorization(authorizationDependencies));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasCalendarWrite).toBe(true);
    expect(result.current.promptOpen).toBe(false);
  });
});

afterEach(() => cleanup());
afterAll(() => restoreDom());
