import {
  DEFAULT_UPSTREAM_REF,
  DEFAULT_UPSTREAM_REPOSITORY,
  OFFICIAL_GITHUB_HOST,
  type ValidatedUpstreamInput,
  validatedUpstreamInputSchema,
} from './contract';

const hasUnsafeControlCharacter = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });

const FORBIDDEN_INPUT_SUBSTRINGS = [
  '://',
  '@',
  ' ',
  '\t',
  '`',
  '$',
  ';',
  '|',
  '&',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '\\',
  '\n',
  '\r',
  '"',
  "'",
] as const;

/**
 * Accept only an official GitHub owner/name slug (never an arbitrary URL).
 * Builds a credential-free HTTPS fetch URL deterministically.
 */
export const validateUpstreamRepository = (value: string | undefined): string => {
  const repository = (value ?? DEFAULT_UPSTREAM_REPOSITORY).trim();
  if (!repository || repository.length > 200 || hasUnsafeControlCharacter(repository)) {
    throw new Error('Upstream repository input is invalid');
  }
  for (const fragment of FORBIDDEN_INPUT_SUBSTRINGS) {
    if (repository.includes(fragment)) {
      throw new Error('Upstream repository must be owner/name without URL or shell characters');
    }
  }
  if (repository.includes('..')) {
    throw new Error('Upstream repository must not contain path traversal');
  }
  if (/\.git$/iu.test(repository) || repository.includes(':')) {
    throw new Error(
      'Upstream repository must be owner/name without .git suffix or URL credentials',
    );
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw new Error('Upstream repository must match owner/name');
  }
  return repository;
};

/**
 * Accept only a safe git ref token (branch, tag, or hex SHA). No shell metacharacters.
 */
export const validateUpstreamRef = (value: string | undefined): string => {
  const ref = (value ?? DEFAULT_UPSTREAM_REF).trim();
  if (!ref || ref.length > 256 || hasUnsafeControlCharacter(ref)) {
    throw new Error('Upstream ref input is invalid');
  }
  for (const fragment of FORBIDDEN_INPUT_SUBSTRINGS) {
    if (ref.includes(fragment)) {
      throw new Error('Upstream ref must not contain URL, credentials, or shell characters');
    }
  }
  if (ref.includes('..') || ref.startsWith('-') || ref.endsWith('.') || ref.includes('//')) {
    throw new Error('Upstream ref is not a safe git ref');
  }
  if (!/^[A-Za-z0-9][\w./-]*$/u.test(ref)) {
    throw new Error('Upstream ref contains unsupported characters');
  }
  return ref;
};

export const buildOfficialFetchUrl = (repository: string): string => {
  const validatedRepository = validateUpstreamRepository(repository);
  return `https://${OFFICIAL_GITHUB_HOST}/${validatedRepository}.git`;
};

export const validateUpstreamInputs = (options: {
  ref?: string;
  repository?: string;
}): ValidatedUpstreamInput => {
  const repository = validateUpstreamRepository(options.repository);
  const ref = validateUpstreamRef(options.ref);
  return validatedUpstreamInputSchema.parse({
    fetchUrl: buildOfficialFetchUrl(repository),
    ref,
    repository,
  });
};
