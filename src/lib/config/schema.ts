import { z } from 'zod';
import { AppConfig, RateTier, TeacherInfo, AppError } from '../types.js';
import { getRateTierValidation } from './rateTiers.js';

const RateTierSchema = z.object({
  minStudents: z
    .number({ required_error: 'rate tier must be an object' })
    .int()
    .min(1, 'tier minStudents must be >= 1'),
  maxStudents: z
    .number()
    .int()
    .nullable()
    .default(null)
    .transform((v: number | null | undefined) => (v === undefined ? null : v)),
  rate: z.number().positive('tier rate must be > 0'),
});

const validateContiguity = (tiers: RateTier[], ctx: z.RefinementCtx) => {
  const validation = getRateTierValidation(tiers);
  for (let i = 0; i < validation.tierErrors.length; i++) {
    const errors = validation.tierErrors[i];
    if (errors.minStudents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'minStudents'],
        message:
          errors.minStudents === 'First tier must start at 1 student'
            ? 'first tier must start at 1 student'
            : errors.minStudents.startsWith('Must be ') && tiers[i - 1]?.maxStudents !== undefined
              ? `gap or overlap between tiers at ${tiers[i - 1].maxStudents} → ${tiers[i].minStudents}`
              : errors.minStudents,
      });
    }
    if (errors.maxStudents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'maxStudents'],
        message:
          errors.maxStudents === 'Last tier must be unbounded'
            ? 'last tier must be unbounded (maxStudents: null)'
            : errors.maxStudents === 'Only the last tier can have no maximum'
              ? 'unbounded tier (maxStudents: null) must be the last tier'
              : errors.maxStudents,
      });
    }
    if (errors.rate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'rate'],
        message: errors.rate,
      });
    }
  }
};

const BankDetailsSchema = z
  .object({
    accountOwner: z.string().default(''),
    iban: z.string().default(''),
    bic: z.string().default(''),
  })
  .default({});

const TeacherInfoSchema = z
  .object({
    name: z.string().default(''),
    address: z.string().default(''),
    taxNumber: z.string().default(''),
    bankDetails: BankDetailsSchema,
  })
  .default({});

const StudioConfigSchema = z.object({
  fullName: z.string().default(''),
  address: z.string().default(''),
  invoiceEmail: z
    .string()
    .default('')
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'invoiceEmail must be a valid email address or empty',
    }),
  rateTiers: z
    .array(RateTierSchema, { required_error: 'must have a rateTiers array' })
    .min(1, 'has no rate tiers defined')
    .superRefine(validateContiguity),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex string e.g. #7c3aed')
    .optional(),
});

const ConfigSchema = z.object({
  teacher: TeacherInfoSchema,
  calendarId: z.string().optional(),
  calendarName: z.string().optional(),
  calendarUrl: z.string().optional(),
  outputDir: z.string().default(''),
  lastInvoice: z
    .string()
    .default('')
    .refine((v) => v === '' || /^\d+\/\d{4}$/.test(v), {
      message: 'lastInvoice must be in N/YYYY format or empty',
    }),
  studios: z
    .record(StudioConfigSchema, { required_error: 'Config must have a studios object' })
    .refine(
      (record: Record<string, any>) => Object.keys(record).length > 0,
      'Config must have at least one studio'
    ),
});

function extractCalendarIdFromLegacyUrl(calendarUrl: string | undefined): string | undefined {
  if (!calendarUrl) return undefined;

  try {
    const url = new URL(calendarUrl);
    if (url.hostname !== 'calendar.google.com') return undefined;

    const parts = url.pathname.split('/').filter(Boolean);
    const icalIndex = parts.indexOf('ical');
    const encodedCalendarId = parts[icalIndex + 1];
    if (icalIndex === -1 || !encodedCalendarId) return undefined;

    return decodeURIComponent(encodedCalendarId);
  } catch {
    return undefined;
  }
}

export function validateConfig(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AppError('Config must be an object', 'INVALID_CONFIG');
  }

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const error = result.error.errors[0];
    let message = error.message;
    if (error.path.length > 0) {
      if (error.path[0] === 'studios' && error.path[1]) {
        message = `Studio "${error.path[1]}" ${message.replace('has no', 'has no').replace('must have', 'must have')}`;
        const issueMsg = error.message;

        if (error.path.length > 2 && error.path[2] === 'rateTiers') {
          message = `Studio "${error.path[1]}": ${issueMsg}`;
          if (
            error.path[3] !== undefined &&
            (issueMsg.includes('object') || issueMsg.includes('Number'))
          ) {
            message = `Studio "${error.path[1]}" tier ${error.path[3]} must be an object`;
          }
        } else if (!message.includes('Studio')) {
          message = `Studio "${error.path[1]}": ${issueMsg}`;
        }
      }
    }
    throw new AppError(message, 'INVALID_CONFIG');
  }

  const configData = result.data;
  const config: AppConfig = {
    teacher: configData.teacher as TeacherInfo,
    calendarId: configData.calendarId ?? extractCalendarIdFromLegacyUrl(configData.calendarUrl),
    calendarName: configData.calendarName,
    outputDir: configData.outputDir,
    lastInvoice: configData.lastInvoice,
    studios: {},
  };

  for (const [name, studioRaw] of Object.entries(configData.studios)) {
    const studio = studioRaw as any;
    const sortedTiers = [...studio.rateTiers].sort(
      (a: any, b: any) => a.minStudents - b.minStudents
    );
    config.studios[name] = {
      ...studio,
      rateTiers: sortedTiers,
      color: studio.color,
    };
  }

  return config;
}
