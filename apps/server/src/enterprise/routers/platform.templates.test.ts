// @vitest-environment node
/**
 * platform.{agent,task}Templates.list — first-read auto-seed must honour the client's locale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAgentTemplates,
  platformTaskTemplates,
  platformTemplateCatalogState,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { listTaskTemplateLibrary } from '@/server/services/taskTemplate';

import { resetModuleSettingsForTest } from '../services/moduleSettings';
import { builtInAgentTemplatesForImport } from './admin/builtInAgentTemplates';
import { platformRouter } from './platform';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(platformRouter);
const userId = 'platform-template-locale-user';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = vi.fn(async (params: { action: string }) => ({
      action: params.action,
      id: 'audit-ok',
      result: 'success',
    }));
  },
}));

const cleanup = async () => {
  await db.delete(platformAgentTemplates);
  await db.delete(platformTaskTemplates);
  await db.delete(platformTemplateCatalogState);
  await db.delete(users);
  resetModuleSettingsForTest();
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('DEFAULT_LANG', '');
  await cleanup();
  await db.insert(users).values({ id: userId });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const caller = async () =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId,
    })),
    serverDB: db,
  } as never);

describe('platform.agentTemplates.list locale seed', () => {
  it('seeds Chinese titles on first read with locale zh-CN', async () => {
    const zhTitle = builtInAgentTemplatesForImport('zh-CN')[0]!.title;
    const enTitle = builtInAgentTemplatesForImport('en-US')[0]!.title;
    expect(zhTitle).not.toBe(enTitle);

    const result = await (await caller()).agentTemplates.list({ locale: 'zh-CN' });
    expect(result.managed).toBe(true);
    expect(result.templates[0]?.title).toBe(zhTitle);
  });

  it('still works when called with no input or an empty object', async () => {
    const withoutArgs = await (await caller()).agentTemplates.list();
    expect(withoutArgs.managed).toBe(true);
    expect(withoutArgs.templates[0]?.title).toBe(builtInAgentTemplatesForImport('en-US')[0]!.title);

    const withEmpty = await (await caller()).agentTemplates.list({});
    expect(withEmpty).toEqual(withoutArgs);
  });

  it('does not fail the read when the locale is unknown', async () => {
    const result = await (await caller()).agentTemplates.list({ locale: 'zz-ZZ' });
    expect(result.managed).toBe(true);
    expect(result.templates[0]?.title).toBe(builtInAgentTemplatesForImport('en-US')[0]!.title);
  });
});

describe('platform.taskTemplates.list locale seed', () => {
  it('seeds Chinese titles on first read with locale zh-CN', async () => {
    const zhTitle = listTaskTemplateLibrary('zh-CN')[0]!.title;
    const enTitle = listTaskTemplateLibrary('en-US')[0]!.title;
    expect(zhTitle).not.toBe(enTitle);

    const result = await (await caller()).taskTemplates.list({ locale: 'zh-CN' });
    expect(result.managed).toBe(true);
    expect(result.templates[0]?.title).toBe(zhTitle);
  });

  it('still works when called with no input or an empty object', async () => {
    const withoutArgs = await (await caller()).taskTemplates.list();
    expect(withoutArgs.managed).toBe(true);
    expect(withoutArgs.templates[0]?.title).toBe(listTaskTemplateLibrary('en-US')[0]!.title);

    const withEmpty = await (await caller()).taskTemplates.list({});
    expect(withEmpty).toEqual(withoutArgs);
  });

  it('does not fail the read when the locale is unknown', async () => {
    const result = await (await caller()).taskTemplates.list({ locale: 'zz-ZZ' });
    expect(result.managed).toBe(true);
    expect(result.templates[0]?.title).toBe(listTaskTemplateLibrary('en-US')[0]!.title);
  });
});
