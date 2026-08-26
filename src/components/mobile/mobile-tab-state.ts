import type { AppTab } from './MobileNavigation.js';

export interface MobileTabState {
  activeTab: AppTab;
  calendarActivation: number;
}

export const initialMobileTabState: MobileTabState = {
  activeTab: 'calendar',
  calendarActivation: 0,
};

export function selectMobileTab(state: MobileTabState, tab: AppTab): MobileTabState {
  return {
    activeTab: tab,
    calendarActivation: state.calendarActivation + (tab === 'calendar' ? 1 : 0),
  };
}
