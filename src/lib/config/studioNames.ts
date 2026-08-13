import { StudioConfig } from '../types.js';

export type StudioRenameResult =
  | {
      ok: true;
      name: string;
      studios: Record<string, StudioConfig>;
      changed: boolean;
    }
  | { ok: false; error: string };

export function renameStudio(
  studios: Record<string, StudioConfig>,
  oldName: string,
  proposedName: string
): StudioRenameResult {
  const name = proposedName.trim();

  if (!name) {
    return { ok: false, error: 'Studio name cannot be empty.' };
  }

  if (name === oldName) {
    return { ok: true, name, studios, changed: false };
  }

  if (Object.hasOwn(studios, name)) {
    return { ok: false, error: `A studio named "${name}" already exists.` };
  }

  const renamed = Object.fromEntries(
    Object.entries(studios).map(([studioName, studio]) => [
      studioName === oldName ? name : studioName,
      studio,
    ])
  );

  return { ok: true, name, studios: renamed, changed: true };
}
