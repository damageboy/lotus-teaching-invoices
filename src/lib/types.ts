export interface RateTier {
  minStudents: number;
  maxStudents: number | null;
  rate: number;
}

export interface BankDetails {
  accountOwner: string;
  iban: string;
  bic: string;
}

export interface TeacherInfo {
  name: string;
  address: string; // free-form, newlines allowed
  taxNumber: string;
  bankDetails: BankDetails;
}

export interface StudioConfig {
  fullName: string; // display name for PDF; key is still the calendar match string
  address: string;
  invoiceEmail?: string; // email address for sending invoices
  rateTiers: RateTier[];
  color?: string; // hex, e.g. "#7c3aed"; absent = auto-assigned from palette
}

export interface AppConfig {
  teacher: TeacherInfo;
  calendarId?: string; // Google Calendar ID (e.g. "abc@group.calendar.google.com")
  calendarName?: string; // Display name of the selected calendar
  outputDir: string;
  lastInvoice: string; // "N/YYYY" e.g. "7/2026", or "" if unset
  studios: Record<string, StudioConfig>;
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
}

export interface ParsedClass {
  studioName: string;
  classType: string;
  location?: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  studentCount: number;
  rateOverride?: number; // e.g. "9/30EUR" → 30; overrides rate tier lookup
  unconfigured?: boolean; // true when studio has no rate config
  ambiguousStudentCount?: boolean;
}

export interface InvoiceLineItem {
  date: string;
  startTime: string;
  endTime: string;
  classType: string;
  location?: string;
  studentCount: number;
  rateApplied: number;
  lineTotal: number;
}

export interface InvoicePeriod {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface Invoice {
  studioName: string;
  invoicePeriod: InvoicePeriod;
  generatedAt: string; // ISO 8601
  issueDate: string; // YYYY-MM-DD local date shown on the invoice
  classes: InvoiceLineItem[];
  totalClasses: number;
  totalAmount: number;
  invoiceNumber?: string; // set only on finalized invoices, e.g. "8/2026"
}

export type WarningCode =
  | 'NO_SEPARATOR'
  | 'MISSING_CLASS_TYPE'
  | 'UNKNOWN_STUDIO'
  | 'MISSING_STUDENT_COUNT'
  | 'AMBIGUOUS_STUDENT_COUNT'
  | 'ZERO_STUDENTS';

export interface ParseWarning {
  code: WarningCode;
  event: string; // raw event summary
  date?: string; // YYYY-MM-DD if known
  studio?: string; // extracted studio name (for UNKNOWN_STUDIO)
}

export class AppError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}
