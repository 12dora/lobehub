import { SkillCatalogInvalidCursorError } from './errors';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const encodeCursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export const decodeCursor = <T>(
  cursor: string | undefined,
  guard: (value: unknown) => value is T,
) => {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!guard(value)) throw new SkillCatalogInvalidCursorError();
    return value;
  } catch (error) {
    if (error instanceof SkillCatalogInvalidCursorError) throw error;
    throw new SkillCatalogInvalidCursorError();
  }
};

export const parseVersionCursor = (cursor?: string) => {
  const decoded = decodeCursor(cursor, (value): value is { createdAt: string; id: string } =>
    Boolean(
      isRecord(value) &&
      typeof value.createdAt === 'string' &&
      !Number.isNaN(new Date(value.createdAt).getTime()) &&
      typeof value.id === 'string' &&
      value.id.length > 0,
    ),
  );
  return decoded ? { createdAt: new Date(decoded.createdAt), id: decoded.id } : undefined;
};

export const parseDependentCursor = (cursor?: string) =>
  decodeCursor(
    cursor,
    (
      value,
    ): value is {
      id: string;
      key: string;
      type: 'agent' | 'skill';
      version: string;
    } =>
      Boolean(
        isRecord(value) &&
        typeof value.id === 'string' &&
        typeof value.key === 'string' &&
        (value.type === 'agent' || value.type === 'skill') &&
        typeof value.version === 'string',
      ),
  );
