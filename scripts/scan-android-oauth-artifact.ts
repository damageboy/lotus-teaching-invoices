import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const DESKTOP_CLIENT_SECRET = Buffer.from('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');

function filesBelow(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) result.push(path);
    }
  };
  visit(root);
  return result;
}

function main(): void {
  const argument = process.argv[2];
  if (argument === undefined || process.argv.length !== 3) {
    console.error('Usage: scan-android-oauth-artifact.ts <path-to-apk>');
    process.exitCode = 2;
    return;
  }

  const artifact = realpathSync(argument);
  if (!artifact.endsWith('.apk')) {
    console.error('Android OAuth artifact scan requires an .apk file');
    process.exitCode = 2;
    return;
  }

  const extracted = mkdtempSync(join(tmpdir(), 'lotus-android-oauth-apk-'));
  try {
    const unzip = spawnSync('/usr/bin/unzip', ['-qq', artifact, '-d', extracted], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (unzip.status !== 0) {
      console.error(`Could not decompress ${basename(artifact)}: ${unzip.stderr.trim()}`);
      process.exitCode = 2;
      return;
    }

    const files = filesBelow(extracted);
    const violations = files
      .filter((path) => readFileSync(path).includes(DESKTOP_CLIENT_SECRET))
      .map((path) => relative(extracted, path))
      .sort();
    if (violations.length > 0) {
      console.error(
        `Desktop OAuth client secret found in ${basename(artifact)}: ${violations.join(', ')}`
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `Android OAuth artifact scan passed: ${basename(artifact)} (${files.length} decompressed files)`
    );
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

main();
