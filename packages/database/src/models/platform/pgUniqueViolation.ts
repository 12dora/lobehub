export const isUniqueViolation = (error: unknown): boolean => {
  const candidates: unknown[] = [error];
  if (error && typeof error === 'object') {
    const e = error as { cause?: unknown; originalError?: unknown };
    if (e.cause) candidates.push(e.cause);
    if (e.originalError) candidates.push(e.originalError);
    // drizzle-orm often nests: Error { cause: DatabaseError { code: '23505' } }
    if (e.cause && typeof e.cause === 'object' && 'cause' in e.cause) {
      candidates.push((e.cause as { cause?: unknown }).cause);
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const code = 'code' in candidate ? String((candidate as { code?: unknown }).code) : '';
    // Postgres unique_violation
    if (code === '23505') return true;
    const message =
      candidate instanceof Error
        ? candidate.message
        : 'message' in candidate
          ? String((candidate as { message?: unknown }).message)
          : '';
    if (/unique|duplicate|already exists/i.test(message)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /unique|duplicate|already exists|platform_global_credentials_key_unique/i.test(message);
};
