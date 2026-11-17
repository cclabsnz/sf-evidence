import type { RestClient } from '@cclabsnz/sf-core';

export const LIMITS_PATH = '/limits/';

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `GET /limits/`, refusing any body that is not an object. */
export async function readLimitsBody(rest: RestClient): Promise<Record<string, unknown>> {
  const body = await rest.get<unknown>(LIMITS_PATH);
  if (!isRecord(body)) {
    throw new Error('GET /limits/ returned a body that is not an object; refusing to archive it as a sample.');
  }
  return body;
}

/** `Max` and `Remaining` of one limit, or undefined unless both are numbers. */
export function limitFigures(body: Record<string, unknown>, name: string): { max: number; remaining: number } | undefined {
  const entry = body[name];
  if (!isRecord(entry)) return undefined;
  const { Max, Remaining } = entry;
  return typeof Max === 'number' && typeof Remaining === 'number' ? { max: Max, remaining: Remaining } : undefined;
}
