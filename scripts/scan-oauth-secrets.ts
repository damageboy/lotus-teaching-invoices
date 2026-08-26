import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'buffer' });
  if (result.status !== 0) {
    console.error(`Could not list tracked files: ${result.stderr.toString('utf8').trim()}`);
    process.exit(2);
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function main(): void {
  const prefix = ['GOCSPX', ''].join('-');
  const googleClientSecret = new RegExp(`${prefix}[A-Za-z0-9_-]{16,}`);
  const violations: string[] = [];
  const files = trackedFiles();

  for (const path of files) {
    try {
      if (googleClientSecret.test(readFileSync(path).toString('latin1'))) violations.push(path);
    } catch (error) {
      console.error(`Could not scan tracked file ${path}: ${error}`);
      process.exit(2);
    }
  }

  if (violations.length > 0) {
    console.error(`Google OAuth client secret found in tracked files: ${violations.join(', ')}`);
    process.exit(1);
  }

  console.log(`OAuth source scan passed: ${files.length} tracked files`);
}

main();
