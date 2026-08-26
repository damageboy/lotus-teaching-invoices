import { describe, expect, it } from 'vitest';
import {
  calendarHistoryLevel,
  calendarHistoryState,
  createMobileCalendarOwnerId,
} from '../../src/components/CalendarTab/mobile-calendar-history.js';

describe('mobile Calendar history ownership', () => {
  it('creates a unique owner ID for each navigation owner', () => {
    const first = createMobileCalendarOwnerId();
    const second = createMobileCalendarOwnerId();

    expect(first).not.toBe(second);
  });

  it('tags agenda history while preserving foreign object keys without mutation', () => {
    const ownerId = createMobileCalendarOwnerId();
    const currentState = { foreign: true, destination: { tab: 'calendar' } };
    const originalState = structuredClone(currentState);

    const state = calendarHistoryState(currentState, ownerId, 'agenda');

    expect(state).toEqual({
      foreign: true,
      destination: { tab: 'calendar' },
      lotusCalendar: { ownerId, level: 'agenda' },
    });
    expect(state).not.toBe(currentState);
    expect(currentState).toEqual(originalState);
    expect(calendarHistoryLevel(state, ownerId)).toBe('agenda');
  });

  it('tags and reads details history for only the current owner', () => {
    const currentOwnerId = createMobileCalendarOwnerId();
    const oldOwnerId = createMobileCalendarOwnerId();
    const state = calendarHistoryState({}, oldOwnerId, 'details');

    expect(state).toEqual({
      lotusCalendar: { ownerId: oldOwnerId, level: 'details' },
    });
    expect(calendarHistoryLevel(state, oldOwnerId)).toBe('details');
    expect(calendarHistoryLevel(state, currentOwnerId)).toBeNull();
  });

  it.each([
    ['null', null],
    ['array', [{ lotusCalendar: { ownerId: 'owner', level: 'agenda' } }]],
    ['string', 'agenda'],
    ['number', 1],
    ['missing tag', { foreign: true }],
    ['null tag', { lotusCalendar: null }],
    ['array tag', { lotusCalendar: ['owner', 'agenda'] }],
    ['missing owner', { lotusCalendar: { level: 'agenda' } }],
    ['wrong owner type', { lotusCalendar: { ownerId: 7, level: 'agenda' } }],
    ['missing level', { lotusCalendar: { ownerId: 'owner' } }],
    ['unknown level', { lotusCalendar: { ownerId: 'owner', level: 'month' } }],
  ])('rejects malformed %s history state', (_label, state) => {
    expect(calendarHistoryLevel(state, 'owner')).toBeNull();
  });

  it.each([null, ['foreign'], 'foreign', 1, true])(
    'tags non-object history state without copying it: %j',
    (currentState) => {
      const ownerId = createMobileCalendarOwnerId();

      expect(calendarHistoryState(currentState, ownerId, 'agenda')).toEqual({
        lotusCalendar: { ownerId, level: 'agenda' },
      });
    }
  );
});
