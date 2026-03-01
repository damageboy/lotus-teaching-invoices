import { ParsedClass, Invoice, InvoiceLineItem, InvoicePeriod, StudioConfig } from "../types.js";
import { findRate } from "./calculator.js";

export interface GenerateResult {
  invoice: Invoice;
  warnings: string[];
}

export function generateInvoice(
  studioName: string,
  classes: ParsedClass[],
  studioConfig: StudioConfig,
  period: InvoicePeriod,
): GenerateResult {
  const lineItems: InvoiceLineItem[] = [];
  const warnings: string[] = [];

  for (const cls of classes) {
    if (cls.studentCount === 0) {
      warnings.push(`Skipping "${cls.classType}" on ${cls.date}: student count is 0`);
      continue;
    }

    const rate = findRate(studioConfig.rateTiers, cls.studentCount);
    lineItems.push({
      date: cls.date,
      startTime: cls.startTime,
      endTime: cls.endTime,
      classType: cls.classType,
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
      generatedAt: new Date().toISOString(),
      classes: lineItems,
      totalClasses: lineItems.length,
      totalAmount,
    },
    warnings,
  };
}
