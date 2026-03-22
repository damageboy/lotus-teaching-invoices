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
  outputDir: '',
  lastInvoice: '',
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
