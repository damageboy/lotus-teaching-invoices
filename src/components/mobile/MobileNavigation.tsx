import { CalendarBlank, ChartBar, FileText, Gear, LockSimple } from '@phosphor-icons/react';

export const APP_TABS = [
  { id: 'calendar', desktopLabel: 'Calendar', mobileLabel: 'Calendar', Icon: CalendarBlank },
  { id: 'invoices', desktopLabel: 'Invoices', mobileLabel: 'Invoices', Icon: FileText },
  { id: 'income', desktopLabel: 'Income', mobileLabel: 'Income', Icon: ChartBar },
  { id: 'rates', desktopLabel: 'Rates & Config', mobileLabel: 'Settings', Icon: Gear },
] as const;

export type AppTab = (typeof APP_TABS)[number]['id'];

interface Props {
  activeTab: AppTab;
  onSelect: (tab: AppTab) => void;
  disabledTabs?: readonly AppTab[];
}

export function MobileNavigation({ activeTab, onSelect, disabledTabs = [] }: Props) {
  return (
    <nav
      aria-label="Mobile navigation"
      className="grid grid-cols-4 border-t border-gray-200 bg-white"
    >
      {APP_TABS.map(({ id, mobileLabel, Icon }) => {
        const active = activeTab === id;
        const disabled = disabledTabs.includes(id);
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!disabled) onSelect(id);
            }}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-12 flex-col items-center justify-center gap-0.5 border-t-2 text-xs disabled:opacity-50 ${
              active
                ? 'border-indigo-600 font-semibold text-indigo-600'
                : 'border-transparent font-medium text-gray-500'
            }`}
          >
            <Icon size={22} aria-hidden="true" />
            {disabled && <LockSimple data-lock size={12} aria-hidden="true" />}
            {mobileLabel}
          </button>
        );
      })}
    </nav>
  );
}
