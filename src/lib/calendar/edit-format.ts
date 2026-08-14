export interface StudentDescription {
  studentCount: number | null;
  rateOverride?: number;
  ambiguous: boolean;
  safeToReplace: boolean;
}

export interface DescriptionProposal {
  current: string;
  proposed: string;
  requiresConfirmation: boolean;
}

const completeDescription = /^\s*(\d+)\s*(?:\/\s*(\d+(?:\.\d+)?)\s*EUR)?\s*$/i;
const euroInput = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export function parseStudentDescription(raw: string | undefined): StudentDescription {
  if (!raw) return { studentCount: null, ambiguous: false, safeToReplace: false };

  const complete = raw.match(completeDescription);
  if (complete) {
    return {
      studentCount: parseInt(complete[1], 10),
      ...(complete[2] === undefined ? {} : { rateOverride: parseFloat(complete[2]) }),
      ambiguous: false,
      safeToReplace: true,
    };
  }

  const matches = [...raw.matchAll(/(\d+)/g)];
  if (matches.length === 0) return { studentCount: null, ambiguous: false, safeToReplace: false };
  if (matches.length === 1) {
    return {
      studentCount: parseInt(matches[0][1], 10),
      ambiguous: false,
      safeToReplace: false,
    };
  }
  return { studentCount: null, ambiguous: true, safeToReplace: false };
}

export function rewriteStudioSummary(
  summary: string,
  studioName: string
): { ok: true; value: string; changed: boolean } | { ok: false; reason: 'unsupportedStructure' } {
  const parts = summary.split('/');
  const normalizedStudioName = studioName.trim();
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => !part.trim()) ||
    !normalizedStudioName ||
    normalizedStudioName.includes('/')
  ) {
    return { ok: false, reason: 'unsupportedStructure' };
  }

  const firstSlash = summary.indexOf('/');
  const separatorWhitespace = summary.slice(0, firstSlash).match(/\s*$/)?.[0] ?? '';
  const value = `${normalizedStudioName}${separatorWhitespace}${summary.slice(firstSlash)}`;
  return { ok: true, value, changed: value !== summary };
}

export function proposeStudentCount(current: string, students: unknown): DescriptionProposal {
  const studentCount = requireStudentCount(students);
  const complete = current.match(completeDescription);
  const proposed =
    complete?.[2] === undefined ? String(studentCount) : `${studentCount}/${complete[2]}EUR`;
  return proposal(current, proposed);
}

export function proposeEuroOverride(
  current: string,
  students: unknown,
  euros: unknown
): DescriptionProposal {
  const studentCount = requireStudentCount(students);
  return proposal(current, `${studentCount}/${serializeEuroOverride(euros)}EUR`);
}

export function proposeConfiguredRate(current: string, students: unknown): DescriptionProposal {
  return proposal(current, String(requireStudentCount(students)));
}

function proposal(current: string, proposed: string): DescriptionProposal {
  return {
    current,
    proposed,
    requiresConfirmation: !parseStudentDescription(current).safeToReplace,
  };
}

function requireStudentCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid student count');
  }
  return value;
}

function serializeEuroOverride(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Invalid euro override');
  }

  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !euroInput.test(raw)) {
    throw new Error('Invalid euro override');
  }

  const [whole, fraction = ''] = raw.split('.');
  const cents = BigInt(`${whole}${fraction.padEnd(2, '0')}`);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid euro override');
  }

  const canonicalFraction = fraction.replace(/0+$/, '');
  return canonicalFraction ? `${whole}.${canonicalFraction}` : whole;
}
