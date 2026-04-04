import { useState, useEffect } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { logInfo, logError, logWarn } from '../lib/logger';

type Status = 'idle' | 'available' | 'downloading' | 'done' | 'error';

export function UpdateNotification() {
  const [status, setStatus] = useState<Status>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [version, setVersion] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkForUpdate() {
      try {
        logInfo('Checking for updates…');
        const result = await check();
        if (cancelled) return;

        if (result) {
          logInfo(`Update available: v${result.version}`);
          setUpdate(result);
          setVersion(result.version);
          setStatus('available');
        } else {
          logInfo('App is up to date');
        }
      } catch (e) {
        if (cancelled) return;
        logWarn(`Update check failed: ${e}`);
        // Silent fail — don't bother the user
      }
    }

    checkForUpdate();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInstall() {
    if (!update) return;
    try {
      setStatus('downloading');
      logInfo(`Downloading update v${version}…`);
      await update.downloadAndInstall();
      setStatus('done');
      logInfo('Update installed. Relaunching…');
      await relaunch();
    } catch (e) {
      logError(`Update failed: ${e}`);
      setStatus('error');
    }
  }

  if (status === 'idle' || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-indigo-50 border-b border-indigo-100 text-sm">
      {status === 'available' && (
        <>
          <span className="text-indigo-700">Version {version} is available</span>
          <button
            onClick={handleInstall}
            className="px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 transition-colors"
          >
            Update Now
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="text-gray-400 hover:text-gray-600 ml-auto"
            title="Dismiss"
          >
            ✕
          </button>
        </>
      )}
      {status === 'downloading' && <span className="text-indigo-600">Downloading update…</span>}
      {status === 'error' && (
        <>
          <span className="text-red-600">Update failed. Please try again later.</span>
          <button
            onClick={() => setDismissed(true)}
            className="text-gray-400 hover:text-gray-600 ml-auto"
            title="Dismiss"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
