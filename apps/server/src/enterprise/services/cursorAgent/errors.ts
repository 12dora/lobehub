/**
 * The Cursor provider talks to Cursor through a spawned `cursor-agent` CLI, not
 * through Node's own fetch. When that CLI is missing the provider is simply
 * unavailable — this is the one stable, actionable error every caller maps onto.
 */
export class CursorAgentUnavailableError extends Error {
  /** Stable machine-readable code; never prose. Matches the JSON error body. */
  readonly code = 'cli_unavailable';
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = 'CursorAgentUnavailableError';
  }
}

/**
 * The request was refused by the transport's own destination policy (scheme, host)
 * BEFORE any process was spawned.
 *
 * The child process is invisible to the enterprise SSRF stack, so this class is the
 * only thing standing between an upstream-controlled URL and an arbitrary spawn.
 * The message names the rule and at most the hostname — never a path, query, or token.
 */
export class CursorAgentPolicyError extends Error {
  readonly code = 'cli_policy';

  constructor(message: string) {
    super(`Cursor Agent transport policy: ${message}`);
    this.name = 'CursorAgentPolicyError';
  }
}

export const isCursorAgentUnavailableError = (
  error: unknown,
): error is CursorAgentUnavailableError => {
  if (error instanceof CursorAgentUnavailableError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'cli_unavailable' &&
    (error as { name?: unknown }).name === 'CursorAgentUnavailableError'
  );
};

export const CURSOR_AGENT_MISSING_MESSAGE = [
  'Cursor Agent CLI was not found.',
  'Set CURSOR_AGENT_HOME to a directory containing index.js and the bundled node binary,',
  'or install cursor-agent on PATH.',
].join(' ');
