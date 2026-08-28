import type { CurrentInvoiceSource, DriveInvoiceEntry } from '../drive/invoiceCatalog.js';
import type { InvoiceKey } from '../drive/types.js';
import type { AppConfig, ParsedClass } from '../types.js';
import { studioSlug } from './finalization.js';
import { generateInvoice } from './generator.js';
import { buildInvoiceSource, fingerprintInvoiceSource } from './sourceFingerprint.js';

export interface InvoiceRow {
  key: InvoiceKey;
  studioName: string;
  monthKey: string;
  label: string;
  classCount: number;
  classes: ParsedClass[];
  driveEntries: DriveInvoiceEntry[];
  studioConfigReason: string | null;
}

export interface StudioSlugResolution {
  studioName: string | null;
  reason: string | null;
}

export interface CurrentInvoiceSourceBuild {
  inputKey: string | null;
  sources: CurrentInvoiceSource[];
  issues: CurrentInvoiceSourceIssue[];
  error: string | null;
}

export interface CurrentInvoiceSourceIssue {
  key: InvoiceKey;
  studioName: string;
  reason: string;
}

export interface CurrentInvoiceSourceResult {
  sources: CurrentInvoiceSource[];
  issues: CurrentInvoiceSourceIssue[];
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function currentInvoiceClasses(classes: readonly ParsedClass[]): ParsedClass[] {
  const throughMonth = currentMonthKey();
  return classes.filter((lesson) => lesson.date.slice(0, 7) <= throughMonth);
}

export function currentInvoiceSourceInputKey(
  classes: readonly ParsedClass[],
  config: AppConfig
): string {
  const { invoiceSequenceByYear: _invoiceSequenceByYear, ...sourceConfig } = config;
  return JSON.stringify([currentInvoiceClasses(classes), sourceConfig]);
}

export function visibleCurrentInvoiceSourceBuild(
  currentInputKey: string,
  build: CurrentInvoiceSourceBuild
): {
  sources: CurrentInvoiceSource[];
  issues: CurrentInvoiceSourceIssue[];
  ready: boolean;
  error: string | null;
} {
  if (build.inputKey !== currentInputKey) {
    return { sources: [], issues: [], ready: false, error: null };
  }
  if (build.error !== null) {
    return { sources: [], issues: [], ready: false, error: build.error };
  }
  return { sources: build.sources, issues: build.issues, ready: true, error: null };
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function rowKey(key: InvoiceKey): string {
  return JSON.stringify([key.studioSlug, key.monthKey]);
}

function labelForMonth(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

export function resolveConfiguredStudio(
  studioSlugKey: string,
  config: AppConfig
): StudioSlugResolution {
  const matches = Object.keys(config.studios)
    .filter((studioName) => studioSlug(studioName) === studioSlugKey)
    .sort();
  if (matches.length === 1) return { studioName: matches[0], reason: null };
  if (matches.length === 0) {
    return {
      studioName: null,
      reason: `No configured studio matches Drive slug "${studioSlugKey}".`,
    };
  }
  return {
    studioName: null,
    reason: `Drive slug "${studioSlugKey}" matches multiple configured studios: ${matches
      .map((name) => `"${name}"`)
      .join(', ')}.`,
  };
}

export function buildInvoiceRows(
  classes: ParsedClass[],
  driveEntries: readonly DriveInvoiceEntry[],
  config?: AppConfig
): InvoiceRow[] {
  const rows = new Map<string, InvoiceRow>();
  for (const lesson of classes) {
    const key = { studioSlug: studioSlug(lesson.studioName), monthKey: lesson.date.slice(0, 7) };
    const serialized = rowKey(key);
    const current = rows.get(serialized);
    if (current) {
      current.classes.push(lesson);
      current.classCount += 1;
    } else {
      rows.set(serialized, {
        key,
        studioName: lesson.studioName,
        monthKey: key.monthKey,
        label: labelForMonth(key.monthKey),
        classCount: 1,
        classes: [lesson],
        driveEntries: [],
        studioConfigReason:
          config === undefined ? null : resolveConfiguredStudio(key.studioSlug, config).reason,
      });
    }
  }

  for (const driveEntry of driveEntries) {
    if (driveEntry.key === null) continue;
    const serialized = rowKey(driveEntry.key);
    const current = rows.get(serialized);
    if (current) {
      current.driveEntries.push(driveEntry);
    } else {
      const resolution =
        config === undefined
          ? { studioName: null, reason: null }
          : resolveConfiguredStudio(driveEntry.key.studioSlug, config);
      rows.set(serialized, {
        key: { ...driveEntry.key },
        studioName: resolution.studioName ?? driveEntry.key.studioSlug,
        monthKey: driveEntry.key.monthKey,
        label: labelForMonth(driveEntry.key.monthKey),
        classCount: 0,
        classes: [],
        driveEntries: [driveEntry],
        studioConfigReason: resolution.reason,
      });
    }
  }

  return [...rows.values()].sort(
    (left, right) =>
      right.monthKey.localeCompare(left.monthKey) || left.studioName.localeCompare(right.studioName)
  );
}

/** Build current business inputs before Drive supplies each authoritative invoice number. */
export async function buildCurrentInvoiceSources(
  classes: ParsedClass[],
  config: AppConfig
): Promise<CurrentInvoiceSourceResult> {
  const relevantClasses = currentInvoiceClasses(classes);
  if (relevantClasses.length === 0) return { sources: [], issues: [] };
  if (config.calendarId === undefined || config.calendarId.trim().length === 0) {
    throw new Error('Current invoice sources are blocked: Calendar configuration is unavailable.');
  }
  const calendarId = config.calendarId;
  const rows = buildInvoiceRows(relevantClasses, [], config);
  const issues: CurrentInvoiceSourceIssue[] = [];
  const reportIssue = (row: InvoiceRow, reason: string): null => {
    issues.push({ key: { ...row.key }, studioName: row.studioName, reason });
    return null;
  };
  const pending = rows.map(async (row): Promise<CurrentInvoiceSource | null> => {
    const currentNames = [...new Set(row.classes.map((lesson) => lesson.studioName))];
    const studio = config.studios[row.studioName];
    if (currentNames.length !== 1) {
      return reportIssue(row, 'Multiple Calendar studio names share one Drive slug.');
    }
    if (studio === undefined) {
      return reportIssue(row, 'Studio configuration is unavailable.');
    }
    if (row.studioConfigReason !== null) {
      const reason = row.studioConfigReason
        .replace(/^Drive /, 'studio ')
        .replace('configured studios', 'configurations');
      return reportIssue(row, `${reason[0].toUpperCase()}${reason.slice(1)}`);
    }
    if (row.classes.some((lesson) => lesson.eventIdentity.calendarId !== config.calendarId)) {
      return reportIssue(row, 'Calendar identity does not match the selected calendar.');
    }
    try {
      const generated = generateInvoice(row.studioName, row.classes, studio, {
        from: `${row.monthKey}-01`,
        to: `${row.monthKey}-${String(
          new Date(Number(row.monthKey.slice(0, 4)), Number(row.monthKey.slice(5, 7)), 0).getDate()
        ).padStart(2, '0')}`,
      });
      if (generated.warnings.length > 0 || generated.invoice.totalClasses !== row.classes.length) {
        return reportIssue(row, 'Invoice input contains unbillable classes.');
      }
      const invoice = generated.invoice;
      // This fingerprint only invalidates controller requests when business input changes.
      // Catalog freshness is recomputed with the real number parsed from each Drive entry.
      const semantic = buildInvoiceSource({
        config,
        classes: row.classes,
        invoice,
        calendarId,
        invoiceNumber: '',
      });
      return {
        key: { ...row.key },
        studioName: row.studioName,
        invoice,
        classes: [...row.classes],
        config,
        fingerprint: await fingerprintInvoiceSource(semantic),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reportIssue(row, /[.!?]$/.test(message) ? message : `${message}.`);
    }
  });
  const resolved = await Promise.all(pending);
  return {
    sources: resolved.filter((source): source is CurrentInvoiceSource => source !== null),
    issues,
  };
}
