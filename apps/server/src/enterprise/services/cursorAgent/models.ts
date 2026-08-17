import { createHash } from 'node:crypto';

export interface CursorAgentModel {
  id: string;
  name: string;
}

const MODELS_TTL_MS = 10 * 60 * 1000;
const SUFFIX_RE = / \((?:current|default)\)$/i;

const cache = new Map<string, { expiresAt: number; models: CursorAgentModel[] }>();

export const tokenCacheKey = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Parse `cursor-agent --list-models` stdout. Lines look like
 * `composer-2.5 - Composer 2.5` or `auto - Auto (default)`.
 */
export const parseCursorModelList = (text: string): CursorAgentModel[] => {
  const models: CursorAgentModel[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const separator = line.indexOf(' - ');
    if (separator <= 0) continue;
    const id = line.slice(0, separator);
    if (!id || id.includes(' ') || id.includes('\t')) continue;
    const name = line.slice(separator + 3).replace(SUFFIX_RE, '');
    if (!name) continue;
    models.push({ id, name });
  }
  return models;
};

export const getCachedCursorModels = (
  token: string,
  now = Date.now(),
): CursorAgentModel[] | undefined => {
  const key = tokenCacheKey(token);
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (entry) cache.delete(key);
    return undefined;
  }
  return entry.models;
};

export const setCachedCursorModels = (
  token: string,
  models: CursorAgentModel[],
  now = Date.now(),
): void => {
  cache.set(tokenCacheKey(token), { expiresAt: now + MODELS_TTL_MS, models });
};

/** Test seam only. */
export const resetCursorModelsCache = (): void => {
  cache.clear();
};
