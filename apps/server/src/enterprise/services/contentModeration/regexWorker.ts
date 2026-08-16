import { Worker } from 'node:worker_threads';

import { assessRegexSafety, type RegexSafetyResult } from '@/types/platform/contentModeration';

export const REGEX_MATCH_TIMEOUT_MS = 50;
export const REGEX_PROBE_TIMEOUT_MS = 200;
export const REGEX_WORKER_MAX_IN_FLIGHT = 32;

export interface RegexWorkerRule {
  id: string;
  pattern: string;
}

export type MatchRegexRulesResult = { matchedRuleIds: string[] } | { timedOut: true };

interface WorkerRequest {
  digest?: string;
  id: number;
  kind: 'compile' | 'match' | 'probe';
  pattern?: string;
  patterns?: Array<{ flags?: string; id: string; source: string }>;
  text?: string;
}

type WorkerReply =
  { id: number; matchedRuleIds: string[] } | { id: number; ok: boolean; reason?: string };

type PendingResolve = (reply: MatchRegexRulesResult | RegexSafetyResult) => void;

interface PendingJob {
  resolve: PendingResolve;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Inline CommonJS worker source. MUST stay a string: Next standalone
 * bundling must not resolve a separate worker file.
 */
const WORKER_SOURCE = [
  "const { parentPort } = require('node:worker_threads');",
  'const compiledByDigest = new Map();',
  'const WINDOW = 4000;',
  'const OVERLAP = 64;',
  'const PROBE_N = 4000;',
  'const windowsOf = (text) => {',
  '  if (text.length <= WINDOW) return [text];',
  '  const out = [];',
  '  for (let start = 0; start < text.length; start += WINDOW - OVERLAP) {',
  '    out.push(text.slice(start, start + WINDOW));',
  '    if (start + WINDOW >= text.length) break;',
  '  }',
  '  return out;',
  '};',
  'const compileRules = (patterns) => {',
  '  const compiled = [];',
  '  for (const item of patterns || []) {',
  '    try {',
  "      compiled.push({ id: item.id, regex: new RegExp(item.source, item.flags || 'iu') });",
  '    } catch {',
  '      /* skip invalid */',
  '    }',
  '  }',
  '  return compiled;',
  '};',
  'const extractLiterals = (pattern) => {',
  "  let out = '';",
  '  for (let i = 0; i < pattern.length; i += 1) {',
  '    const char = pattern[i];',
  "    if (char === '\\\\') {",
  '      const next = pattern[i + 1];',
  '      if (!next) break;',
  "      if (!'dDsSwWbtnvrf0ckuxpP'.includes(next) && !/[1-9]/.test(next)) out += next;",
  '      i += 1;',
  '      continue;',
  '    }',
  "    if ('^$|.*+?()[]{}'.includes(char)) continue;",
  '    out += char;',
  '  }',
  "  return out || 'a';",
  '};',
  'const probe = (pattern) => {',
  '  let compiled;',
  '  try {',
  "    compiled = new RegExp(pattern, 'iu');",
  '  } catch {',
  "    return { ok: false, reason: 'invalid' };",
  '  }',
  '  const literals = extractLiterals(pattern);',
  '  const padded = literals.repeat(Math.ceil(PROBE_N / literals.length)).slice(0, PROBE_N);',
  "  const samples = [padded, 'a'.repeat(PROBE_N) + '!', '1'.repeat(PROBE_N)];",
  '  for (const sample of samples) {',
  '    compiled.lastIndex = 0;',
  '    compiled.test(sample);',
  '    compiled.lastIndex = 0;',
  '  }',
  '  return { ok: true };',
  '};',
  'parentPort.on("message", (msg) => {',
  '  const id = msg && msg.id;',
  '  try {',
  '    if (msg.kind === "compile") {',
  '      compiledByDigest.set(msg.digest, compileRules(msg.patterns));',
  '      parentPort.postMessage({ id, ok: true });',
  '      return;',
  '    }',
  '    if (msg.kind === "match") {',
  '      let rules = msg.digest ? compiledByDigest.get(msg.digest) : undefined;',
  '      if (!rules) {',
  '        rules = compileRules(msg.patterns);',
  '        if (msg.digest) compiledByDigest.set(msg.digest, rules);',
  '      }',
  '      const matchedRuleIds = [];',
  '      const seen = new Set();',
  "      for (const window of windowsOf(String(msg.text || ''))) {",
  '        for (const rule of rules) {',
  '          if (seen.has(rule.id)) continue;',
  '          rule.regex.lastIndex = 0;',
  '          if (rule.regex.test(window)) {',
  '            seen.add(rule.id);',
  '            matchedRuleIds.push(rule.id);',
  '          }',
  '          rule.regex.lastIndex = 0;',
  '        }',
  '      }',
  '      parentPort.postMessage({ id, matchedRuleIds });',
  '      return;',
  '    }',
  '    if (msg.kind === "probe") {',
  "      const pattern = msg.pattern || (msg.patterns && msg.patterns[0] && msg.patterns[0].source) || '';",
  '      const result = probe(pattern);',
  '      parentPort.postMessage({ id, ok: result.ok, reason: result.reason });',
  '      return;',
  '    }',
  "    parentPort.postMessage({ id, ok: false, reason: 'invalid' });",
  '  } catch {',
  "    parentPort.postMessage({ id, ok: false, reason: 'error', matchedRuleIds: [] });",
  '  }',
  '});',
].join('\n');

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingJob>();

const isTimedOut = (value: unknown): value is { timedOut: true } =>
  Boolean(value && typeof value === 'object' && 'timedOut' in value);

const settleAll = (value: MatchRegexRulesResult | RegexSafetyResult) => {
  const jobs = [...pending.values()];
  pending.clear();
  for (const job of jobs) {
    clearTimeout(job.timer);
    job.resolve(value);
  }
};

const killWorker = () => {
  const dying = worker;
  worker = null;
  if (!dying) return;
  dying.removeAllListeners();
  void dying.terminate();
};

const onWorkerDeath = () => {
  worker = null;
  settleAll({ timedOut: true });
};

const ensureWorker = (): Worker => {
  if (worker) return worker;
  const next = new Worker(WORKER_SOURCE, { eval: true });
  next.on('message', (reply: WorkerReply) => {
    const job = pending.get(reply.id);
    if (!job) return;
    pending.delete(reply.id);
    clearTimeout(job.timer);
    if ('matchedRuleIds' in reply && Array.isArray(reply.matchedRuleIds)) {
      job.resolve({ matchedRuleIds: reply.matchedRuleIds });
      return;
    }
    if ('ok' in reply) {
      job.resolve(reply.ok ? { ok: true } : { ok: false, reason: reply.reason ?? 'slow_probe' });
      return;
    }
    job.resolve({ timedOut: true });
  });
  next.on('error', onWorkerDeath);
  next.on('exit', onWorkerDeath);
  worker = next;
  return next;
};

const runOnWorker = (
  payload: Omit<WorkerRequest, 'id'>,
  timeoutMs: number,
): Promise<MatchRegexRulesResult | RegexSafetyResult> => {
  if (pending.size >= REGEX_WORKER_MAX_IN_FLIGHT) {
    return Promise.resolve({ timedOut: true });
  }

  const id = nextId;
  nextId += 1;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Drop listeners before terminate so the `exit` handler cannot settle twice.
      killWorker();
      settleAll({ timedOut: true });
    }, timeoutMs);

    pending.set(id, { resolve, timer });

    try {
      ensureWorker().postMessage({ ...payload, id });
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      killWorker();
      resolve({ timedOut: true });
    }
  });
};

export const matchRegexRules = async (params: {
  digest: string;
  rules: readonly RegexWorkerRule[];
  text: string;
  timeoutMs?: number;
}): Promise<MatchRegexRulesResult> => {
  if (params.rules.length === 0) return { matchedRuleIds: [] };
  const result = await runOnWorker(
    {
      digest: params.digest,
      kind: 'match',
      patterns: params.rules.map((rule) => ({ flags: 'iu', id: rule.id, source: rule.pattern })),
      text: params.text,
    },
    params.timeoutMs ?? REGEX_MATCH_TIMEOUT_MS,
  );
  if (isTimedOut(result)) return result;
  if ('matchedRuleIds' in result) return result;
  return { timedOut: true };
};

export const probeRegexPattern = async (
  pattern: string,
  options: { timeoutMs?: number } = {},
): Promise<RegexSafetyResult> => {
  const result = await runOnWorker(
    {
      kind: 'probe',
      pattern,
      patterns: [{ flags: 'iu', id: 'probe', source: pattern }],
    },
    options.timeoutMs ?? REGEX_PROBE_TIMEOUT_MS,
  );
  if (isTimedOut(result)) return { ok: false, reason: 'slow_probe' };
  if ('ok' in result) return result;
  return { ok: false, reason: 'slow_probe' };
};

/** Static safety then an interruptible worker probe. */
export const validateKeywordRegex = async (pattern: string): Promise<RegexSafetyResult> => {
  const staticResult = assessRegexSafety(pattern);
  if (!staticResult.ok) return staticResult;
  return probeRegexPattern(pattern);
};

export const resetRegexWorkerForTest = async (): Promise<void> => {
  settleAll({ timedOut: true });
  killWorker();
  nextId = 1;
};
