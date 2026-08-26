import { useEffect, useMemo, useState } from 'react';
import { ParsedClass, StudioConfig } from '../../lib/types';
import { CalendarGrid } from './CalendarGrid';
import { studioColor } from '../../lib/studioColors';
import { computeStudioStats, StudioMonthStats } from '../../lib/invoice/calculator';
import { EventDetailsCard } from './EventDetailsCard';
import { MobileCalendar } from './MobileCalendar';
import type {
  OccurrenceValueEditOperation,
  OccurrenceValueEditPreflight,
  SeriesStudioEditPreflight,
} from '../../lib/calendar/calendar-update';
import type { AppLayout } from '../../hooks/useCompactLayout';
import { useMobileCalendarNavigation } from './useMobileCalendarNavigation';

interface Props {
  layout?: AppLayout;
  mobileActivation?: number;
  classes: ParsedClass[];
  studios?: Record<string, StudioConfig>;
  onAddStudio?: (name: string) => void;
  canEdit?: boolean;
  onReassignStudio?: (lesson: ParsedClass, studioName: string) => Promise<void>;
  onPrepareValueEdit?: (
    lesson: ParsedClass,
    operation: OccurrenceValueEditOperation
  ) => Promise<OccurrenceValueEditPreflight>;
  onSaveValueEdit?: (
    preflight: OccurrenceValueEditPreflight,
    confirmUnsupportedReplacement: boolean
  ) => Promise<void>;
  onPrepareSeriesStudioEdit?: (
    lesson: ParsedClass,
    studioName: string
  ) => Promise<SeriesStudioEditPreflight>;
  onSaveSeriesStudioEdit?: (preflight: SeriesStudioEditPreflight) => Promise<boolean>;
}

interface SelectedLesson {
  lesson: ParsedClass;
  anchor: HTMLButtonElement;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function CalendarTab({
  layout = 'desktop',
  mobileActivation = 0,
  classes,
  studios = {},
  onAddStudio,
  canEdit = false,
  onReassignStudio,
  onPrepareValueEdit,
  onSaveValueEdit,
  onPrepareSeriesStudioEdit,
  onSaveSeriesStudioEdit,
}: Props) {
  const now = new Date();
  const defaultInPrevMonth = now.getDate() <= 15;
  const defaultMonth = defaultInPrevMonth
    ? now.getMonth() === 0
      ? 11
      : now.getMonth() - 1
    : now.getMonth();
  const defaultYear =
    defaultInPrevMonth && now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const [year, setYear] = useState(defaultYear);
  const [month, setMonth] = useState(defaultMonth);
  const [desktopSelected, setDesktopSelected] = useState<SelectedLesson | null>(null);

  useEffect(() => {
    if (layout === 'mobile') setDesktopSelected(null);
  }, [layout]);

  const monthClasses = classes.filter((cls) => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    return cls.date.startsWith(prefix);
  });
  const mobileNavigation = useMobileCalendarNavigation({
    enabled: layout === 'mobile',
    activationKey: mobileActivation,
    year,
    month,
    classes: monthClasses,
  });

  function closeDesktopDetails() {
    const anchor = desktopSelected?.anchor;
    setDesktopSelected(null);
    queueMicrotask(() => anchor?.focus());
  }

  function openDesktopDetails(lesson: ParsedClass, anchor: HTMLButtonElement) {
    setDesktopSelected({ lesson, anchor });
  }

  // Per-studio stats for the displayed month (configured studios only)
  const studioStats = Object.entries(studios)
    .map(([key, studioConfig]) => {
      const studioClasses = monthClasses.filter((c) => c.studioName === key && !c.unconfigured);
      if (studioClasses.length === 0) return null;
      const stats = computeStudioStats(studioClasses, studioConfig.rateTiers);
      return { key, stats };
    })
    .filter((entry): entry is { key: string; stats: StudioMonthStats } => entry !== null);

  const colorMap = useMemo(
    () =>
      Object.fromEntries(Object.entries(studios).map(([name, cfg]) => [name, cfg.color])) as Record<
        string,
        string | undefined
      >,
    [studios]
  );

  const studioLocations = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const cls of monthClasses) {
      if (cls.location) {
        const set = map.get(cls.studioName) ?? new Set();
        set.add(cls.location);
        map.set(cls.studioName, set);
      }
    }
    return map;
  }, [monthClasses]);

  // Unique studios for legend — split configured vs unconfigured
  const configuredStudios = [
    ...new Set(classes.filter((c) => !c.unconfigured).map((c) => c.studioName)),
  ].sort();
  const unconfiguredStudios = [
    ...new Set(classes.filter((c) => c.unconfigured).map((c) => c.studioName)),
  ].sort();

  function prevMonth() {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else setMonth((m) => m + 1);
  }

  if (layout === 'mobile') {
    return (
      <>
        <div inert={mobileNavigation.level === 'details' ? true : undefined}>
          <MobileCalendar
            mode={mobileNavigation.level === 'month' ? 'month' : 'agenda'}
            year={year}
            month={month}
            classes={monthClasses}
            studios={studios}
            colorMap={colorMap}
            studioStats={studioStats}
            selectedDate={mobileNavigation.selectedDate}
            agendaFocusRequest={mobileNavigation.agendaFocusRequest}
            monthFocusRequest={mobileNavigation.monthFocusRequest}
            onPreviousMonth={() => mobileNavigation.changeMonth(prevMonth)}
            onNextMonth={() => mobileNavigation.changeMonth(nextMonth)}
            onOpenAgenda={mobileNavigation.openAgenda}
            onSelectAgendaDate={mobileNavigation.selectAgendaDate}
            onSelectLesson={mobileNavigation.openDetails}
          />
        </div>
        {mobileNavigation.selectedLesson && mobileNavigation.selectedLessonAnchor && (
          <EventDetailsCard
            lesson={mobileNavigation.selectedLesson}
            anchor={mobileNavigation.selectedLessonAnchor}
            presentation="sheet"
            studios={studios}
            canEdit={canEdit}
            onClose={mobileNavigation.closeDetails}
            onReassignStudio={onReassignStudio}
            onPrepareValueEdit={onPrepareValueEdit}
            onSaveValueEdit={onSaveValueEdit}
            onPrepareSeriesStudioEdit={onPrepareSeriesStudioEdit}
            onSaveSeriesStudioEdit={onSaveSeriesStudioEdit}
          />
        )}
      </>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Month switcher */}
      <div className="flex items-center gap-4">
        <button onClick={prevMonth} className="px-3 py-1 rounded hover:bg-gray-100 text-gray-600">
          ‹
        </button>
        <h2 className="text-lg font-semibold w-44 text-center">
          {MONTH_NAMES[month]} {year}
        </h2>
        <button onClick={nextMonth} className="px-3 py-1 rounded hover:bg-gray-100 text-gray-600">
          ›
        </button>
        <span className="ml-4 text-sm text-gray-400">
          {monthClasses.filter((c) => !c.unconfigured).length} classes
          {monthClasses.some((c) => c.unconfigured) && (
            <span className="ml-1 text-gray-300">
              + {monthClasses.filter((c) => c.unconfigured).length} unconfigured
            </span>
          )}
        </span>
      </div>

      {/* Legend */}
      {(configuredStudios.length > 0 || unconfiguredStudios.length > 0) && (
        <div className="flex gap-2 flex-wrap items-center">
          {configuredStudios.map((s) => {
            const c = studioColor(s, colorMap[s]);
            const locations = studioLocations.get(s);
            return (
              <span
                key={s}
                className="text-xs px-2 py-0.5 rounded border inline-flex flex-col"
                style={{
                  backgroundColor: c.backgroundColor,
                  color: c.color,
                  borderColor: c.borderColor,
                }}
              >
                <span>{s}</span>
                {locations && (
                  <span className="text-[10px] opacity-60">{[...locations].sort().join(', ')}</span>
                )}
              </span>
            );
          })}
          {unconfiguredStudios.length > 0 && configuredStudios.length > 0 && (
            <span className="text-gray-200">|</span>
          )}
          {unconfiguredStudios.map((s) => {
            const c = studioColor(s, colorMap[s]);
            return (
              <span
                key={s}
                className="text-xs px-2 py-0.5 flex items-center gap-2 rounded border border-dashed opacity-70"
                style={{
                  backgroundColor: c.backgroundColor,
                  color: c.color,
                  borderColor: c.borderColor,
                }}
                title="No rates configured"
              >
                <span>⚠ {s}</span>
                {onAddStudio && (
                  <button
                    onClick={() => onAddStudio(s)}
                    className="text-[10px] uppercase font-bold text-indigo-500 hover:text-indigo-700 hover:underline"
                    title="Quick add studio config"
                  >
                    Configure
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      <CalendarGrid
        year={year}
        month={month}
        classes={monthClasses}
        studios={studios}
        colorMap={colorMap}
        onSelectLesson={openDesktopDetails}
      />

      {desktopSelected && (
        <EventDetailsCard
          lesson={desktopSelected.lesson}
          anchor={desktopSelected.anchor}
          studios={studios}
          canEdit={canEdit}
          onClose={closeDesktopDetails}
          onReassignStudio={onReassignStudio}
          onPrepareValueEdit={onPrepareValueEdit}
          onSaveValueEdit={onSaveValueEdit}
          onPrepareSeriesStudioEdit={onPrepareSeriesStudioEdit}
          onSaveSeriesStudioEdit={onSaveSeriesStudioEdit}
        />
      )}

      {studioStats.length > 0 && (
        <>
          <div className="flex gap-2 flex-wrap items-center pt-1">
            {studioStats.map(({ key, stats }) => {
              const c = studioColor(key, colorMap[key]);
              return (
                <span
                  key={key}
                  className="text-sm px-3 py-1 rounded border"
                  style={{
                    backgroundColor: c.backgroundColor,
                    color: c.color,
                    borderColor: c.borderColor,
                  }}
                >
                  {key}
                  <span className="mx-1.5 opacity-40">·</span>€{stats.totalAmount.toFixed(2)}
                  <span className="mx-1.5 opacity-40">·</span>
                  avg €{stats.avgPerClass.toFixed(2)}
                </span>
              );
            })}
          </div>
          <div className="text-base font-semibold text-gray-700">
            Total for {MONTH_NAMES[month]}: €
            {studioStats.reduce((sum, { stats }) => sum + stats.totalAmount, 0).toFixed(2)}
          </div>
        </>
      )}
    </div>
  );
}
