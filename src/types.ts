export interface RateTier {
  minStudents: number;
  maxStudents: number | null;
  rate: number;
}

export interface StudioConfig {
  rateTiers: RateTier[];
}

export interface AppConfig {
  calendarUrl: string;
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

export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
