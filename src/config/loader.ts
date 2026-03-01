import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { AppConfig, AppError } from "../types.js";
import { validateConfig } from "./schema.js";

export function loadConfig(filePath: string): AppConfig {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new AppError(
      `Cannot read config file: ${filePath}`,
      "CONFIG_NOT_FOUND",
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new AppError(
      `Invalid YAML in config file: ${(err as Error).message}`,
      "INVALID_CONFIG",
    );
  }

  return validateConfig(raw);
}
