import { AppConfig } from '../types';

export const DEFAULT_CONFIG: AppConfig = {
  teacher: {
    name: '',
    address: '',
    taxNumber: '',
    bankDetails: {
      accountOwner: '',
      iban: '',
      bic: '',
    },
  },
  calendarUrl:
    'https://calendar.google.com/calendar/ical/ca97afba7cedbe03060b5a536c3637d379c891f93c3afa7b8bae9ec1972552aa%40group.calendar.google.com/private-8a00bedadf09be027a0265c7e8cbb0b1/basic.ics',
  outputDir: '',
  studios: {
    Yogibar: {
      fullName: '',
      address: '',
      rateTiers: [
        { minStudents: 1, maxStudents: 5, rate: 80 },
        { minStudents: 6, maxStudents: 10, rate: 100 },
        { minStudents: 11, maxStudents: null, rate: 120 },
      ],
    },
  },
};
