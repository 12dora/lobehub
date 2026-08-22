import debug from 'debug';

import { PlatformSandboxPackageInstallsModel } from '@/database/models/platform/sandboxPackageInstalls';
import type { SandboxPackageInstallManager } from '@/database/schemas/platform/sandboxPackageInstalls';
import type { LobeChatDatabase } from '@/database/type';

const log = debug('lobe-server:sandbox:packageLedger');

/** Unique packages recorded from a single tool invocation (not per regex match). */
export const MAX_PACKAGES_PER_TOOL_CALL = 20;

/** Skip the ledger entirely for oversized tool-call payloads. */
export const MAX_TOOL_CALL_TEXT_CHARS = 64 * 1024;

export const LAST_COMMAND_MAX_CHARS = 300;

const RECORDABLE_TOOLS = new Set(['executeCode', 'execScript', 'runCommand']);

export interface ExtractedPackageInstall {
  command: string;
  manager: SandboxPackageInstallManager;
  package: string;
}

const COMMAND_START_SOURCE =
  '(?:python3?\\s+-m\\s+pip3?\\s+install|uv\\s+pip\\s+install|pipx\\s+install|pip3\\s+install|pip\\s+install|poetry\\s+add|npm\\s+(?:install|i|add)|pnpm\\s+(?:add|install)|yarn\\s+add|apt-get\\s+install|apt\\s+install)\\b';

const FLAGS_WITH_VALUE = new Set([
  '--constraint',
  '--editable',
  '--extra-index-url',
  '--find-links',
  '--index-url',
  '--log',
  '--prefix',
  '--requirement',
  '--root',
  '--src',
  '--target',
  '--trusted-host',
  '-c',
  '-e',
  '-f',
  '-i',
  '-r',
  '-t',
]);

const SKIP_PREFIXES = ['.', '/', 'git+', 'http'];

const managerFromPrefix = (prefix: string): SandboxPackageInstallManager => {
  const lower = prefix.toLowerCase();
  if (lower.includes('npm') || lower.includes('pnpm') || lower.includes('yarn')) return 'npm';
  if (lower.includes('apt')) return 'apt';
  return 'pip';
};

const HEREDOC_START = /<<-?\s*['"]?(\w+)['"]?\s*$/;

const stripHeredocs = (text: string): string => {
  const lines = text.split('\n');
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    const start = HEREDOC_START.exec(line);
    if (start?.[1]) {
      delimiter = start[1];
      kept.push('');
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
};

const isCommentMatch = (text: string, index: number): boolean => {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(lineStart, index);
  return before.includes('#');
};

const isSkippedPath = (token: string): boolean => {
  const lower = token.toLowerCase();
  return SKIP_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

export const normalizeSandboxPackageName = (
  raw: string,
  manager: SandboxPackageInstallManager,
): string | null => {
  let name = raw.trim().replaceAll(/^['"]+|['"]+$/g, '');
  if (!name) return null;
  // Shell leftovers (`2`, `1`, `&1`) and version-only tokens are never package names.
  if (!/^[@A-Z]/i.test(name)) return null;

  if (manager === 'pip') {
    const extraIdx = name.indexOf('[');
    if (extraIdx >= 0) name = name.slice(0, extraIdx);
    name = name.split(/===|==|!=|~=|>=|<=|>|</)[0] ?? name;
    name = name.split(';')[0] ?? name;
    const at = name.indexOf('@');
    if (at > 0) name = name.slice(0, at);
    name = name.trim().toLowerCase().replaceAll('_', '-');
  } else if (manager === 'npm') {
    if (name.startsWith('@')) {
      const secondAt = name.indexOf('@', 1);
      if (secondAt > 0) name = name.slice(0, secondAt);
    } else {
      const at = name.indexOf('@');
      if (at > 0) name = name.slice(0, at);
    }
    name = name.trim().toLowerCase();
  } else {
    name = (name.split('=')[0] ?? name).split('/')[0]?.trim().toLowerCase() ?? '';
  }

  if (!name || name.length > 120) return null;
  if (isSkippedPath(name)) return null;
  if (!/^[a-z0-9@][a-z0-9@+._/-]*$/.test(name)) return null;
  return name;
};

interface Token {
  end: number;
  value: string;
}

const readTokens = (text: string, start: number): Token[] => {
  const tokens: Token[] = [];
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) {
      i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') break;
    if (ch === '#' || ch === ';' || ch === '|') break;
    if (ch === ')' || ch === '(' || ch === ',') break;
    // Redirections end the argument list: `pip install x 2>&1`, `> log`, `< in`.
    if (ch === '<' || ch === '>') break;
    if (/\d/.test(ch) && (text[i + 1] === '>' || text[i + 1] === '<')) break;
    if (ch === '&' && text[i + 1] === '&') break;
    if (ch === '|' && text[i + 1] === '|') break;
    if (ch === '&' && text[i + 1] !== '&') break;

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const close = text.indexOf(quote, i + 1);
      const newline = text.indexOf('\n', i + 1);
      // A wrapping quote from os.system("…") / subprocess spans past this command.
      if (close === -1 || (newline !== -1 && newline < close)) break;
      tokens.push({ end: close + 1, value: text.slice(i + 1, close) });
      i = close + 1;
      continue;
    }

    let j = i;
    while (j < text.length) {
      const c = text[j]!;
      if (/\s/.test(c) || c === ';' || c === '#' || c === ')' || c === '(' || c === ',') break;
      if (c === '"' || c === "'" || c === '|' || c === '&') break;
      if (c === '<' || c === '>') break;
      j += 1;
    }
    if (j === i) break;
    tokens.push({ end: j, value: text.slice(i, j) });
    i = j;
  }
  return tokens;
};

const collectPackages = (
  tokens: Token[],
  manager: SandboxPackageInstallManager,
): { end: number; packages: string[] } => {
  const packages: string[] = [];
  let end = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    end = token.end;
    if (token.value === '--') continue;
    if (token.value.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(token.value.toLowerCase())) {
        const next = tokens[i + 1];
        if (next && !next.value.startsWith('-')) {
          i += 1;
          end = next.end;
        }
      }
      continue;
    }
    if (isSkippedPath(token.value)) continue;
    const normalized = normalizeSandboxPackageName(token.value, manager);
    if (!normalized) continue;
    if (!packages.includes(normalized)) packages.push(normalized);
  }
  return { end, packages };
};

/**
 * Redact secrets from an install command before it is persisted to
 * `last_command`. URL userinfo, query strings, credential flags, index/registry
 * hosts-only, and `NPM_TOKEN=` / `PIP_*=` / `_auth=` assignments.
 */
export const redactInstallCommand = (command: string): string => {
  let out = command.replaceAll(
    /(^|[\s;|&])(NPM_TOKEN|PIP_\w+)=(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1$2=***',
  );
  out = out.replaceAll(/_auth=(?:"[^"]*"|'[^']*'|\S+)/gi, '_auth=***');
  out = out.replaceAll(
    /(^|[\s;|&])(--index-url|--extra-index-url|--registry)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi,
    (_match, pre: string, flag: string, sep: string, value: string) =>
      `${pre}${flag}${sep}${originOnly(value)}`,
  );
  out = out.replaceAll(
    /(^|[\s;|&])(--password|--token|--api-key|-p)(=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1$2$3***',
  );
  out = redactUrls(out);
  return out.length > LAST_COMMAND_MAX_CHARS ? out.slice(0, LAST_COMMAND_MAX_CHARS) : out;
};

const unwrapQuoted = (value: string): string => value.replaceAll(/^['"]+|['"]+$/g, '');

const originOnly = (raw: string): string => {
  const value = unwrapQuoted(raw);
  try {
    return new URL(value).origin;
  } catch {
    return redactUrls(value);
  }
};

const redactUrls = (text: string): string =>
  text
    .replaceAll(/([a-z][a-z0-9+.-]*):\/\/[^/@\s]+@/gi, '$1://***@')
    .replaceAll(/(https?:\/\/[^\s?]+)\?\S*/gi, '$1');

export const extractPackageInstalls = (text: string): ExtractedPackageInstall[] => {
  if (!text || text.length > MAX_TOOL_CALL_TEXT_CHARS) return [];
  const source = stripHeredocs(text);
  const found: ExtractedPackageInstall[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  const matcher = new RegExp(COMMAND_START_SOURCE, 'gi');

  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    if (match.index < cursor) continue;
    if (isCommentMatch(source, match.index)) continue;

    const prefix = match[0]!;
    const manager = managerFromPrefix(prefix);
    const tokens = readTokens(source, match.index + prefix.length);
    const { end, packages } = collectPackages(tokens, manager);
    const commandEnd = Math.max(end, match.index + prefix.length);
    const command = source.slice(match.index, commandEnd).trim().replaceAll(/\s+/g, ' ');
    cursor = commandEnd;
    matcher.lastIndex = cursor;

    for (const pkg of packages) {
      if (found.length >= MAX_PACKAGES_PER_TOOL_CALL) break;
      const key = `${manager}\0${pkg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ command, manager, package: pkg });
    }

    if (found.length >= MAX_PACKAGES_PER_TOOL_CALL) break;
  }

  return found;
};

const sourceTextFromParams = (toolName: string, params: Record<string, unknown>): string => {
  if (toolName === 'executeCode' && typeof params.code === 'string') return params.code;
  if (
    (toolName === 'runCommand' || toolName === 'execScript') &&
    typeof params.command === 'string'
  ) {
    return params.command;
  }
  const parts: string[] = [];
  if (typeof params.command === 'string') parts.push(params.command);
  if (typeof params.code === 'string') parts.push(params.code);
  return parts.join('\n');
};

/**
 * Extract install commands from a sandbox tool invocation and upsert the ledger.
 * Fire-and-forget safe: never throws. Returns the number of unique packages recorded.
 */
export const recordSandboxPackageInstalls = async (
  db: LobeChatDatabase,
  input: { params: Record<string, unknown>; toolName: string; userId?: string },
): Promise<number> => {
  try {
    if (!input.userId) return 0;
    if (!RECORDABLE_TOOLS.has(input.toolName)) return 0;
    const extracted = extractPackageInstalls(sourceTextFromParams(input.toolName, input.params));
    if (extracted.length === 0) return 0;
    return await new PlatformSandboxPackageInstallsModel(db).upsert(
      extracted.map((item) => ({
        lastCommand: redactInstallCommand(item.command),
        manager: item.manager,
        package: item.package,
        userId: input.userId!,
      })),
    );
  } catch (error) {
    log('failed to record sandbox package installs: %O', error);
    return 0;
  }
};
