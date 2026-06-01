import { AppConfig, ParsedClass } from '../types.js';
import { computeStudioStats } from '../invoice/calculator.js';
import { effectiveHex } from '../studioColors.js';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export interface IncomeStudioSegment {
  studioName: string;
  total: number;
  color: string;
}

export interface IncomeMonth {
  monthIndex: number;
  monthName: string;
  total: number;
  studios: IncomeStudioSegment[];
  yoyPercent: number | null;
  yoyLabel: string;
}

export interface IncomeReport {
  year: number;
  months: IncomeMonth[];
  yearTotal: number;
  maxMonthTotal: number;
}

function monthKey(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildIncomeYears(classes: ParsedClass[], today: string = todayKey()): number[] {
  const years = new Set<number>();
  for (const cls of classes) {
    if (cls.unconfigured || cls.date > today) continue;
    years.add(Number(cls.date.slice(0, 4)));
  }
  return [...years].sort((a, b) => b - a);
}

function monthlyStudioTotals(
  classes: ParsedClass[],
  config: AppConfig,
  year: number
): Map<number, IncomeStudioSegment[]> {
  const byMonth = new Map<number, IncomeStudioSegment[]>();
  for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
    const prefix = monthKey(year, monthIndex);
    const segments = Object.entries(config.studios)
      .map(([studioName, studioConfig]) => {
        const studioClasses = classes.filter(
          (cls) => cls.studioName === studioName && cls.date.startsWith(prefix) && !cls.unconfigured
        );
        const stats = computeStudioStats(studioClasses, studioConfig.rateTiers);
        return {
          studioName,
          total: stats.totalAmount,
          color: effectiveHex(studioName, studioConfig.color),
        };
      })
      .filter((segment) => segment.total > 0);
    byMonth.set(monthIndex, segments);
  }
  return byMonth;
}

export function buildIncomeReport(
  classes: ParsedClass[],
  config: AppConfig,
  year: number
): IncomeReport {
  const currentYear = new Date().getFullYear();
  const currentTotals = monthlyStudioTotals(classes, config, year);
  const previousTotals = monthlyStudioTotals(classes, config, year - 1);

  const months = MONTH_NAMES.map((monthName, monthIndex) => {
    const studios = currentTotals.get(monthIndex) ?? [];
    const total = studios.reduce((sum, segment) => sum + segment.total, 0);
    const previousTotal =
      previousTotals.get(monthIndex)?.reduce((sum, segment) => sum + segment.total, 0) ?? 0;
    const yoyPercent =
      year === currentYear && previousTotal > 0
        ? Math.round(((total - previousTotal) / previousTotal) * 100)
        : null;
    return {
      monthIndex,
      monthName,
      total,
      studios,
      yoyPercent,
      yoyLabel: yoyPercent === null ? 'n/a' : `${yoyPercent >= 0 ? '+' : ''}${yoyPercent}%`,
    };
  });

  return {
    year,
    months,
    yearTotal: months.reduce((sum, month) => sum + month.total, 0),
    maxMonthTotal: Math.max(0, ...months.map((month) => month.total)),
  };
}
