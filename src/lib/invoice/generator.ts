import {
  ParsedClass,
  Invoice,
  InvoiceLineItem,
  InvoicePeriod,
  StudioConfig,
  ParseWarning,
} from '../types.js';
import { findRate } from './calculator.js';

export interface GenerateResult {
  invoice: Invoice;
  warnings: ParseWarning[];
}

interface GenerateOptions {
  now?: Date;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function generateInvoice(
  studioName: string,
  classes: ParsedClass[],
  studioConfig: StudioConfig,
  period: InvoicePeriod,
  options: GenerateOptions = {}
): GenerateResult {
  const lineItems: InvoiceLineItem[] = [];
  const warnings: ParseWarning[] = [];
  const generatedAt = options.now ?? new Date();

  for (const cls of classes) {
    if (cls.studentCount === 0) {
      warnings.push({
        code: 'ZERO_STUDENTS',
        event: cls.location
          ? `${cls.studioName} / ${cls.location} / ${cls.classType}`
          : `${cls.studioName} / ${cls.classType}`,
        date: cls.date,
      });
      continue;
    }

    const rate = cls.rateOverride ?? findRate(studioConfig.rateTiers, cls.studentCount);
    lineItems.push({
      date: cls.date,
      startTime: cls.startTime,
      endTime: cls.endTime,
      classType: cls.classType,
      ...(cls.location ? { location: cls.location } : {}),
      studentCount: cls.studentCount,
      rateApplied: rate,
      lineTotal: rate,
    });
  }

  const totalAmount = lineItems.reduce((sum, item) => sum + item.lineTotal, 0);

  return {
    invoice: {
      studioName,
      invoicePeriod: period,
      generatedAt: generatedAt.toISOString(),
      issueDate: formatLocalDate(generatedAt),
      classes: lineItems,
      totalClasses: lineItems.length,
      totalAmount,
    },
    warnings,
  };
}
