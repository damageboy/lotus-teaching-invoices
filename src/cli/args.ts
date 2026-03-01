import { Command } from 'commander';

export interface CliOptions {
  config: string;
  output: string;
  from: string;
  to: string;
  studio?: string;
  file?: string;
  dryRun: boolean;
}

function defaultFrom(): string {
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth(); // previous month (1-indexed)
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function defaultTo(): string {
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export function parseArgs(argv: string[]): CliOptions {
  const program = new Command();

  program
    .name('lotus-invoices')
    .description('Generate yoga teaching invoices from Google Calendar')
    .option('-c, --config <path>', 'Config file path', './config.yaml')
    .option('-o, --output <dir>', 'Output directory', './invoices')
    .option('--from <YYYY-MM-DD>', 'Start date', defaultFrom())
    .option('--to <YYYY-MM-DD>', 'End date', defaultTo())
    .option('-s, --studio <name>', 'Filter to one studio')
    .option('-f, --file <path>', 'Use local ICS file instead of fetching URL')
    .option('--dry-run', 'Print to stdout instead of writing files', false);

  program.parse(argv);
  const opts = program.opts();

  return {
    config: opts.config,
    output: opts.output,
    from: opts.from,
    to: opts.to,
    studio: opts.studio,
    file: opts.file,
    dryRun: opts.dryRun,
  };
}
