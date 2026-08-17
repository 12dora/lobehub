// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { trpc } from '@/libs/trpc/lambda/init';

import { getEnterpriseErrorBody } from '../guards/enterpriseErrors';
import * as moduleSettings from '../services/moduleSettings';
import { moduleRouter } from './moduleRouter';

const innerRouter = trpc.router({
  ping: trpc.procedure.query(() => 'pong'),
});

describe('moduleRouter', () => {
  const load = vi.fn(async () => innerRouter);

  beforeEach(() => {
    vi.clearAllMocks();
    load.mockImplementation(async () => innerRouter);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not import at module-evaluation time', () => {
    moduleRouter('knowledgeBase', load);
    expect(load).not.toHaveBeenCalled();
  });

  it('delegates when the module is enabled and imports once', async () => {
    vi.spyOn(moduleSettings, 'isModuleEnabled').mockResolvedValue(true);

    const root = trpc.router({
      kb: moduleRouter('knowledgeBase', load),
    });
    const caller = root.createCaller({});

    await expect(caller.kb.ping()).resolves.toBe('pong');
    await expect(caller.kb.ping()).resolves.toBe('pong');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('throws FORBIDDEN PLATFORM_MODULE_DISABLED with moduleId when disabled', async () => {
    vi.spyOn(moduleSettings, 'isModuleEnabled').mockResolvedValue(false);

    const root = trpc.router({
      kb: moduleRouter('knowledgeBase', load),
    });
    const caller = root.createCaller({});

    const error = await caller.kb.ping().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'FORBIDDEN' });
    expect(getEnterpriseErrorBody(error)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
      details: { moduleId: 'knowledgeBase' },
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-checks the hot flag after the import is memoized', async () => {
    const enabled = vi.spyOn(moduleSettings, 'isModuleEnabled').mockResolvedValue(true);

    const root = trpc.router({
      kb: moduleRouter('knowledgeBase', load),
    });
    const caller = root.createCaller({});

    await expect(caller.kb.ping()).resolves.toBe('pong');
    enabled.mockResolvedValue(false);

    const error = await caller.kb.ping().catch((caught: unknown) => caught);
    expect(getEnterpriseErrorBody(error)?.code).toBe(PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
