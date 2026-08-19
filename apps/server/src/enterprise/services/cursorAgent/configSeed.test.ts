// @vitest-environment node
import fs, {
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

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCursorAgentAccountId,
  CURSOR_CONFIG_SEED_ACCOUNT_NS,
  CURSOR_CONFIG_SEED_TOKEN_NS,
  cursorAgentAccountConfigSeedDir,
  cursorAgentTokenConfigSeedDir,
  digestCursorConfigSeedIdentity,
  isCurrentPlatformCursorAccountId,
  resolveCursorAgentConfigSeedDir,
} from './configSeed';

const { join, sep } = nodePath;

let root: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

describe('buildCursorAgentAccountId', () => {
  it('matches the ChatGPT Web account-id shape for platform and user connections', () => {
    expect(buildCursorAgentAccountId({ kind: 'platform', providerId: 'cursor' })).toBe(
      'platform:cursor',
    );
    expect(buildCursorAgentAccountId({ kind: 'platform', providerId: 'cursor', revision: 3 })).toBe(
      'platform:cursor:rev:3',
    );
    expect(
      buildCursorAgentAccountId({
        kind: 'user',
        providerId: 'cursor',
        userId: 'user-a',
      }),
    ).toBe('user:user-a:_:cursor');
    expect(
      buildCursorAgentAccountId({
        kind: 'user',
        providerId: 'my-cursor',
        userId: 'user-a',
        workspaceId: 'ws-1',
      }),
    ).toBe('user:user-a:ws-1:my-cursor');
  });
});

describe('isCurrentPlatformCursorAccountId', () => {
  it('accepts only the unpinned platform connection', () => {
    expect(isCurrentPlatformCursorAccountId('platform:cursor')).toBe(true);
    expect(isCurrentPlatformCursorAccountId('platform:custom-cursor')).toBe(true);
    expect(isCurrentPlatformCursorAccountId('platform:cursor:rev:1')).toBe(false);
    expect(isCurrentPlatformCursorAccountId('user:u1:_:cursor')).toBe(false);
  });
});

describe('digestCursorConfigSeedIdentity', () => {
  it('returns a 32-char hex prefix and never the raw identity', () => {
    const accountId = 'platform:cursor';
    const digest = digestCursorConfigSeedIdentity(accountId);
    expect(digest).toMatch(/^[\da-f]{32}$/);
    expect(digest).not.toContain(accountId);
    expect(digestCursorConfigSeedIdentity(accountId)).toBe(digest);
    expect(digestCursorConfigSeedIdentity('user:u1:_:cursor')).not.toBe(digest);
  });
});

describe('resolveCursorAgentConfigSeedDir', () => {
  it('keys two account ids to two 0700 dirs with no cross-read', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    const platform = resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'token-a',
    });
    const user = resolveCursorAgentConfigSeedDir({
      accountId: 'user:u1:_:cursor',
      seedRoot,
      token: 'token-a',
    });

    expect(platform).not.toBe(user);
    expect(platform).toBe(cursorAgentAccountConfigSeedDir(seedRoot, 'platform:cursor'));
    expect(user).toBe(cursorAgentAccountConfigSeedDir(seedRoot, 'user:u1:_:cursor'));
    expect(platform).toContain(`${sep}${CURSOR_CONFIG_SEED_ACCOUNT_NS}${sep}`);
    expect(platform).not.toContain('platform:cursor');
    expect(user).not.toContain('user:u1');
    expect(statSync(platform).mode & 0o777).toBe(0o700);
    expect(statSync(user).mode & 0o777).toBe(0o700);

    writeFileSync(join(platform, 'cli-config.json'), '{"owner":"platform"}');
    expect(existsSync(join(user, 'cli-config.json'))).toBe(false);
  });

  it('returns the same dir for the same account across calls (reconnect-stable)', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    const first = resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'old-token',
    });
    const second = resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'rotated-token',
    });
    expect(second).toBe(first);
  });

  it('falls back to the bearer digest when the account id is absent', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    const a = resolveCursorAgentConfigSeedDir({ seedRoot, token: 'token-a' });
    const b = resolveCursorAgentConfigSeedDir({ seedRoot, token: 'token-b' });
    expect(a).toBe(cursorAgentTokenConfigSeedDir(seedRoot, 'token-a'));
    expect(b).toBe(cursorAgentTokenConfigSeedDir(seedRoot, 'token-b'));
    expect(a).toContain(`${sep}${CURSOR_CONFIG_SEED_TOKEN_NS}${sep}`);
    expect(a).not.toBe(b);
  });

  it('never collides account and token namespaces even when the token equals an account id', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    const account = resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'unrelated',
    });
    const token = resolveCursorAgentConfigSeedDir({ seedRoot, token: 'platform:cursor' });
    expect(account).not.toBe(token);
    expect(account).toContain(`${sep}${CURSOR_CONFIG_SEED_ACCOUNT_NS}${sep}`);
    expect(token).toContain(`${sep}${CURSOR_CONFIG_SEED_TOKEN_NS}${sep}`);
    expect(digestCursorConfigSeedIdentity('platform:cursor')).toBe(
      digestCursorConfigSeedIdentity('platform:cursor'),
    );
  });

  it('never returns the legacy global config-seed directory itself', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    mkdirSync(seedRoot, { recursive: true });
    const resolved = resolveCursorAgentConfigSeedDir({ seedRoot, token: 'tok' });
    expect(resolved).not.toBe(seedRoot);
    expect(resolved.startsWith(`${seedRoot}${sep}`)).toBe(true);
  });

  it('copies legacy seed files once into the current platform dir and leaves them in place', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    mkdirSync(seedRoot, { recursive: true });
    writeFileSync(join(seedRoot, 'cli-config.json'), '{"legacy":true,"authInfo":{"userId":1}}');
    writeFileSync(join(seedRoot, 'statsig-cache.json'), '{"warm":true}');
    writeFileSync(join(seedRoot, 'chats.json'), '{"must":"stay"}');

    const platform = resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'tok',
    });
    expect(JSON.parse(readFileSync(join(platform, 'cli-config.json'), 'utf8'))).toEqual({
      authInfo: { userId: 1 },
      legacy: true,
    });
    expect(readFileSync(join(platform, 'statsig-cache.json'), 'utf8')).toBe('{"warm":true}');
    expect(existsSync(join(platform, 'chats.json'))).toBe(false);
    expect(readFileSync(join(seedRoot, 'cli-config.json'), 'utf8')).toContain('"legacy":true');
    expect(existsSync(join(seedRoot, 'chats.json'))).toBe(true);

    writeFileSync(join(platform, 'cli-config.json'), '{"migrated":"owned"}');
    resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'tok',
    });
    expect(JSON.parse(readFileSync(join(platform, 'cli-config.json'), 'utf8'))).toEqual({
      migrated: 'owned',
    });
  });

  it('does not clobber a destination that already exists (copy-back wins)', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    mkdirSync(seedRoot, { recursive: true });
    writeFileSync(join(seedRoot, 'cli-config.json'), '{"legacy":true}');
    writeFileSync(join(seedRoot, 'statsig-cache.json'), '{"legacy":true}');

    const platform = cursorAgentAccountConfigSeedDir(seedRoot, 'platform:cursor');
    mkdirSync(platform, { recursive: true });
    writeFileSync(join(platform, 'cli-config.json'), '{"owned":true}');

    resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'tok',
    });

    expect(JSON.parse(readFileSync(join(platform, 'cli-config.json'), 'utf8'))).toEqual({
      owned: true,
    });
    expect(readFileSync(join(platform, 'statsig-cache.json'), 'utf8')).toBe('{"legacy":true}');
  });

  it('retries a missing sibling after a partial migration failure', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    mkdirSync(seedRoot, { recursive: true });
    writeFileSync(join(seedRoot, 'cli-config.json'), '{"legacy":"cli"}');
    writeFileSync(join(seedRoot, 'statsig-cache.json'), '{"legacy":"statsig"}');

    const actualCopy = fs.copyFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation((src, dest, mode) => {
      if (String(dest).includes('statsig-cache.json')) throw new Error('ENOSPC');
      return actualCopy(src, dest, mode);
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const platform = resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'tok',
    });
    expect(JSON.parse(readFileSync(join(platform, 'cli-config.json'), 'utf8'))).toEqual({
      legacy: 'cli',
    });
    expect(existsSync(join(platform, 'statsig-cache.json'))).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Cursor Agent legacy config seed migration skipped:',
      'Error',
    );

    spy.mockRestore();
    resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor',
      seedRoot,
      token: 'tok',
    });
    expect(JSON.parse(readFileSync(join(platform, 'cli-config.json'), 'utf8'))).toEqual({
      legacy: 'cli',
    });
    expect(readFileSync(join(platform, 'statsig-cache.json'), 'utf8')).toBe('{"legacy":"statsig"}');
  });

  it('does not migrate the legacy dir into a user or pinned-revision account', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-seed-'));
    const seedRoot = join(root, 'config-seed');
    mkdirSync(seedRoot, { recursive: true });
    writeFileSync(join(seedRoot, 'cli-config.json'), '{"legacy":true}');

    const user = resolveCursorAgentConfigSeedDir({
      accountId: 'user:u1:_:cursor',
      seedRoot,
      token: 'tok',
    });
    const pinned = resolveCursorAgentConfigSeedDir({
      accountId: 'platform:cursor:rev:2',
      seedRoot,
      token: 'tok',
    });
    expect(existsSync(join(user, 'cli-config.json'))).toBe(false);
    expect(existsSync(join(pinned, 'cli-config.json'))).toBe(false);
    expect(existsSync(join(seedRoot, 'cli-config.json'))).toBe(true);
  });
});
