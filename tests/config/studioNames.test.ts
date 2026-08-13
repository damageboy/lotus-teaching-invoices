import { describe, expect, it } from 'vitest';
import { renameStudio } from '../../src/lib/config/studioNames.js';
import { StudioConfig } from '../../src/lib/types.js';

const studio: StudioConfig = {
  fullName: 'Studio',
  address: '',
  invoiceEmail: '',
  rateTiers: [{ minStudents: 1, maxStudents: null, rate: 50 }],
};

describe('renameStudio', () => {
  it('trims leading and trailing whitespace', () => {
    const result = renameStudio({ Studio: studio }, 'Studio', '  New Studio  ');

    expect(result).toEqual({
      ok: true,
      name: 'New Studio',
      studios: { 'New Studio': studio },
      changed: true,
    });
  });

  it('preserves internal whitespace', () => {
    const result = renameStudio({ Studio: studio }, 'Studio', ' New  Studio ');

    expect(result.ok && result.name).toBe('New  Studio');
  });

  it('treats the normalized current name as a successful no-op', () => {
    const studios = { Studio: studio };
    const result = renameStudio(studios, 'Studio', '  Studio  ');

    expect(result).toEqual({
      ok: true,
      name: 'Studio',
      studios,
      changed: false,
    });
    expect(result.ok && result.studios).toBe(studios);
  });

  it('rejects a name that is empty after trimming', () => {
    const result = renameStudio({ Studio: studio }, 'Studio', '   ');

    expect(result).toEqual({ ok: false, error: 'Studio name cannot be empty.' });
    expect('studios' in result).toBe(false);
  });

  it('rejects a duplicate normalized name', () => {
    const result = renameStudio({ Studio: studio, Other: studio }, 'Studio', ' Other ');

    expect(result).toEqual({
      ok: false,
      error: 'A studio named "Other" already exists.',
    });
    expect('studios' in result).toBe(false);
  });
});
