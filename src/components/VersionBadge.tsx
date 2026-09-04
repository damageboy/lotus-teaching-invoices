import { APP_IS_OFFICIAL, APP_VERSION } from '../lib/version.js';

export function VersionBadge() {
  return (
    <span data-testid="version-badge" className="font-mono text-xs text-gray-400">
      v{APP_VERSION}
      {!APP_IS_OFFICIAL && (
        <span className="ml-1.5 rounded bg-gray-100 px-1 py-0.5 text-gray-400">dev</span>
      )}
      {!APP_IS_OFFICIAL && APP_VERSION.endsWith('-dirty') && (
        <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-amber-500">dirty</span>
      )}
    </span>
  );
}
