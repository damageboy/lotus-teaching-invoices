import type { IncomeReport } from '../../lib/income/report';

export interface IncomeLegendItem {
  studioName: string;
  color: string;
}

interface Props {
  report: IncomeReport;
  legend: IncomeLegendItem[];
  year: number;
  yearOptions: number[];
  onSelectYear: (year: number) => void;
}

const FULL_MONTH_NAMES = [
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

function formatEuro(amount: number): string {
  return `€${amount.toFixed(2)}`;
}

function yoyClasses(yoyPercent: number | null): string {
  if (yoyPercent === null) return 'border-gray-300 bg-gray-50 text-gray-500';
  if (yoyPercent < 0) return 'border-red-200 bg-red-50 text-red-700';
  return 'border-emerald-200 bg-emerald-50 text-emerald-700';
}

export function MobileIncome({ report, legend, year, yearOptions, onSelectYear }: Props) {
  const yAxisMax = Math.max(100, Math.ceil(report.maxMonthTotal / 500) * 500);

  return (
    <div className="min-w-0 p-4 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Income</h2>
          <p className="text-sm text-gray-500">Monthly studio income for {year}</p>
        </div>
        <select
          value={year}
          onChange={(event) => onSelectYear(Number(event.target.value))}
          className="min-h-12 rounded border border-gray-300 bg-white px-3 text-base text-gray-800"
          aria-label="Income year"
        >
          {yearOptions.map((optionYear) => (
            <option key={optionYear} value={optionYear}>
              {optionYear}
            </option>
          ))}
        </select>
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
        <div>
          <dt className="text-gray-500">Annual total</dt>
          <dd className="mt-1 font-semibold text-gray-900">{formatEuro(report.yearTotal)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Maximum month</dt>
          <dd className="mt-1 font-semibold text-gray-900">{formatEuro(report.maxMonthTotal)}</dd>
        </div>
      </dl>

      <section aria-label="Monthly income" className="flex min-w-0 flex-col gap-3">
        {report.months.map((month) => {
          const outerWidth = (month.total / yAxisMax) * 100;
          return (
            <article
              key={month.monthName}
              className="rounded-lg border border-gray-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium text-gray-900">
                    {FULL_MONTH_NAMES[month.monthIndex]}
                  </h3>
                  <p className="mt-0.5 font-semibold text-gray-900">{formatEuro(month.total)}</p>
                </div>
                <span
                  className={`rounded-full border px-2 py-1 text-xs font-medium ${yoyClasses(
                    month.yoyPercent
                  )}`}
                >
                  {month.yoyLabel}
                </span>
              </div>

              <div
                className="mt-3 h-4 overflow-hidden rounded bg-gray-100"
                data-empty={month.total === 0 || undefined}
                aria-label={`${FULL_MONTH_NAMES[month.monthIndex]} income bar`}
              >
                {month.total > 0 && (
                  <div className="flex h-full" style={{ width: `${outerWidth}%` }}>
                    {month.studios.map((segment) => (
                      <span
                        key={segment.studioName}
                        className="h-full"
                        style={{
                          width: `${(segment.total / month.total) * 100}%`,
                          backgroundColor: segment.color,
                        }}
                        title={`${segment.studioName}: ${formatEuro(segment.total)}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </section>

      <div
        aria-label="Studio legend"
        className="flex flex-wrap items-center gap-3 text-sm text-gray-600"
      >
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
