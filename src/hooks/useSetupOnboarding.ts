import { useLayoutEffect, useState } from 'react';
import type { SetupReadiness, SetupStep } from '../lib/setup/readiness.js';

export interface SetupOnboardingController {
  open: boolean;
  step: SetupStep;
  dismissed: boolean;
  driveAcknowledgementRequired: boolean;
  acknowledgeDrive(): void;
  dismiss(): void;
}

export function useSetupOnboarding(readiness: SetupReadiness): SetupOnboardingController {
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<SetupStep>(readiness.firstIncompleteStep ?? 'calendar');
  const [driveSetupActive, setDriveSetupActive] = useState(
    readiness.firstIncompleteStep === 'drive'
  );
  const driveAcknowledgementRequired =
    !dismissed && driveSetupActive && readiness.status === 'ready';
  const open =
    !dismissed &&
    (readiness.status === 'incomplete' ||
      readiness.status === 'unavailable' ||
      driveAcknowledgementRequired);

  useLayoutEffect(() => {
    if (dismissed) return;
    if (open && readiness.firstIncompleteStep !== null) {
      setStep(readiness.firstIncompleteStep);
    }
    if (
      (readiness.status === 'incomplete' || readiness.status === 'unavailable') &&
      readiness.firstIncompleteStep !== null
    ) {
      setDriveSetupActive(readiness.firstIncompleteStep === 'drive');
    }
  }, [dismissed, open, readiness.firstIncompleteStep, readiness.status]);

  return {
    open,
    step,
    dismissed,
    driveAcknowledgementRequired,
    acknowledgeDrive: () => setDriveSetupActive(false),
    dismiss: () => {
      setDriveSetupActive(false);
      setDismissed(true);
    },
  };
}
