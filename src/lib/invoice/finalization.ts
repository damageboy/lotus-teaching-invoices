/** Parse "N/YYYY" → { n, year }, or null if invalid/empty. */
export function parseLastInvoice(s: string): { n: number; year: number } | null {
  const m = /^(\d+)\/(\d{4})$/.exec(s);
  if (!m) return null;
  return { n: parseInt(m[1], 10), year: parseInt(m[2], 10) };
}

/** Format a sequential invoice number as "N/YYYY". */
export function formatInvoiceNumber(n: number, year: number): string {
  return `${n}/${year}`;
}

/** Convert a studio name to a URL/filename-safe slug. */
export function studioSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Filename for a preview PDF.
 * e.g. "yogibar-2026-01.pdf"
 */
export function previewFilename(studioName: string, from: string, _to: string): string {
  const slug = studioSlug(studioName);
  const [year, month] = from.split('-');
  return `${slug}-${year}-${month}.pdf`;
}

/**
 * Filename for a finalized PDF. Invoice number is embedded at the start
 * so it can be recovered later without a registry.
 * e.g. "8-2026-yogibar-2026-01.pdf"
 *
 * @param slug       pre-computed studio slug
 * @param periodYear "2026"
 * @param periodMonth "01"
 * @param invoiceNumber "8/2026"
 */
export function finalizedFilename(
  slug: string,
  periodYear: string,
  periodMonth: string,
  invoiceNumber: string
): string {
  const [n, year] = invoiceNumber.split('/');
  return `${n}-${year}-${slug}-${periodYear}-${periodMonth}.pdf`;
}

/**
 * Extract the invoice number from a finalized filename.
 * Returns "8/2026" from "8-2026-yogibar-2026-01.pdf", or null if not a finalized file.
 */
export function extractInvoiceNumberFromFilename(filename: string): string | null {
  const m = /^(\d+)-(\d{4})-/.exec(filename);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Returns true if `filename` is a finalized invoice for the given studio/period.
 * Used to detect an already-finalized invoice before overwriting.
 */
export function matchesFinalizedInvoice(
  filename: string,
  slug: string,
  periodYear: string,
  periodMonth: string
): boolean {
  // Full-filename regex prevents false positives when one slug is a suffix of another
  // e.g. slug "yoga" must not match "8-2026-bikram-yoga-2026-01.pdf"
  const pattern = new RegExp(`^\\d+-\\d{4}-${slug}-${periodYear}-${periodMonth}\\.pdf$`);
  return pattern.test(filename);
}
