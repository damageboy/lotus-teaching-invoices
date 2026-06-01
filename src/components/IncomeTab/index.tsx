import { useMemo, useState } from 'react';
import { AppConfig, ParsedClass } from '../../lib/types';
import { buildIncomeReport, buildIncomeYears } from '../../lib/income/report';
import { effectiveHex } from '../../lib/studioColors';

interface Props {
  classes: ParsedClass[];
  config: AppConfig;
}

function formatEuro(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

function yoyClasses(yoyPercent: number | null): string {
  if (yoyPercent === null) return 'border-gray-300 bg-gray-50 text-gray-500';
  if (yoyPercent < 0) return 'border-red-200 bg-red-50 text-red-700';
  return 'border-emerald-200 bg-emerald-50 text-emerald-700';
}

export function IncomeTab({ classes, config }: Props) {
  const currentYear = new Date().getFullYear();
  const availableYears = useMemo(() => buildIncomeYears(classes), [classes]);
  const yearOptions = availableYears.length > 0 ? availableYears : [currentYear];
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const year =
    selectedYear !== null && yearOptions.includes(selectedYear) ? selectedYear : yearOptions[0];
  const report = useMemo(() => buildIncomeReport(classes, config, year), [classes, config, year]);
  const yAxisMax = Math.max(100, Math.ceil(report.maxMonthTotal / 500) * 500);
  const legend = Object.entries(config.studios).map(([studioName, studio]) => ({
    studioName,
    color: effectiveHex(studioName, studio.color),
  }));

  return (
    <div className="p-4 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Monthly Income</h2>
          <p className="text-sm text-gray-500">Stacked by studio · January to December {year}</p>
        </div>
        <select
          value={year}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
          className="text-sm rounded border border-gray-300 bg-white px-3 py-1.5 text-gray-800"
          aria-label="Income year"
        >
          {yearOptions.map((optionYear) => (
            <option key={optionYear} value={optionYear}>
              {optionYear}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-4 text-sm">
        <div className="font-semibold text-gray-800">Total: {formatEuro(report.yearTotal)}</div>
        <div className="text-gray-400">Max month: {formatEuro(report.maxMonthTotal)}</div>
      </div>

      <div className="min-w-[760px]">
        <div className="grid grid-cols-[3.25rem_1fr] gap-3">
          <div className="h-80 flex flex-col justify-between items-end pb-8 text-xs text-gray-400">
            <span>{formatEuro(yAxisMax)}</span>
            <span>{formatEuro(yAxisMax * 0.66)}</span>
            <span>{formatEuro(yAxisMax * 0.33)}</span>
            <span>€0</span>
          </div>

          <div>
            <div
              className="h-80 grid grid-cols-12 gap-2 items-end border-l border-b border-gray-300 px-3 pt-8"
              style={{
                background:
                  'repeating-linear-gradient(to top, #ffffff 0, #ffffff 78px, #f3f4f6 79px)',
              }}
            >
              {report.months.map((month) => {
                const height = report.maxMonthTotal === 0 ? 0 : (month.total / yAxisMax) * 100;
                let cumulative = 0;
                return (
                  <div
                    key={month.monthName}
                    className="relative h-full flex items-end justify-center"
                    title={`${month.monthName}: ${formatEuro(month.total)}`}
                  >
                    <span
                      className={`absolute left-1/2 -translate-x-1/2 top-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap ${yoyClasses(
                        month.yoyPercent
                      )}`}
                    >
                      {month.yoyLabel}
                    </span>
                    <div className="relative w-full max-w-10" style={{ height: `${height}%` }}>
                      {month.studios.map((segment) => {
                        const segmentHeight =
                          month.total === 0 ? 0 : (segment.total / month.total) * 100;
                        const bottom = cumulative;
                        cumulative += segmentHeight;
                        return (
                          <div
                            key={segment.studioName}
                            className="absolute left-0 right-0"
                            style={{
                              bottom: `${bottom}%`,
                              height: `${segmentHeight}%`,
                              backgroundColor: segment.color,
                            }}
                            title={`${segment.studioName}: ${formatEuro(segment.total)}`}
                          />
                        );
                      })}
                      {month.total > 0 && (
                        <div className="absolute inset-x-0 top-0 h-full rounded-t border border-black/5 pointer-events-none" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-12 gap-2 px-3 pt-2 text-center text-xs text-gray-600">
              {report.months.map((month) => (
                <span key={month.monthName}>{month.monthName}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
        {legend.map((studio) => (
          <span key={studio.studioName} className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: studio.color }} />
            {studio.studioName}
          </span>
        ))}
      </div>
    </div>
  );
}
