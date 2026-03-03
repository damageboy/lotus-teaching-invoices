import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'child_process';

function appVersionPlugin(): Plugin {
  function getVersionInfo(): { version: string; isOfficial: boolean } {
    // CI official build: GITHUB_REF is refs/tags/v1.2.3
    const tagMatch = process.env.GITHUB_REF?.match(/^refs\/tags\/v?(.+)/);
    if (tagMatch) {
      return { version: tagMatch[1], isOfficial: true };
    }
    // Local / branch build: use git describe
    try {
      const raw = execSync('git describe --tags --dirty=-dirty --always --abbrev=7', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return { version: raw.replace(/^v/, ''), isOfficial: false };
    } catch {
      return { version: 'unknown', isOfficial: false };
    }
  }

  const { version, isOfficial } = getVersionInfo();

  return {
    name: 'app-version',
    config() {
      return {
        define: {
          __APP_VERSION__: JSON.stringify(version),
          __APP_IS_OFFICIAL__: JSON.stringify(isOfficial),
        },
      };
    },
  };
}

export default defineConfig({
  base: '',
  plugins: [react(), tailwindcss(), appVersionPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
