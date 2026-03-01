import { AppError } from "../types.js";

export async function fetchCalendar(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new AppError(
      `Failed to fetch calendar: ${(err as Error).message}`,
      "FETCH_FAILED",
    );
  }

  if (!response.ok) {
    throw new AppError(
      `Calendar fetch returned HTTP ${response.status}`,
      "FETCH_FAILED",
    );
  }

  return response.text();
}
