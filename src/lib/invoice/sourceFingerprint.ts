import type { AppConfig, Invoice, ParsedClass, RateTier } from '../types.js';
import type { InvoiceSourceFingerprint } from '../drive/types.js';
import { studioSlug } from './finalization.js';

export interface InvoiceSourceClass {
  eventIdentity: {
    calendarId: string;
    eventId: string;
    recurringEventId: string | null;
    originalStartTime: string | null;
    etag: string | null;
  };
  sourceSummary: string;
  sourceDescription: string;
  studioName: string;
  classType: string;
  location: string | null;
  date: string;
  startTime: string;
  endTime: string;
  studentCount: number;
  rateOverride: number | null;
  unconfigured: boolean;
  ambiguousStudentCount: boolean;
}

export interface InvoiceSourceLineItem {
  date: string;
  startTime: string;
  endTime: string;
  classType: string;
  location: string | null;
  studentCount: number;
  rateApplied: number;
  lineTotal: number;
}

export interface InvoiceSource {
  schema: 1;
  calendarId: string;
  studioSlug: string;
  invoiceNumber: string;
  period: {
    from: string;
    to: string;
  };
  classes: InvoiceSourceClass[];
  invoice: {
    studioName: string;
    lineItems: InvoiceSourceLineItem[];
    totalClasses: number;
    totalAmount: number;
  };
  teacher: {
    name: string;
    address: string;
    taxNumber: string;
    bankDetails: {
      accountOwner: string;
      iban: string;
      bic: string;
    };
  };
  studio: {
    name: string;
    fullName: string;
    address: string;
    invoiceEmail: string;
    rateTiers: RateTier[];
  };
}

export interface BuildInvoiceSourceInput {
  config: AppConfig;
  classes: readonly ParsedClass[];
  invoice: Invoice;
  calendarId: string;
  invoiceNumber: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical invoice source numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported canonical invoice source value: ${typeof value}`);
  }

  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = sortObjectKeys(child);
  }
  return result;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFields(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const order = compareStrings(left[index], right[index]);
    if (order !== 0) return order;
  }
  return 0;
}

function normalizeClass(cls: ParsedClass): InvoiceSourceClass {
  return {
    eventIdentity: {
      calendarId: cls.eventIdentity.calendarId,
      eventId: cls.eventIdentity.eventId,
      recurringEventId: cls.eventIdentity.recurringEventId ?? null,
      originalStartTime: cls.eventIdentity.originalStartTime ?? null,
      etag: cls.eventIdentity.etag ?? null,
    },
    sourceSummary: cls.sourceSummary,
    sourceDescription: cls.sourceDescription,
    studioName: cls.studioName,
    classType: cls.classType,
    location: cls.location ?? null,
    date: cls.date,
    startTime: cls.startTime,
    endTime: cls.endTime,
    studentCount: cls.studentCount,
    rateOverride: cls.rateOverride ?? null,
    unconfigured: cls.unconfigured ?? false,
    ambiguousStudentCount: cls.ambiguousStudentCount ?? false,
  };
}

function classSortFields(cls: InvoiceSourceClass): string[] {
  return [
    cls.eventIdentity.calendarId,
    cls.eventIdentity.eventId,
    cls.eventIdentity.originalStartTime ?? '',
    cls.date,
    cls.startTime,
    cls.endTime,
  ];
}

function normalizeClasses(classes: readonly ParsedClass[]): InvoiceSourceClass[] {
  return classes
    .map(normalizeClass)
    .sort(
      (left, right) =>
        compareFields(classSortFields(left), classSortFields(right)) ||
        compareStrings(canonicalJson(left), canonicalJson(right))
    );
}

function normalizeLineItems(invoice: Invoice): InvoiceSourceLineItem[] {
  return invoice.classes
    .map((item) => ({
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      classType: item.classType,
      location: item.location ?? null,
      studentCount: item.studentCount,
      rateApplied: item.rateApplied,
      lineTotal: item.lineTotal,
    }))
    .sort((left, right) =>
      compareFields(
        [
          left.date,
          left.startTime,
          left.endTime,
          left.classType,
          left.location ?? '',
          String(left.studentCount),
          String(left.rateApplied),
          String(left.lineTotal),
        ],
        [
          right.date,
          right.startTime,
          right.endTime,
          right.classType,
          right.location ?? '',
          String(right.studentCount),
          String(right.rateApplied),
          String(right.lineTotal),
        ]
      )
    );
}

export function buildInvoiceSource(input: BuildInvoiceSourceInput): InvoiceSource {
  const studio = input.config.studios[input.invoice.studioName];
  if (!studio) {
    throw new TypeError(`Missing studio configuration for "${input.invoice.studioName}"`);
  }

  return {
    schema: 1,
    calendarId: input.calendarId,
    studioSlug: studioSlug(input.invoice.studioName),
    invoiceNumber: input.invoiceNumber,
    period: {
      from: input.invoice.invoicePeriod.from,
      to: input.invoice.invoicePeriod.to,
    },
    classes: normalizeClasses(input.classes),
    invoice: {
      studioName: input.invoice.studioName,
      lineItems: normalizeLineItems(input.invoice),
      totalClasses: input.invoice.totalClasses,
      totalAmount: input.invoice.totalAmount,
    },
    teacher: {
      name: input.config.teacher.name,
      address: input.config.teacher.address,
      taxNumber: input.config.teacher.taxNumber,
      bankDetails: {
        accountOwner: input.config.teacher.bankDetails.accountOwner,
        iban: input.config.teacher.bankDetails.iban,
        bic: input.config.teacher.bankDetails.bic,
      },
    },
    studio: {
      name: input.invoice.studioName,
      fullName: studio.fullName,
      address: studio.address,
      invoiceEmail: studio.invoiceEmail ?? '',
      rateTiers: studio.rateTiers.map((tier) => ({
        minStudents: tier.minStudents,
        maxStudents: tier.maxStudents,
        rate: tier.rate,
      })),
    },
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintInvoiceSource(
  source: InvoiceSource
): Promise<InvoiceSourceFingerprint> {
  const encoder = new TextEncoder();
  const calendarSource = {
    schema: source.schema,
    calendarId: source.calendarId,
    classes: source.classes,
  };

  const [sourceSha256, calendarSha256] = await Promise.all([
    sha256Hex(encoder.encode(canonicalJson(source))),
    sha256Hex(encoder.encode(canonicalJson(calendarSource))),
  ]);
  return { sourceSha256, calendarSha256 };
}
