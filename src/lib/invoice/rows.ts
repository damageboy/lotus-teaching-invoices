import type { InvoiceFreshnessRow } from './freshness.js';
import type { ParsedClass } from '../types.js';

export interface InvoiceRow {
  studioName: string;
  monthKey: string;
  label: string;
  classCount: number;
  classes: ParsedClass[];
  freshness: InvoiceFreshnessRow | null;
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

function rowKey(studioName: string, monthKey: string): string {
  return JSON.stringify([studioName, monthKey]);
}

function labelForMonth(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

export function buildInvoiceRows(
  classes: ParsedClass[],
  activeFreshness: InvoiceFreshnessRow[]
): InvoiceRow[] {
  const rows = new Map<string, InvoiceRow>();
  for (const lesson of classes) {
    const monthKey = lesson.date.slice(0, 7);
    const key = rowKey(lesson.studioName, monthKey);
    const current = rows.get(key);
    if (current) {
      current.classes.push(lesson);
      current.classCount += 1;
    } else {
      rows.set(key, {
        studioName: lesson.studioName,
        monthKey,
        label: labelForMonth(monthKey),
        classCount: 1,
        classes: [lesson],
        freshness: null,
      });
    }
  }

  for (const freshness of activeFreshness) {
    const { studioName, monthKey } = freshness.key;
    const key = rowKey(studioName, monthKey);
    const current = rows.get(key);
    if (current) current.freshness = freshness;
    else {
      rows.set(key, {
        studioName,
        monthKey,
        label: labelForMonth(monthKey),
        classCount: 0,
        classes: [],
        freshness,
      });
    }
  }

  return [...rows.values()].sort(
    (left, right) =>
      right.monthKey.localeCompare(left.monthKey) || left.studioName.localeCompare(right.studioName)
  );
}
