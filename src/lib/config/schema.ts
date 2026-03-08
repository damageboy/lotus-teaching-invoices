import { z } from 'zod';
import { AppConfig, RateTier, TeacherInfo, AppError } from '../types.js';

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
  const sorted = [...tiers].sort((a, b) => a.minStudents - b.minStudents);

  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i];

    if (tier.maxStudents !== null && tier.maxStudents < tier.minStudents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `tier maxStudents (${tier.maxStudents}) < minStudents (${tier.minStudents})`,
      });
      return;
    }

    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev.maxStudents === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'unbounded tier (maxStudents: null) must be the last tier',
        });
        return;
      }
      if (tier.minStudents !== prev.maxStudents + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gap or overlap between tiers at ${prev.maxStudents} → ${tier.minStudents}`,
        });
        return;
      }
    }

    // Only fail if it's the absolute LAST tier and it is bounded.
    if (i === sorted.length - 1 && tier.maxStudents !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'last tier must be unbounded (maxStudents: null)',
      });
      return;
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
  calendarUrl: z.string().default(''),
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
    calendarUrl: configData.calendarUrl,
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
