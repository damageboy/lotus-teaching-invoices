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
  address: string;     // free-form, newlines allowed
  taxNumber: string;
  bankDetails: BankDetails;
}

export interface StudioConfig {
  fullName: string;    // display name for PDF; key is still the calendar match string
  address: string;
  rateTiers: RateTier[];
}

export interface AppConfig {
  teacher: TeacherInfo;
  calendarUrl: string;
  outputDir: string;
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
  date: string;        // YYYY-MM-DD
  startTime: string;   // HH:mm
  endTime: string;     // HH:mm
  studentCount: number;
  unconfigured?: boolean; // true when studio has no rate config
}

export interface InvoiceLineItem {
  date: string;
  startTime: string;
  endTime: string;
  classType: string;
  studentCount: number;
  rateApplied: number;
  lineTotal: number;
}

export interface InvoicePeriod {
  from: string;  // YYYY-MM-DD
  to: string;    // YYYY-MM-DD
}

export interface Invoice {
  studioName: string;
  invoicePeriod: InvoicePeriod;
  generatedAt: string;  // ISO 8601
  classes: InvoiceLineItem[];
  totalClasses: number;
  totalAmount: number;
}

export type WarningCode =
  | 'NO_SEPARATOR'
  | 'MISSING_CLASS_TYPE'
  | 'UNKNOWN_STUDIO'
  | 'MISSING_STUDENT_COUNT'
  | 'ZERO_STUDENTS';

export interface ParseWarning {
  code: WarningCode;
  event: string;    // raw event summary
  date?: string;    // YYYY-MM-DD if known
  studio?: string;  // extracted studio name (for UNKNOWN_STUDIO)
}

export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
