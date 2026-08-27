import { useEffect, useState } from 'react';
import type { SetupReadiness, SetupStep } from '../lib/setup/readiness.js';

export interface SetupOnboardingController {
  open: boolean;
  step: SetupStep;
  dismissed: boolean;
  dismiss(): void;
}

export function useSetupOnboarding(readiness: SetupReadiness): SetupOnboardingController {
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<SetupStep>(readiness.firstIncompleteStep ?? 'calendar');
  const open =
    !dismissed && (readiness.status === 'incomplete' || readiness.status === 'unavailable');

  useEffect(() => {
    if (open && readiness.firstIncompleteStep !== null) {
      setStep(readiness.firstIncompleteStep);
    }
  }, [open, readiness.firstIncompleteStep]);

  return { open, step, dismissed, dismiss: () => setDismissed(true) };
}
