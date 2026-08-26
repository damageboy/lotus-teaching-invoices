import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  getAccessToken,
  loadCalendarEditPromptPreference,
  saveCalendarEditPromptPreference,
} from '../lib/gmail/auth.js';
import {
  calendarEditAuthorizationState,
  hasDriveAuthorization,
  hasRequiredScopes,
  parseStoredTokenRecord,
} from '../lib/gmail/auth-record.js';
import {
  AUTHORIZATION_SCHEMA_VERSION,
  CALENDAR_EDIT_OAUTH_SCOPES,
} from '../lib/gmail/constants.js';
import { isAndroidRuntime } from '../lib/google/mobile-authorization.js';

export interface GoogleAuthorizationState {
  isLoading: boolean;
  isAuthorizing: boolean;
  hasCalendarWrite: boolean;
  hasDrive: boolean;
  authorizationIncarnation: number;
  promptOpen: boolean;
  error: string | null;
  allowCalendarEditing: () => Promise<void>;
  allowDrive: () => Promise<void>;
  dismissCalendarEditingPrompt: () => Promise<void>;
  openCalendarEditingPrompt: () => void;
}

interface GoogleAuthorizationDependencies {
  readAuthTokens: () => Promise<string | null>;
  getAccessToken: typeof getAccessToken;
  loadPreference: typeof loadCalendarEditPromptPreference;
  savePreference: typeof saveCalendarEditPromptPreference;
  isAndroid?: () => boolean;
}

const googleAuthorizationDependencies: GoogleAuthorizationDependencies = {
  readAuthTokens: () => invoke<string | null>('read_auth_tokens'),
  getAccessToken,
  loadPreference: loadCalendarEditPromptPreference,
  savePreference: saveCalendarEditPromptPreference,
  isAndroid: isAndroidRuntime,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDismissedAuthorizationOutcome(message: string): boolean {
  return (
    message === 'Calendar authorization was denied' ||
    message === 'Calendar authorization timed out or the browser was closed'
  );
}

export function useGoogleAuthorization(
  dependencies: GoogleAuthorizationDependencies = googleAuthorizationDependencies
): GoogleAuthorizationState {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [hasCalendarWrite, setHasCalendarWrite] = useState(false);
  const [hasDrive, setHasDrive] = useState(false);
  const [authorizationIncarnation, setAuthorizationIncarnation] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissalSequenceRef = useRef(0);

  useEffect(() => {
    let active = true;

    async function loadAuthorization() {
      try {
        if (dependencies.isAndroid?.() === true) {
          const [preference, calendarResult, driveResult] = await Promise.all([
            dependencies.loadPreference(),
            dependencies.getAccessToken({ requireCalendarWrite: true, interactive: false }).then(
              () => true,
              () => false
            ),
            dependencies.getAccessToken({ requireDrive: true, interactive: false }).then(
              () => true,
              () => false
            ),
          ]);
          if (!active) return;
          setHasCalendarWrite(calendarResult);
          setHasDrive(driveResult);
          setPromptOpen(
            !calendarResult &&
              preference?.dismissed_authorization_version !== AUTHORIZATION_SCHEMA_VERSION
          );
          return;
        }

        const [raw, preference] = await Promise.all([
          dependencies.readAuthTokens(),
          dependencies.loadPreference(),
        ]);
        if (!active) return;
        const record = raw === null ? null : parseStoredTokenRecord(raw);
        const writeGranted = hasRequiredScopes(record, CALENDAR_EDIT_OAUTH_SCOPES);
        setHasCalendarWrite(writeGranted);
        setHasDrive(hasDriveAuthorization(record));
        setPromptOpen(
          record !== null && calendarEditAuthorizationState(record, preference) === 'prompt'
        );
      } catch (loadError) {
        if (active) setError(errorMessage(loadError));
      } finally {
        if (active) setIsLoading(false);
      }
    }

    void loadAuthorization();
    return () => {
      active = false;
    };
  }, [dependencies]);

  const persistDismissal = useCallback(async () => {
    dismissalSequenceRef.current += 1;
    setPromptOpen(false);
    await dependencies.savePreference({
      dismissed_authorization_version: AUTHORIZATION_SCHEMA_VERSION,
    });
  }, [dependencies]);

  const dismissCalendarEditingPrompt = useCallback(async () => {
    try {
      await persistDismissal();
    } catch (dismissError) {
      setError(errorMessage(dismissError));
    }
  }, [persistDismissal]);

  const allowCalendarEditing = useCallback(async () => {
    const dismissalSequence = dismissalSequenceRef.current;
    setIsAuthorizing(true);
    setError(null);
    try {
      await dependencies.getAccessToken({ requireCalendarWrite: true, interactive: true });
      setHasCalendarWrite(true);
      setAuthorizationIncarnation((value) => value + 1);
      setPromptOpen(false);
    } catch (authorizationError) {
      setHasCalendarWrite(false);
      const message = errorMessage(authorizationError);
      setError(message);
      if (isDismissedAuthorizationOutcome(message)) {
        try {
          await persistDismissal();
        } catch {
          // The authorization error remains available if the prompt is opened again.
        }
      } else if (dismissalSequenceRef.current === dismissalSequence) {
        setPromptOpen(true);
      }
    } finally {
      setIsAuthorizing(false);
    }
  }, [dependencies, persistDismissal]);

  const allowDrive = useCallback(async () => {
    setIsAuthorizing(true);
    setError(null);
    try {
      await dependencies.getAccessToken({ requireDrive: true, interactive: true });
      setHasDrive(true);
      setAuthorizationIncarnation((value) => value + 1);
    } catch (authorizationError) {
      setHasDrive(false);
      setError(errorMessage(authorizationError));
      throw authorizationError;
    } finally {
      setIsAuthorizing(false);
    }
  }, [dependencies]);

  const openCalendarEditingPrompt = useCallback(() => {
    setPromptOpen(true);
  }, []);

  return {
    isLoading,
    isAuthorizing,
    hasCalendarWrite,
    hasDrive,
    authorizationIncarnation,
    promptOpen,
    error,
    allowCalendarEditing,
    allowDrive,
    dismissCalendarEditingPrompt,
    openCalendarEditingPrompt,
  };
}
