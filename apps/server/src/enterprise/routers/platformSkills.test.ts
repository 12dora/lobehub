// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { platformSkillsRouter } from './platformSkills';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(platformSkillsRouter);
const userId = 'm08-platform-skill-user';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('@lobechat/builtin-skills', () => ({
  builtinSkills: [
    {
      content: '# Mock builtin Skill',
      description: 'Mock builtin Skill',
      identifier: 'mock-builtin',
      name: 'Mock builtin',
      source: 'builtin',
    },
  ],
}));

beforeEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(users);
  await db.insert(users).values({ id: userId });
});

afterEach(async () => {
  await db.delete(users);
  vi.unstubAllEnvs();
});

describe('platformSkillsRouter', () => {
  it('denies anonymous access and exposes no server-only resolver procedure', async () => {
    const anonymous = createCaller({ ...(await createContextInner()), serverDB: db } as never);
    await expect(anonymous.getPublished()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect('resolveForExecution' in anonymous).toBe(false);
  });

  it('returns a stable empty public catalog when the feature is off', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '0');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    await expect(caller.getPublished()).resolves.toEqual({ revision: 'disabled', skills: [] });
  });

  it('returns strict builtin public metadata without execution content', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
    const caller = createCaller({
      ...(await createContextInner({ userId })),
      serverDB: db,
    } as never);
    const catalog = await caller.getPublished();
    expect(catalog.skills.length).toBeGreaterThan(0);
    expect(catalog.skills[0]).toEqual({
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      description: expect.any(String),
      displayName: expect.any(String),
      distribution: 'default',
      skillKey: expect.any(String),
      source: 'builtin',
      version: '0.0.0',
    });
    expect(JSON.stringify(catalog)).not.toContain('contentRef');
    expect(JSON.stringify(catalog)).not.toContain('manifest');
    expect(JSON.stringify(catalog)).not.toContain('resources');
  });
});
