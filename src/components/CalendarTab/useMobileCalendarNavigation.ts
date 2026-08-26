import { useCallback, useEffect, useRef, useState } from 'react';
import type { ParsedClass } from '../../lib/types.js';
import {
  calendarHistoryLevel,
  calendarHistoryState,
  createMobileCalendarOwnerId,
} from './mobile-calendar-history.js';
import { initialMobileDate, selectedDateForMonth } from './mobile-calendar.js';

export type MobileCalendarLevel = 'month' | 'agenda' | 'details';

export interface UseMobileCalendarNavigationOptions {
  enabled: boolean;
  activationKey: number;
  year: number;
  month: number;
  classes: ParsedClass[];
}

interface SelectedLesson {
  lesson: ParsedClass;
  anchor: HTMLButtonElement;
}

export function useMobileCalendarNavigation({
  enabled,
  activationKey,
  year,
  month,
  classes,
}: UseMobileCalendarNavigationOptions) {
  const [level, setLevelState] = useState<MobileCalendarLevel>('month');
  const levelRef = useRef<MobileCalendarLevel>('month');
  const [selectedDate, setSelectedDate] = useState(() =>
    initialMobileDate(year, month, classes, new Date())
  );
  const [selectedLesson, setSelectedLesson] = useState<SelectedLesson | null>(null);
  const selectedLessonRef = useRef<SelectedLesson | null>(null);
  const [agendaFocusRequest, setAgendaFocusRequest] = useState(0);
  const [monthFocusRequest, setMonthFocusRequest] = useState(0);
  const ownerRef = useRef<string | null>(enabled ? createMobileCalendarOwnerId() : null);
  const ownedDepthRef = useRef(0);
  const traversalInFlightRef = useRef(false);
  const cleanupTraversalPendingRef = useRef(false);
  const previousActivationKeyRef = useRef(activationKey);
  const previousEnabledRef = useRef(enabled);
  const initialSelectionPending = useRef(classes.length === 0);
  const previousClassCount = useRef(classes.length);

  const setLevel = useCallback((next: MobileCalendarLevel) => {
    levelRef.current = next;
    setLevelState(next);
  }, []);

  const resetOwnedSession = useCallback(
    (replacementOwner: boolean, resetVisibleState: boolean) => {
      const ownerId = ownerRef.current;
      const ownedDepth = ownedDepthRef.current;
      const expectedTop = ownedDepth === 2 ? 'details' : ownedDepth === 1 ? 'agenda' : null;
      const canTraverse =
        ownerId !== null &&
        expectedTop !== null &&
        levelRef.current === expectedTop &&
        calendarHistoryLevel(window.history.state, ownerId) === expectedTop;

      ownerRef.current = null;
      ownedDepthRef.current = 0;
      traversalInFlightRef.current = false;
      cleanupTraversalPendingRef.current = canTraverse;
      selectedLessonRef.current = null;

      if (resetVisibleState) {
        setSelectedLesson(null);
        setLevel('month');
      }

      if (canTraverse) window.history.go(-ownedDepth);
      if (replacementOwner) ownerRef.current = createMobileCalendarOwnerId();
    },
    [setLevel]
  );

  const restoreAgendaFocus = useCallback(() => {
    const anchor = selectedLessonRef.current?.anchor;
    queueMicrotask(() => {
      if (anchor?.isConnected) anchor.focus();
      else setAgendaFocusRequest((request) => request + 1);
    });
  }, []);

  const showAgenda = useCallback(() => {
    setLevel('agenda');
    setSelectedLesson(null);
    restoreAgendaFocus();
  }, [restoreAgendaFocus, setLevel]);

  const openAgenda = useCallback(
    (date: string, _anchor: HTMLButtonElement) => {
      if (!enabled || levelRef.current !== 'month') return;
      initialSelectionPending.current = false;
      setSelectedDate(date);
      const ownerId = ownerRef.current ?? createMobileCalendarOwnerId();
      ownerRef.current = ownerId;
      window.history.pushState(calendarHistoryState(window.history.state, ownerId, 'agenda'), '');
      ownedDepthRef.current = 1;
      setLevel('agenda');
      setAgendaFocusRequest((request) => request + 1);
    },
    [enabled, setLevel]
  );

  const selectAgendaDate = useCallback((date: string) => {
    initialSelectionPending.current = false;
    setSelectedDate(date);
  }, []);

  const openDetails = useCallback(
    (lesson: ParsedClass, anchor: HTMLButtonElement) => {
      if (!enabled || levelRef.current !== 'agenda') return;
      const ownerId = ownerRef.current ?? createMobileCalendarOwnerId();
      ownerRef.current = ownerId;
      if (calendarHistoryLevel(window.history.state, ownerId) !== 'agenda') {
        window.history.pushState(calendarHistoryState(window.history.state, ownerId, 'agenda'), '');
      }
      const selected = { lesson, anchor };
      selectedLessonRef.current = selected;
      setSelectedLesson(selected);
      window.history.pushState(calendarHistoryState(window.history.state, ownerId, 'details'), '');
      ownedDepthRef.current = 2;
      setLevel('details');
    },
    [enabled, setLevel]
  );

  const closeDetails = useCallback(() => {
    if (levelRef.current !== 'details' || traversalInFlightRef.current) return;
    const ownerId = ownerRef.current;
    if (ownerId !== null && calendarHistoryLevel(window.history.state, ownerId) === 'details') {
      traversalInFlightRef.current = true;
      window.history.back();
      return;
    }

    traversalInFlightRef.current = false;
    ownedDepthRef.current = Math.min(ownedDepthRef.current, 1);
    showAgenda();
  }, [showAgenda]);

  const changeMonth = useCallback((change: () => void) => {
    initialSelectionPending.current = false;
    change();
  }, []);

  useEffect(() => {
    if (previousActivationKeyRef.current === activationKey) return;
    previousActivationKeyRef.current = activationKey;
    if (enabled) resetOwnedSession(true, true);
  }, [activationKey, enabled, resetOwnedSession]);

  useEffect(() => {
    if (previousEnabledRef.current === enabled) return;
    previousEnabledRef.current = enabled;

    if (enabled) {
      ownerRef.current = createMobileCalendarOwnerId();
      selectedLessonRef.current = null;
      setSelectedLesson(null);
      setLevel('month');
    } else {
      resetOwnedSession(false, true);
    }
  }, [enabled, resetOwnedSession, setLevel]);

  useEffect(
    () => () => {
      resetOwnedSession(false, false);
    },
    [resetOwnedSession]
  );

  useEffect(() => {
    setSelectedDate((current) => selectedDateForMonth(current, year, month));
  }, [month, year]);

  useEffect(() => {
    if (initialSelectionPending.current && previousClassCount.current === 0 && classes.length > 0) {
      setSelectedDate(initialMobileDate(year, month, classes, new Date()));
      initialSelectionPending.current = false;
    }
    previousClassCount.current = classes.length;
  }, [classes, month, year]);

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      if (cleanupTraversalPendingRef.current) {
        cleanupTraversalPendingRef.current = false;
        return;
      }

      const ownerId = ownerRef.current;
      const destination = ownerId === null ? null : calendarHistoryLevel(event.state, ownerId);
      const currentLevel = levelRef.current;

      if (currentLevel === 'details' && destination === 'details') return;
      if (currentLevel === 'details' && destination === 'agenda') {
        traversalInFlightRef.current = false;
        ownedDepthRef.current = 1;
        showAgenda();
        return;
      }
      if (currentLevel === 'agenda' && destination === 'agenda') {
        traversalInFlightRef.current = false;
        return;
      }
      if (currentLevel === 'agenda') {
        traversalInFlightRef.current = false;
        ownedDepthRef.current = 0;
        selectedLessonRef.current = null;
        setSelectedLesson(null);
        setLevel('month');
        setMonthFocusRequest((request) => request + 1);
      }
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setLevel, showAgenda]);

  return {
    level,
    selectedDate,
    selectedLesson: selectedLesson?.lesson ?? null,
    selectedLessonAnchor: selectedLesson?.anchor ?? null,
    agendaFocusRequest,
    monthFocusRequest,
    openAgenda,
    selectAgendaDate,
    openDetails,
    closeDetails,
    changeMonth,
  };
}
