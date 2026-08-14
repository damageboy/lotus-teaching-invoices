import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  getAccessToken,
  loadCalendarEditPromptPreference,
  saveCalendarEditPromptPreference,
} from '../lib/gmail/auth.js';
import {
  calendarEditAuthorizationState,
  hasRequiredScopes,
  parseStoredTokenRecord,
} from '../lib/gmail/auth-record.js';
import {
  AUTHORIZATION_SCHEMA_VERSION,
  CALENDAR_EDIT_OAUTH_SCOPES,
} from '../lib/gmail/constants.js';

export interface GoogleAuthorizationState {
  isLoading: boolean;
  isAuthorizing: boolean;
  hasCalendarWrite: boolean;
  promptOpen: boolean;
  error: string | null;
  allowCalendarEditing: () => Promise<void>;
  dismissCalendarEditingPrompt: () => Promise<void>;
  openCalendarEditingPrompt: () => void;
}

interface GoogleAuthorizationDependencies {
  readAuthTokens: () => Promise<string | null>;
  getAccessToken: typeof getAccessToken;
  loadPreference: typeof loadCalendarEditPromptPreference;
  savePreference: typeof saveCalendarEditPromptPreference;
}

const googleAuthorizationDependencies: GoogleAuthorizationDependencies = {
  readAuthTokens: () => invoke<string | null>('read_auth_tokens'),
  getAccessToken,
  loadPreference: loadCalendarEditPromptPreference,
  savePreference: saveCalendarEditPromptPreference,
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
  const [promptOpen, setPromptOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissalSequenceRef = useRef(0);

  useEffect(() => {
    let active = true;

    async function loadAuthorization() {
      try {
        const [raw, preference] = await Promise.all([
          dependencies.readAuthTokens(),
          dependencies.loadPreference(),
        ]);
        if (!active) return;
        const record = raw === null ? null : parseStoredTokenRecord(raw);
        const writeGranted = hasRequiredScopes(record, CALENDAR_EDIT_OAUTH_SCOPES);
        setHasCalendarWrite(writeGranted);
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
      await dependencies.getAccessToken({ requireCalendarWrite: true });
      setHasCalendarWrite(true);
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

  const openCalendarEditingPrompt = useCallback(() => {
    setPromptOpen(true);
  }, []);

  return {
    isLoading,
    isAuthorizing,
    hasCalendarWrite,
    promptOpen,
    error,
    allowCalendarEditing,
    dismissCalendarEditingPrompt,
    openCalendarEditingPrompt,
  };
}
