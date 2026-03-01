#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "./cli/args.js";
import { loadConfig } from "./config/loader.js";
import { fetchCalendar } from "./calendar/fetcher.js";
import { parseCalendarEvents, extractClasses } from "./calendar/parser.js";
import { groupByStudio, filterByDateRange, filterByStudio } from "./invoice/grouper.js";
import { generateInvoice } from "./invoice/generator.js";
import { writeInvoice, printInvoice } from "./output/writer.js";
import { AppError, InvoicePeriod } from "./types.js";

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  // Load config
  const config = loadConfig(opts.config);

  // Fetch or read calendar
  const icsData = opts.file
    ? readFileSync(opts.file, "utf-8")
    : await fetchCalendar(config.calendarUrl);

  // Parse events
  const events = parseCalendarEvents(icsData);
  const knownStudios = new Map(Object.keys(config.studios).map(name => [name.toLowerCase(), name]));
  const { classes, warnings } = extractClasses(events, knownStudios);

  // Print warnings to stderr
  for (const w of warnings) {
    console.error(`[WARN] ${w}`);
  }

  // Filter by date range
  let filtered = filterByDateRange(classes, opts.from, opts.to);

  // Filter by studio if specified
  if (opts.studio) {
    if (!config.studios[opts.studio]) {
      throw new AppError(
        `Studio "${opts.studio}" not found in config`,
        "UNKNOWN_STUDIO",
      );
    }
    filtered = filterByStudio(filtered, opts.studio);
  }

  if (filtered.length === 0) {
    console.error("[WARN] No events found for the specified period");
    process.exit(2);
  }

  // Group and generate invoices
  const grouped = groupByStudio(filtered);
  const period: InvoicePeriod = { from: opts.from, to: opts.to };

  for (const [studioName, studioClasses] of grouped) {
    const studioConfig = config.studios[studioName];
    if (!studioConfig) continue; // already filtered out unknown studios

    const { invoice, warnings: genWarnings } = generateInvoice(studioName, studioClasses, studioConfig, period);

    for (const w of genWarnings) {
      console.error(`[WARN] ${w}`);
    }

    if (opts.dryRun) {
      printInvoice(invoice);
    } else {
      const filePath = writeInvoice(invoice, opts.output);
      console.log(`Written: ${filePath}`);
    }
  }
}

main().catch((err) => {
  if (err instanceof AppError) {
    console.error(`Error [${err.code}]: ${err.message}`);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
});
