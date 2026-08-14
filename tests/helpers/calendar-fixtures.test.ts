import { describe, expect, it } from 'vitest';
import { calendarEvent, calendarIdentity, parsedClass } from './calendar-fixtures.js';

describe('calendar fixture builders', () => {
  it('uses deterministic inert identity defaults', () => {
    expect(calendarIdentity()).toEqual(calendarIdentity());
    expect(calendarEvent().identity).toEqual(calendarEvent().identity);
    expect(parsedClass().eventIdentity).toEqual(parsedClass().eventIdentity);
  });
});
