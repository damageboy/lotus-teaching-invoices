import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const androidResourceRoot = join(
  repositoryRoot,
  'src-tauri',
  'gen',
  'android',
  'app',
  'src',
  'main',
  'res'
);

const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'] as const;
const launcherFiles = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
const packagedIconFiles = [
  'mipmap-anydpi-v26/ic_launcher.xml',
  'values/ic_launcher_background.xml',
  ...densities.flatMap((density) =>
    launcherFiles.map((filename) => join(`mipmap-${density}`, filename))
  ),
];
const lotusIconSetHash = 'a8407025da91b45f27ba455929d3b753b99178673abe9cecd7c79e157000e772';

describe('Android application icon', () => {
  it('packages the generated Lotus launcher artwork at every Android density', async () => {
    const iconSetHash = createHash('sha256');

    for (const relativePath of packagedIconFiles) {
      iconSetHash.update(relativePath);
      iconSetHash.update(await readFile(join(androidResourceRoot, relativePath)));
    }

    expect(iconSetHash.digest('hex')).toBe(lotusIconSetHash);
  });
});
