import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listActiveInvoiceFreshness, type InvoiceFreshnessRow } from '../lib/invoice/freshness.js';

export interface InvoiceFreshnessState {
  rows: InvoiceFreshnessRow[];
  loadedContext: InvoiceFreshnessContext | null;
  isCurrentContextVerified: boolean;
  isLoading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  acknowledgeClear: (key: InvoiceFreshnessRow['key'], expectedRevision: number) => void;
}

export interface InvoiceFreshnessContext {
  calendarId: string;
  outputDir: string;
}

type FreshnessLoader = typeof listActiveInvoiceFreshness;

function validContext(calendarId: string | undefined, outputDir: string | undefined): boolean {
  return Boolean(calendarId?.trim() && outputDir?.trim());
}

interface FreshnessIncarnation {
  calendarId: string | undefined;
  outputDir: string | undefined;
  valid: boolean;
}

function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function sameKey(left: InvoiceFreshnessRow['key'], right: InvoiceFreshnessRow['key']): boolean {
  return (
    left.calendarId === right.calendarId &&
    left.outputDir === right.outputDir &&
    left.studioName === right.studioName &&
    left.monthKey === right.monthKey
  );
}

export function useInvoiceFreshness(
  calendarId?: string,
  outputDir?: string,
  load: FreshnessLoader = listActiveInvoiceFreshness
): InvoiceFreshnessState {
  const incarnation = useMemo<FreshnessIncarnation>(
    () => ({ calendarId, outputDir, valid: validContext(calendarId, outputDir) }),
    [calendarId, outputDir]
  );
  const committedIncarnationRef = useRef<FreshnessIncarnation | null>(null);
  const requestSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const [rows, setRows] = useState<InvoiceFreshnessRow[]>([]);
  const [loadedContext, setLoadedContext] = useState<InvoiceFreshnessContext | null>(null);
  const [isLoading, setIsLoading] = useState(incarnation.valid);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    committedIncarnationRef.current = incarnation;
    requestSequenceRef.current += 1;
    return () => {
      if (committedIncarnationRef.current === incarnation) {
        committedIncarnationRef.current = null;
      }
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, [incarnation]);

  const reload = useCallback(async () => {
    if (!mountedRef.current || committedIncarnationRef.current !== incarnation) return;
    const requestSequence = ++requestSequenceRef.current;
    if (!incarnation.valid) {
      setRows([]);
      setLoadedContext(null);
      setIsLoading(false);
      setError(null);
      return;
    }
    const isCurrentRequest = () =>
      mountedRef.current &&
      requestSequenceRef.current === requestSequence &&
      committedIncarnationRef.current === incarnation;

    setIsLoading(true);
    setError(null);
    try {
      const loadedRows = await load(incarnation.calendarId!, incarnation.outputDir!);
      if (!isCurrentRequest()) return;
      setRows(loadedRows);
      setLoadedContext({
        calendarId: incarnation.calendarId!,
        outputDir: incarnation.outputDir!,
      });
      setIsLoading(false);
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      setError(errorMessage(loadError));
      setIsLoading(false);
    }
  }, [incarnation, load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const acknowledgeClear = useCallback(
    (key: InvoiceFreshnessRow['key'], expectedRevision: number) => {
      setRows((current) =>
        current.filter((row) => !sameKey(row.key, key) || row.revision !== expectedRevision)
      );
    },
    []
  );

  if (!incarnation.valid) {
    return {
      rows: [],
      loadedContext: null,
      isCurrentContextVerified: false,
      isLoading: false,
      error: null,
      reload,
      acknowledgeClear,
    };
  }
  const isCurrentContextVerified =
    !isLoading &&
    error === null &&
    loadedContext !== null &&
    loadedContext.calendarId === incarnation.calendarId &&
    loadedContext.outputDir === incarnation.outputDir;
  return {
    rows,
    loadedContext,
    isCurrentContextVerified,
    isLoading,
    error,
    reload,
    acknowledgeClear,
  };
}
