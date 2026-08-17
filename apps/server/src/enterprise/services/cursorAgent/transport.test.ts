// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { PassThrough } from 'node:stream';

import { CURSOR_CONVERSATION_HEADER, LobeCursorAI } from '@lobechat/model-runtime';
import { deriveCursorConversationId } from '@lobechat/model-runtime/browserProfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CURSOR_AGENT_INSTANCE_ID_ENV, CURSOR_AGENT_STATE_DIR_ENV } from './env';
import { CursorAgentPolicyError } from './errors';
import { resetCursorModelsCache } from './models';
import { CURSOR_AGENT_HOME_ENV, resetCursorCliCache } from './resolveCli';
import { createCursorAgentFetch, resetCursorAgentFetch } from './transport';

const { join } = nodePath;

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

/**
 * Sample from explore/cursor-sandbox/print-stream.jsonl (the one allowed print-mode run).
 * Session ids are not secrets; they are not the access token.
 */
const PRINT_STREAM_JSONL = [
  '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/sandbox","session_id":"e22f36ab-002e-4067-8a49-f6b5ccc38b24","model":"Composer 2.5","permissionMode":"default"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with the single word pong"}]},"session_id":"e22f36ab-002e-4067-8a49-f6b5ccc38b24"}',
  '{"type":"thinking","subtype":"delta","text":"The user requested a","session_id":"e22f36ab-002e-4067-8a49-f6b5ccc38b24","timestamp_ms":1786975512483}',
  '{"type":"thinking","subtype":"completed","session_id":"e22f36ab-002e-4067-8a49-f6b5ccc38b24","timestamp_ms":1786975512484}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]},"session_id":"e22f36ab-002e-4067-8a49-f6b5ccc38b24"}',
  '{"type":"result","subtype":"success","duration_ms":5398,"duration_api_ms":5398,"is_error":false,"result":"pong","session_id":"e22f36ab-002e-4067-8a49-f6b5ccc38b24","request_id":"e330e9a0-d4b2-4a42-81f5-fa473c027e92","usage":{"inputTokens":7175,"outputTokens":39,"cacheReadTokens":6048,"cacheWriteTokens":0}}',
].join('\n');

const TOKEN = 'test-cursor-session-jwt';
const AUTH = { authorization: `Bearer ${TOKEN}` };

type FakeChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stderr: PassThrough;
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  stdout: PassThrough;
};

const makeFakeChild = (): FakeChild => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as FakeChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn(() => {
    stdout.end();
    stderr.end();
    setImmediate(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const emitThenClose = (child: FakeChild, stdout: string, code = 0, stderr = '') => {
  setImmediate(() => {
    if (stdout) child.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code));
  });
};

const readSse = async (response: Response): Promise<string[]> => {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => block.replace(/^data: /, ''))
    .filter((line) => line.length > 0);
};

const turnBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    history: {
      messages: [
        { user: { content: [{ text: { text: 'ping' } }] } },
        { assistant: { content: [{ text: { text: 'pong' } }] } },
      ],
      replaceUserInfo: false,
    },
    model: 'composer-2.5',
    prompt: 'Reply with the single word pong',
    ...overrides,
  });

let dir: string;
let home: string;
let stateDir: string;
let cursorFetch: typeof fetch;
const previousHome = process.env[CURSOR_AGENT_HOME_ENV];
const previousState = process.env[CURSOR_AGENT_STATE_DIR_ENV];
const previousInstance = process.env[CURSOR_AGENT_INSTANCE_ID_ENV];
const previousSecret = process.env.DATABASE_URL;
const INSTANCE_HOME = 'home-test-instance';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cursor-transport-'));
  home = join(dir, 'cli');
  stateDir = join(dir, 'state');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(home, 'node'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(home, 'node'), 0o755);

  process.env[CURSOR_AGENT_HOME_ENV] = home;
  process.env[CURSOR_AGENT_STATE_DIR_ENV] = stateDir;
  process.env[CURSOR_AGENT_INSTANCE_ID_ENV] = 'test-instance';
  process.env.DATABASE_URL = 'postgres://should-not-leak';
  resetCursorCliCache();
  resetCursorModelsCache();
  resetCursorAgentFetch();
  spawnMock.mockReset();
  cursorFetch = createCursorAgentFetch({
    maxConcurrency: 4,
    queueTimeoutMs: 60_000,
    turnTimeoutMs: 5_000,
  });
});

afterEach(() => {
  resetCursorCliCache();
  resetCursorModelsCache();
  resetCursorAgentFetch();
  if (previousHome === undefined) delete process.env[CURSOR_AGENT_HOME_ENV];
  else process.env[CURSOR_AGENT_HOME_ENV] = previousHome;
  if (previousState === undefined) delete process.env[CURSOR_AGENT_STATE_DIR_ENV];
  else process.env[CURSOR_AGENT_STATE_DIR_ENV] = previousState;
  if (previousInstance === undefined) delete process.env[CURSOR_AGENT_INSTANCE_ID_ENV];
  else process.env[CURSOR_AGENT_INSTANCE_ID_ENV] = previousInstance;
  if (previousSecret === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousSecret;
  rmSync(dir, { force: true, recursive: true });
});

describe('createCursorAgentFetch policy', () => {
  it('refuses anything that is not https://cursor.local/*', async () => {
    await expect(cursorFetch('https://example.com/v1/models', { headers: AUTH })).rejects.toThrow(
      CursorAgentPolicyError,
    );
  });

  it('returns 401 when the bearer token is missing', async () => {
    const response = await cursorFetch('https://cursor.local/v1/models');
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'unauthorized', message: 'missing bearer token' },
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('GET /v1/models', () => {
  it('parses id/name lines, strips (default), and caches for 10 minutes', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(
        child,
        ['Available models', 'auto - Auto (default)', 'composer-2.5 - Composer 2.5', ''].join('\n'),
      );
      return child;
    });

    const first = await cursorFetch('https://cursor.local/v1/models', { headers: AUTH });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      models: [
        { id: 'auto', name: 'Auto' },
        { id: 'composer-2.5', name: 'Composer 2.5' },
      ],
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--use-system-ca', join(home, 'index.js'), '--list-models']),
    );

    const second = await cursorFetch('https://cursor.local/v1/models', { headers: AUTH });
    expect(second.status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const other = await cursorFetch('https://cursor.local/v1/models', {
      headers: { authorization: 'Bearer other-token' },
    });
    expect(other.status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('returns 401 when a non-zero exit looks like auth failure', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(child, '', 1, 'Error: not logged in. Please log in.');
      return child;
    });

    const response = await cursorFetch('https://cursor.local/v1/models', { headers: AUTH });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).not.toContain(TOKEN);
  });

  it('returns 503 cli_error for other non-zero exits', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(child, '', 2, 'boom: workspace exploded');
      return child;
    });

    const response = await cursorFetch('https://cursor.local/v1/models', { headers: AUTH });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'cli_error' } });
  });

  it('uses isolated model-list config seeded from and copied back to the shared allowlist', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
      join(seedDir, 'cli-config.json'),
      JSON.stringify({ privacyCache: { ghostMode: false }, seeded: true }),
    );
    writeFileSync(join(seedDir, 'statsig-cache.json'), '{"before":true}');
    writeFileSync(join(seedDir, 'chats.json'), '{"must":"stay-out"}');

    let scratchRoot = '';
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { cwd: string; env: Record<string, string> }) => {
        scratchRoot = opts.cwd;
        expect(opts.env.HOME).toBe(join(stateDir, INSTANCE_HOME));
        expect(opts.env.CURSOR_DATA_DIR).toBe(join(scratchRoot, 'data'));
        expect(opts.env.CURSOR_CONFIG_DIR).toBe(join(scratchRoot, 'config'));
        expect(opts.env.CURSOR_PROJECTS_DIR).toBe(join(scratchRoot, 'projects'));
        expect(fs.readdirSync(opts.env.CURSOR_CONFIG_DIR).sort()).toEqual([
          'cli-config.json',
          'statsig-cache.json',
        ]);
        // The persistent seed is passed through untouched — ghost mode is pinned only
        // when a seed is created from nothing.
        expect(
          JSON.parse(readFileSync(join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json'), 'utf8')),
        ).toEqual({
          privacyCache: { ghostMode: false },
          seeded: true,
        });
        writeFileSync(
          join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json'),
          JSON.stringify({ listed: true, privacyCache: { ghostMode: false } }),
        );
        writeFileSync(join(opts.env.CURSOR_CONFIG_DIR, 'statsig-cache.json'), '{"after":true}');
        writeFileSync(join(opts.env.CURSOR_CONFIG_DIR, 'chats.json'), '{"must":"not-copy"}');
        const child = makeFakeChild();
        emitThenClose(child, 'composer-2.5 - Composer 2.5');
        return child;
      },
    );

    const response = await cursorFetch('https://cursor.local/v1/models', { headers: AUTH });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [{ id: 'composer-2.5', name: 'Composer 2.5' }],
    });
    await vi.waitFor(() => expect(existsSync(scratchRoot)).toBe(false));
    expect(JSON.parse(readFileSync(join(seedDir, 'cli-config.json'), 'utf8'))).toEqual({
      listed: true,
      privacyCache: { ghostMode: false },
    });
    expect(readFileSync(join(seedDir, 'statsig-cache.json'), 'utf8')).toBe('{"after":true}');
    expect(existsSync(join(seedDir, 'chats.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'config', 'chats.json'))).toBe(false);
  });

  it('takes the queue slot BEFORE staging, so a rejected request writes nothing', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    const seedContents = JSON.stringify({ authInfo: { userId: 7 }, version: 2 });
    writeFileSync(join(seedDir, 'cli-config.json'), seedContents);

    let releaseFirst = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      void held.then(() => emitThenClose(child, 'composer-2.5 - Composer 2.5'));
      return child;
    });

    const gated = createCursorAgentFetch({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 1000,
      turnTimeoutMs: 5000,
    });
    const inflight = gated('https://cursor.local/v1/models', { headers: AUTH });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const stagedWhileBusy = fs.readdirSync(join(stateDir, 'turns'));

    const rejected = await gated('https://cursor.local/v1/models', {
      headers: { authorization: 'Bearer another-token' },
    });
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'overloaded' } });
    // No scratch was created and the shared seed was not touched by the rejected request.
    expect(fs.readdirSync(join(stateDir, 'turns'))).toEqual(stagedWhileBusy);
    expect(readFileSync(join(seedDir, 'cli-config.json'), 'utf8')).toBe(seedContents);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await (await inflight).json();
  });

  it('cleans model-list scratch when config seeding fails', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(join(seedDir, 'statsig-cache.json'), { recursive: true });

    const response = await cursorFetch('https://cursor.local/v1/models', { headers: AUTH });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'cli_error' } });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(join(stateDir, 'turns'))).toEqual([]);
  });
});

describe('POST /v1/turn', () => {
  it('spawns with --model, isolated env, history file, relays JSONL as SSE, then [DONE], and removes scratch', async () => {
    let historyPath = '';
    let historyContents = '';
    let historyMode = 0;
    let childEnv: Record<string, string> = {};
    let argv: string[] = [];

    spawnMock.mockImplementation(
      (_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
        argv = args;
        childEnv = opts.env;
        const flag = args.indexOf('--conversation-history-file');
        historyPath = args[flag + 1];
        historyContents = readFileSync(historyPath, 'utf8');
        historyMode = statSync(historyPath).mode & 0o777;
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const events = await readSse(response);
    expect(events.at(-1)).toBe('[DONE]');
    expect(events.slice(0, -1).map((line) => JSON.parse(line).type)).toEqual([
      'system',
      'user',
      'thinking',
      'thinking',
      'assistant',
      'result',
    ]);

    expect(argv).toEqual([
      '--use-system-ca',
      join(home, 'index.js'),
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--mode',
      'ask',
      '--single-turn',
      '--trust',
      '--disable-indexing',
      '--disable-codebase-ref',
      '--disable-auto-update',
      '--disable-project-configs',
      '--allowed-tools',
      'update_todos_tool_call',
      '--model',
      'composer-2.5',
      '--conversation-history-file',
      historyPath,
      '--',
      'Reply with the single word pong',
    ]);
    expect(historyMode).toBe(0o600);
    expect(childEnv.HOME).toBe(join(stateDir, INSTANCE_HOME));
    expect(childEnv.CURSOR_DATA_DIR).toBe(join(historyPath, '..', 'data'));
    expect(childEnv.CURSOR_CONFIG_DIR).toBe(join(historyPath, '..', 'config'));
    expect(childEnv.CURSOR_PROJECTS_DIR).toBe(join(historyPath, '..', 'projects'));
    expect(childEnv.XDG_CACHE_HOME).toBe(join(stateDir, 'cache'));
    expect(childEnv.NODE_COMPILE_CACHE).toBe(join(stateDir, 'cache', 'compile'));
    expect(JSON.parse(historyContents)).toEqual({
      messages: [
        { user: { content: [{ text: { text: 'ping' } }] } },
        { assistant: { content: [{ text: { text: 'pong' } }] } },
      ],
      replaceUserInfo: false,
    });
    expect(childEnv.CURSOR_AUTH_TOKEN).toBe(TOKEN);
    expect(childEnv.AGENT_CLI_CREDENTIAL_STORE).toBe('memory');
    expect(childEnv.DATABASE_URL).toBeUndefined();
    expect(childEnv.HTTPS_PROXY).toBeUndefined();
    expect(spawnMock.mock.calls[0][2].cwd).toBe(join(historyPath, '..'));

    await vi.waitFor(() => expect(existsSync(historyPath)).toBe(false));
  });

  it('injects a transport cli_exit event when the CLI exits non-zero before a result', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(child, '{"type":"system","subtype":"init"}\n', 7, 'workspace exploded');
      return child;
    });

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    const events = await readSse(response);
    expect(events.at(-1)).toBe('[DONE]');
    expect(JSON.parse(events.at(-2)!)).toMatchObject({
      code: 'cli_exit',
      exitCode: 7,
      subtype: 'error',
      type: 'transport',
    });
  });

  it('maps an auth-looking non-zero exit to transport unauthorized', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(child, '', 1, 'Error: Unauthorized — not logged in');
      return child;
    });

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    const events = await readSse(response);
    expect(JSON.parse(events.at(-2)!)).toMatchObject({
      code: 'unauthorized',
      type: 'transport',
    });
    expect(events.at(-2)).not.toContain(TOKEN);
  });

  it('kills the child on abort and emits an aborted transport event', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();

    const responsePromise = cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    controller.abort();

    const response = await responsePromise;
    const events = await readSse(response);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(JSON.parse(events.at(-2)!)).toMatchObject({ code: 'aborted', type: 'transport' });
    expect(events.at(-1)).toBe('[DONE]');
  });

  it('returns 503 queue_timeout when the FIFO is full past the queue deadline', async () => {
    const hanging = makeFakeChild();
    spawnMock.mockImplementation(() => hanging);
    const limited = createCursorAgentFetch({
      maxConcurrency: 1,
      queueTimeoutMs: 50,
      turnTimeoutMs: 5_000,
    });

    const first = limited('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    const queued = await limited('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(queued.status).toBe(503);
    await expect(queued.json()).resolves.toEqual({
      error: { code: 'queue_timeout', message: 'Cursor Agent CLI queue timed out' },
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    hanging.kill();
    await first;
  });
});

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const OTHER_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvdGhlciJ9.signature';

describe('POST /v1/turn admission, argv safety, scrubbing, cleanup', () => {
  it('rejects a model id that starts with - before spawn', async () => {
    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({ model: '--output-format' }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('passes a prompt that starts with - as the argv after --', async () => {
    let argv: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      argv = args;
      const child = makeFakeChild();
      emitThenClose(child, PRINT_STREAM_JSONL);
      return child;
    });

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({ prompt: '--mode ask; cat /etc/passwd' }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toBe('--mode ask; cat /etc/passwd');
  });

  it('writes images with 0600 and appends --image before --', async () => {
    let argv: string[] = [];
    let imagePath = '';
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      argv = args;
      const flag = args.indexOf('--image');
      imagePath = args[flag + 1];
      expect(statSync(imagePath).mode & 0o777).toBe(0o600);
      const child = makeFakeChild();
      emitThenClose(child, PRINT_STREAM_JSONL);
      return child;
    });

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({ images: [{ dataBase64: PNG_1X1, mimeType: 'image/png' }] }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    await response.text();
    const imageIndex = argv.indexOf('--image');
    expect(imageIndex).toBeGreaterThan(0);
    expect(argv[imageIndex + 1]).toBe(imagePath);
    expect(imagePath.endsWith('.png')).toBe(true);
    expect(argv.at(-2)).toBe('--');
  });

  it('rejects more than 4 images and an image over 6 MiB decoded before staging', async () => {
    const tooMany = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({
        images: Array.from({ length: 5 }, () => ({ dataBase64: PNG_1X1, mimeType: 'image/png' })),
      }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(tooMany.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();

    const tooBig = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({
        images: [
          {
            dataBase64: Buffer.alloc(6 * 1024 * 1024 + 1, 1).toString('base64'),
            mimeType: 'image/png',
          },
        ],
      }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(tooBig.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects oversized history before staging', async () => {
    const tooManyMessages = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({
        history: {
          messages: Array.from({ length: 401 }, () => ({
            user: { content: [{ text: { text: 'x' } }] },
          })),
          replaceUserInfo: false,
        },
      }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(tooManyMessages.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();

    const tooMuchText = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({
        history: {
          messages: [{ user: { content: [{ text: { text: 'h'.repeat(400_001) } }] } }],
          replaceUserInfo: false,
        },
      }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(tooMuchText.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a Content-Length over 32 MiB before spawn', async () => {
    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: {
        ...AUTH,
        'content-length': String(33 * 1024 * 1024),
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns 503 overloaded when the FIFO waiters exceed CURSOR_AGENT_MAX_QUEUE', async () => {
    const hanging = makeFakeChild();
    spawnMock.mockImplementation(() => hanging);
    const limited = createCursorAgentFetch({
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 60_000,
      turnTimeoutMs: 5_000,
    });

    const first = limited('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    const queued = limited('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await Promise.resolve();

    const overloaded = await limited('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(overloaded.status).toBe(503);
    await expect(overloaded.json()).resolves.toEqual({
      error: { code: 'overloaded', message: 'Cursor Agent CLI queue is full' },
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(child, PRINT_STREAM_JSONL);
      return child;
    });
    hanging.kill();
    await first;
    const queuedResponse = await queued;
    expect(queuedResponse.status).toBe(200);
    await queuedResponse.text();
  });

  it('scrubs the session token and another JWT from valid CLI JSON before SSE and CursorStream', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(
        child,
        [
          JSON.stringify({
            subtype: 'init',
            text: `system token ${TOKEN} jwt ${OTHER_JWT}`,
            type: 'system',
          }),
          JSON.stringify({
            message: { content: [{ text: `assistant ${TOKEN}`, type: 'text' }], role: 'assistant' },
            type: 'assistant',
          }),
          JSON.stringify({
            is_error: false,
            result: `done ${OTHER_JWT}`,
            subtype: 'success',
            type: 'result',
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        ].join('\n'),
      );
      return child;
    });

    const transport = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    const sse = await transport.text();
    expect(sse).not.toContain(TOKEN);
    expect(sse).not.toContain(OTHER_JWT);
    expect(sse).toContain('[REDACTED]');

    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(
        child,
        [
          JSON.stringify({
            message: { content: [{ text: `assistant ${TOKEN}`, type: 'text' }], role: 'assistant' },
            type: 'assistant',
          }),
          JSON.stringify({
            is_error: false,
            result: `done ${OTHER_JWT}`,
            subtype: 'success',
            type: 'result',
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        ].join('\n'),
      );
      return child;
    });

    const runtime = new LobeCursorAI({ apiKey: TOKEN, fetch: cursorFetch });
    const response = await runtime.chat({
      messages: [{ content: 'Reply with the single word pong', role: 'user' }],
      model: 'composer-2.5',
    });
    const streamed = await response.text();
    expect(streamed).not.toContain(TOKEN);
    expect(streamed).not.toContain(OTHER_JWT);
  });

  it('injects cli_exit when the CLI exits 0 without a result event', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(child, '{"type":"system","subtype":"init"}\n', 0);
      return child;
    });

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    const events = await readSse(response);
    expect(events.at(-1)).toBe('[DONE]');
    expect(JSON.parse(events.at(-2)!)).toMatchObject({
      code: 'cli_exit',
      message: 'CLI exited without a result',
      subtype: 'error',
      type: 'transport',
    });
  });

  it('maps a structured JSON result auth error to transport unauthorized before relay', async () => {
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(
        child,
        JSON.stringify({
          is_error: true,
          result: 'token expired — unauthenticated',
          subtype: 'error',
          type: 'result',
        }),
      );
      return child;
    });

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    const events = await readSse(response);
    const payload = JSON.parse(events.at(-2)!);
    expect(payload).toMatchObject({ code: 'unauthorized', type: 'transport' });
    expect(events.some((line) => line.includes('"type":"result"'))).toBe(false);
  });

  it('cancels response.body on a hanging child: SIGTERM, scratch gone, slot released, no unhandled rejection', async () => {
    const hanging = makeFakeChild();
    hanging.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === 'SIGTERM') {
        hanging.stdout.end();
        hanging.stderr.end();
        setImmediate(() => hanging.emit('close', null, 'SIGTERM'));
      }
      return true;
    });
    spawnMock.mockImplementation(() => hanging);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const limited = createCursorAgentFetch({
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 60_000,
      turnTimeoutMs: 5_000,
    });

    try {
      const response = await limited('https://cursor.local/v1/turn', {
        body: turnBody(),
        headers: { ...AUTH, 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const scratchRoot = spawnMock.mock.calls[0][2].cwd as string;
      expect(existsSync(scratchRoot)).toBe(true);

      await response.body!.cancel();
      expect(hanging.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.waitFor(() => expect(existsSync(scratchRoot)).toBe(false));

      const followUp = makeFakeChild();
      spawnMock.mockImplementation(() => {
        emitThenClose(followUp, PRINT_STREAM_JSONL);
        return followUp;
      });
      const second = await limited('https://cursor.local/v1/turn', {
        body: turnBody(),
        headers: { ...AUTH, 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(second.status).toBe(200);
      await second.text();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('removes the per-turn root after a successful turn while preserving CLI home state', async () => {
    let scratchRoot = '';
    let childEnv: Record<string, string> = {};
    spawnMock.mockImplementation(
      (_cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => {
        scratchRoot = opts.cwd;
        childEnv = opts.env;
        mkdirSync(join(childEnv.HOME, '.cursor'), { recursive: true });
        writeFileSync(join(childEnv.HOME, '.cursor', 'state.json'), '{}');
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();
    await vi.waitFor(() => expect(existsSync(scratchRoot)).toBe(false));
    expect(existsSync(join(stateDir, INSTANCE_HOME, '.cursor', 'state.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'cache', 'compile'))).toBe(true);
  });

  it('seeds only allowlisted config files into the turn config, unmodified', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
      join(seedDir, 'cli-config.json'),
      JSON.stringify({ privacyCache: { ghostMode: false }, theme: 'dark' }),
    );
    writeFileSync(join(seedDir, 'statsig-cache.json'), '{"stable":true}');
    writeFileSync(join(seedDir, 'chats.json'), '{"must":"stay-out"}');
    writeFileSync(join(seedDir, 'other.json'), '{"must":"stay-out"}');

    let turnConfigDir = '';
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        turnConfigDir = opts.env.CURSOR_CONFIG_DIR;
        expect(fs.readdirSync(turnConfigDir).sort()).toEqual([
          'cli-config.json',
          'statsig-cache.json',
        ]);
        expect(JSON.parse(readFileSync(join(turnConfigDir, 'cli-config.json'), 'utf8'))).toEqual({
          privacyCache: { ghostMode: false },
          theme: 'dark',
        });
        expect(readFileSync(join(turnConfigDir, 'statsig-cache.json'), 'utf8')).toBe(
          '{"stable":true}',
        );
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();
    await vi.waitFor(() => expect(existsSync(join(turnConfigDir, 'cli-config.json'))).toBe(false));
  });

  it('logs only a safe error class when malformed seed JSON is replaced', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'cli-config.json'), '{not-json');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      spawnMock.mockImplementation(
        (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
          expect(
            JSON.parse(readFileSync(join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json'), 'utf8')),
          ).toEqual({
            privacyCache: { ghostMode: true },
          });
          const child = makeFakeChild();
          emitThenClose(child, PRINT_STREAM_JSONL);
          return child;
        },
      );

      const response = await cursorFetch('https://cursor.local/v1/turn', {
        body: turnBody(),
        headers: { ...AUTH, 'content-type': 'application/json' },
        method: 'POST',
      });
      await response.text();

      expect(consoleSpy).toHaveBeenCalledWith(
        'Cursor Agent config seed JSON ignored:',
        'SyntaxError',
      );
      expect(consoleSpy.mock.calls.join('\n')).not.toContain(seedDir);
      expect(consoleSpy.mock.calls.join('\n')).not.toContain(TOKEN);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('creates a fresh ghost-mode cli-config seed and copies back what the CLI wrote', async () => {
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        const configDir = opts.env.CURSOR_CONFIG_DIR;
        expect(JSON.parse(readFileSync(join(configDir, 'cli-config.json'), 'utf8'))).toEqual({
          privacyCache: { ghostMode: true },
        });
        writeFileSync(
          join(configDir, 'cli-config.json'),
          JSON.stringify({ privacyCache: { ghostMode: false }, touched: true }),
        );
        writeFileSync(join(configDir, 'statsig-cache.json'), '{"after":true}');
        writeFileSync(join(configDir, 'chats.json'), '{"must":"not-copy"}');
        mkdirSync(join(configDir, 'chats'), { recursive: true });
        writeFileSync(join(configDir, 'chats', 'one.jsonl'), '{}');
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();

    const seedDir = join(stateDir, 'config-seed');
    expect(fs.readdirSync(seedDir).sort()).toEqual(['cli-config.json', 'statsig-cache.json']);
    // Ghost mode was pinned when the seed was created; the value the CLI wrote back is
    // NOT rewritten, so the seed stops lying about a state the account may not be in.
    expect(JSON.parse(readFileSync(join(seedDir, 'cli-config.json'), 'utf8'))).toEqual({
      privacyCache: { ghostMode: false },
      touched: true,
    });
    expect(readFileSync(join(seedDir, 'statsig-cache.json'), 'utf8')).toBe('{"after":true}');
    expect(existsSync(join(seedDir, 'chats.json'))).toBe(false);
    expect(existsSync(join(seedDir, 'chats'))).toBe(false);
  });

  it('keeps the previous seed when the turn config was truncated mid-write', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    const warmSeed = JSON.stringify({ authInfo: { userId: 7 }, serverConfigCache: {}, version: 2 });
    writeFileSync(join(seedDir, 'cli-config.json'), warmSeed);

    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        // A SIGKILLed CLI leaves a half-written file behind.
        writeFileSync(join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json'), '{"authInfo":');
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await cursorFetch('https://cursor.local/v1/turn', {
        body: turnBody(),
        headers: { ...AUTH, 'content-type': 'application/json' },
        method: 'POST',
      });
      await response.text();
      await vi.waitFor(() =>
        expect(readFileSync(join(seedDir, 'cli-config.json'), 'utf8')).toBe(warmSeed),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('keeps the previous seed when the turn config came back without authInfo', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    const warmSeed = JSON.stringify({ authInfo: { userId: 7 }, version: 2 });
    writeFileSync(join(seedDir, 'cli-config.json'), warmSeed);

    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        writeFileSync(
          join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json'),
          JSON.stringify({ version: 2 }),
        );
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();
    await vi.waitFor(() =>
      expect(readFileSync(join(seedDir, 'cli-config.json'), 'utf8')).toBe(warmSeed),
    );
  });

  it('still copies back a config that only ADDS keys to the seed', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
      join(seedDir, 'cli-config.json'),
      JSON.stringify({ authInfo: { userId: 7 }, version: 2 }),
    );

    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        writeFileSync(
          join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json'),
          JSON.stringify({
            authInfo: { userId: 7 },
            serverConfigCache: { fresh: true },
            version: 2,
          }),
        );
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(join(seedDir, 'cli-config.json'), 'utf8'))).toEqual({
        authInfo: { userId: 7 },
        serverConfigCache: { fresh: true },
        version: 2,
      }),
    );
  });

  /**
   * Both turns stage from the same seed generation. The one that copies back first wins;
   * the other must SKIP, because its result was computed from a generation that no longer
   * exists — a lost update is exactly what "atomic rename" does NOT prevent.
   */
  it('skips a copy-back whose seed generation was already replaced (compare-and-swap)', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(
      join(seedDir, 'cli-config.json'),
      JSON.stringify({ authInfo: { userId: 7 }, marker: 'seed', version: 2 }),
    );

    const children: ReturnType<typeof makeFakeChild>[] = [];
    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        const call = spawnMock.mock.calls.length - 1;
        const marker = call === 0 ? 'slow' : 'fast';
        writeFileSync(
          join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json'),
          JSON.stringify({ authInfo: { userId: 7 }, marker, version: 2 }),
        );
        const child = makeFakeChild();
        children.push(child);
        // Only the second turn finishes now; the first is held open on purpose.
        if (call > 0) emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const slow = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({ prompt: 'slow' }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    const fast = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody({ prompt: 'fast' }),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await fast.text();
    const readSeed = () =>
      JSON.parse(readFileSync(join(seedDir, 'cli-config.json'), 'utf8')) as { marker: string };
    await vi.waitFor(() => expect(readSeed().marker).toBe('fast'));

    emitThenClose(children[0]!, PRINT_STREAM_JSONL);
    await slow.text();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

    // The slow turn's result is dropped instead of resurrecting the older generation.
    expect(readSeed().marker).toBe('fast');
  });

  it('keeps the previous seed when a required key came back with an unusable value', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    const warmSeed = JSON.stringify({ authInfo: { userId: '7' }, version: '2' });
    writeFileSync(join(seedDir, 'cli-config.json'), warmSeed);

    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        writeFileSync(
          join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json'),
          // Present, but neither value is usable: `authInfo` is not an object of strings.
          JSON.stringify({ authInfo: 'signed-out', version: 2 }),
        );
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();
    await vi.waitFor(() =>
      expect(readFileSync(join(seedDir, 'cli-config.json'), 'utf8')).toBe(warmSeed),
    );
  });

  it('never lets a truncated statsig cache replace the warm one', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'cli-config.json'), JSON.stringify({ authInfo: {}, version: 2 }));
    const warmStatsig = '{"warm":true}';
    writeFileSync(join(seedDir, 'statsig-cache.json'), warmStatsig);

    spawnMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        writeFileSync(join(opts.env.CURSOR_CONFIG_DIR, 'statsig-cache.json'), '{"warm":');
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await cursorFetch('https://cursor.local/v1/turn', {
        body: turnBody(),
        headers: { ...AUTH, 'content-type': 'application/json' },
        method: 'POST',
      });
      await response.text();
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      expect(readFileSync(join(seedDir, 'statsig-cache.json'), 'utf8')).toBe(warmStatsig);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('passes the conversation id through as --new-session-id and never into the child env', async () => {
    let argv: string[] = [];
    let childEnv: Record<string, string> = {};
    spawnMock.mockImplementation(
      (_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
        argv = args;
        childEnv = opts.env;
        const child = makeFakeChild();
        emitThenClose(child, PRINT_STREAM_JSONL);
        return child;
      },
    );

    const conversationId = '7c953d82-e70d-4b3a-a3f8-fa162756d733';
    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        [CURSOR_CONVERSATION_HEADER]: conversationId,
      },
      method: 'POST',
    });
    await response.text();

    expect(argv).toEqual(expect.arrayContaining(['--new-session-id', conversationId]));
    expect(argv.indexOf('--new-session-id')).toBeLessThan(argv.lastIndexOf('--'));
    expect(Object.values(childEnv)).not.toContain(conversationId);
  });

  it('drops a conversation header that is not a UUIDv4 and omits the flag when absent', async () => {
    const argvs: string[][] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      argvs.push(args);
      const child = makeFakeChild();
      emitThenClose(child, PRINT_STREAM_JSONL);
      return child;
    });

    const malformed = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        [CURSOR_CONVERSATION_HEADER]: 'not-a-uuid',
      },
      method: 'POST',
    });
    await malformed.text();
    const plain = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    await plain.text();

    expect(argvs).toHaveLength(2);
    for (const argv of argvs) expect(argv).not.toContain('--new-session-id');
  });

  it('keeps one Cursor chat id for one conversation across turns of the same runtime', async () => {
    const argvs: string[][] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      argvs.push(args);
      const child = makeFakeChild();
      emitThenClose(child, PRINT_STREAM_JSONL);
      return child;
    });

    const installationId = '123e4567-e89b-42d3-a456-426614174000';
    const runtime = new LobeCursorAI({
      apiKey: TOKEN,
      conversationKey: 'user:u1:topic:t1',
      fetch: cursorFetch,
      installationId,
    });
    for (const prompt of ['first', 'second']) {
      const response = await runtime.chat({
        messages: [{ content: prompt, role: 'user' }],
        model: 'composer-2.5',
      });
      await response.text();
    }

    const expected = deriveCursorConversationId(installationId, 'user:u1:topic:t1');
    expect(argvs).toHaveLength(2);
    for (const argv of argvs)
      expect(argv).toEqual(expect.arrayContaining(['--new-session-id', expected]));
  });

  it('cleans scratch and releases the slot when spawn throws', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'cli_unavailable' } });

    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(child, PRINT_STREAM_JSONL);
      return child;
    });
    const retry = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(retry.status).toBe(200);
    await retry.text();
    expect(existsSync(join(stateDir, 'turns'))).toBe(true);
    expect(fs.readdirSync(join(stateDir, 'turns'))).toEqual([]);
  });

  it('cleans a partial scratch root when writeTurnScratch throws', async () => {
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    try {
      const response = await cursorFetch('https://cursor.local/v1/turn', {
        body: turnBody(),
        headers: { ...AUTH, 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'cli_error' } });
      expect(spawnMock).not.toHaveBeenCalled();
      expect(fs.readdirSync(join(stateDir, 'turns'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('cleans turn scratch and releases the slot when config seeding fails', async () => {
    const seedDir = join(stateDir, 'config-seed');
    mkdirSync(join(seedDir, 'statsig-cache.json'), { recursive: true });

    const response = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'cli_error' } });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(join(stateDir, 'turns'))).toEqual([]);

    rmSync(join(seedDir, 'statsig-cache.json'), { force: true, recursive: true });
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      emitThenClose(child, PRINT_STREAM_JSONL);
      return child;
    });
    const retry = await cursorFetch('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(retry.status).toBe(200);
    await retry.text();
  });

  it('kills a timed-out turn and removes scratch', async () => {
    const hanging = makeFakeChild();
    hanging.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === 'SIGTERM') {
        hanging.stdout.end();
        hanging.stderr.end();
        setImmediate(() => hanging.emit('close', null, 'SIGTERM'));
      }
      return true;
    });
    spawnMock.mockReturnValue(hanging);
    const limited = createCursorAgentFetch({
      maxConcurrency: 1,
      queueTimeoutMs: 60_000,
      turnTimeoutMs: 30,
    });

    const response = await limited('https://cursor.local/v1/turn', {
      body: turnBody(),
      headers: { ...AUTH, 'content-type': 'application/json' },
      method: 'POST',
    });
    const scratchRoot = spawnMock.mock.calls[0][2].cwd as string;
    const events = await readSse(response);
    expect(hanging.kill).toHaveBeenCalledWith('SIGTERM');
    expect(JSON.parse(events.at(-2)!)).toMatchObject({ code: 'timeout', type: 'transport' });
    await vi.waitFor(() => expect(existsSync(scratchRoot)).toBe(false));
  });
});
