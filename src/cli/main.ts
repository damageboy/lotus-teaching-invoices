#!/usr/bin/env node

import { parseArgs } from './args.js';
import { AppError } from '../lib/types.js';

async function main(): Promise<void> {
  parseArgs(process.argv);

  // Calendar API requires the desktop app — CLI no longer supports direct calendar access
  throw new AppError(
    'CLI no longer supports calendar fetching. Use the desktop app for Google Calendar API access.',
    'NOT_SUPPORTED'
  );
}

main().catch((err) => {
  if (err instanceof AppError) {
    console.error(`Error [${err.code}]: ${err.message}`);
  } else {
    console.error('Unexpected error:', err);
  }
  process.exit(1);
});
