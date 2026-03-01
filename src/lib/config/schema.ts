import { AppConfig, RateTier, TeacherInfo, BankDetails, AppError } from "../types.js";

export function validateRateTiers(studioName: string, tiers: RateTier[]): void {
  if (!tiers || tiers.length === 0) {
    throw new AppError(
      `Studio "${studioName}" has no rate tiers defined`,
      "INVALID_CONFIG",
    );
  }

  // Sort by minStudents
  const sorted = [...tiers].sort((a, b) => a.minStudents - b.minStudents);

  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i];

    if (tier.minStudents < 1) {
      throw new AppError(
        `Studio "${studioName}": tier minStudents must be >= 1`,
        "INVALID_CONFIG",
      );
    }

    if (tier.rate <= 0) {
      throw new AppError(
        `Studio "${studioName}": tier rate must be > 0`,
        "INVALID_CONFIG",
      );
    }

    if (tier.maxStudents !== null && tier.maxStudents < tier.minStudents) {
      throw new AppError(
        `Studio "${studioName}": tier maxStudents (${tier.maxStudents}) < minStudents (${tier.minStudents})`,
        "INVALID_CONFIG",
      );
    }

    // Check contiguity: next tier's min should be previous tier's max + 1
    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev.maxStudents === null) {
        throw new AppError(
          `Studio "${studioName}": unbounded tier (maxStudents: null) must be the last tier`,
          "INVALID_CONFIG",
        );
      }
      if (tier.minStudents !== prev.maxStudents + 1) {
        throw new AppError(
          `Studio "${studioName}": gap or overlap between tiers at ${prev.maxStudents} → ${tier.minStudents}`,
          "INVALID_CONFIG",
        );
      }
    }

    // Last tier must be unbounded
    if (i === sorted.length - 1 && tier.maxStudents !== null) {
      throw new AppError(
        `Studio "${studioName}": last tier must be unbounded (maxStudents: null)`,
        "INVALID_CONFIG",
      );
    }
  }
}

export function validateConfig(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new AppError("Config must be an object", "INVALID_CONFIG");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.calendarUrl !== "string" || obj.calendarUrl.length === 0) {
    throw new AppError("Config must have a non-empty calendarUrl string", "INVALID_CONFIG");
  }

  // Parse teacher object (all fields optional, fall back to empty string)
  const teacherRaw = (typeof obj.teacher === 'object' && obj.teacher !== null)
    ? obj.teacher as Record<string, unknown>
    : {};
  const bankRaw = (typeof teacherRaw.bankDetails === 'object' && teacherRaw.bankDetails !== null)
    ? teacherRaw.bankDetails as Record<string, unknown>
    : {};

  const teacher: TeacherInfo = {
    name:       typeof teacherRaw.name      === 'string' ? teacherRaw.name      : '',
    address:    typeof teacherRaw.address   === 'string' ? teacherRaw.address   : '',
    taxNumber:  typeof teacherRaw.taxNumber === 'string' ? teacherRaw.taxNumber : '',
    bankDetails: {
      accountOwner: typeof bankRaw.accountOwner === 'string' ? bankRaw.accountOwner : '',
      iban:         typeof bankRaw.iban         === 'string' ? bankRaw.iban         : '',
      bic:          typeof bankRaw.bic          === 'string' ? bankRaw.bic          : '',
    },
  };

  const outputDir = typeof obj.outputDir === 'string' ? obj.outputDir : '';

  if (typeof obj.studios !== "object" || obj.studios === null || Array.isArray(obj.studios)) {
    throw new AppError("Config must have a studios object", "INVALID_CONFIG");
  }

  const studios = obj.studios as Record<string, unknown>;
  if (Object.keys(studios).length === 0) {
    throw new AppError("Config must have at least one studio", "INVALID_CONFIG");
  }

  const config: AppConfig = {
    teacher,
    calendarUrl: obj.calendarUrl,
    outputDir,
    studios: {},
  };

  for (const [name, studioRaw] of Object.entries(studios)) {
    if (typeof studioRaw !== "object" || studioRaw === null) {
      throw new AppError(`Studio "${name}" must be an object`, "INVALID_CONFIG");
    }

    const studio = studioRaw as Record<string, unknown>;
    if (!Array.isArray(studio.rateTiers)) {
      throw new AppError(`Studio "${name}" must have a rateTiers array`, "INVALID_CONFIG");
    }

    const tiers: RateTier[] = studio.rateTiers.map((t: unknown, i: number) => {
      if (typeof t !== "object" || t === null) {
        throw new AppError(`Studio "${name}" tier ${i} must be an object`, "INVALID_CONFIG");
      }
      const tier = t as Record<string, unknown>;
      return {
        minStudents: Number(tier.minStudents),
        maxStudents: tier.maxStudents === null || tier.maxStudents === undefined
          ? null
          : Number(tier.maxStudents),
        rate: Number(tier.rate),
      };
    });

    validateRateTiers(name, tiers);

    // Store sorted tiers
    config.studios[name] = {
      fullName: typeof studio.fullName === 'string' ? studio.fullName : '',
      address:  typeof studio.address  === 'string' ? studio.address  : '',
      rateTiers: tiers.sort((a, b) => a.minStudents - b.minStudents),
    };
  }

  return config;
}
