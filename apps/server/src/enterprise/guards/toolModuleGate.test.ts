// @vitest-environment node
import { CloudSandboxIdentifier } from '@lobechat/builtin-tool-cloud-sandbox/manifest';
import { KnowledgeBaseIdentifier } from '@lobechat/builtin-tool-knowledge-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { getEnterpriseErrorBody, throwEnterpriseError } from './enterpriseErrors';
import { assertToolModuleEnabled } from './toolModuleGate';

const assertModuleEnabled = vi.fn();

vi.mock('../services/moduleSettings', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    assertModuleEnabled: (...args: unknown[]) => assertModuleEnabled(...args),
  };
});

describe('assertToolModuleEnabled', () => {
  beforeEach(() => {
    assertModuleEnabled.mockReset();
    assertModuleEnabled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not consult settings for unmapped (core) identifiers', async () => {
    await expect(assertToolModuleEnabled('lobe-notebook')).resolves.toBeUndefined();
    expect(assertModuleEnabled).not.toHaveBeenCalled();
  });

  it('rejects a knowledge-base tool before any runtime work when the module is off', async () => {
    assertModuleEnabled.mockImplementation(async (moduleId: string) => {
      throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
        details: { moduleId },
        httpCode: 'FORBIDDEN',
      });
    });

    const error = await assertToolModuleEnabled(KnowledgeBaseIdentifier).catch(
      (caught: unknown) => caught,
    );

    expect(assertModuleEnabled).toHaveBeenCalledWith('knowledgeBase');
    expect(getEnterpriseErrorBody(error)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
      details: { moduleId: 'knowledgeBase' },
    });
  });

  it('allows a mapped tool when the module is on', async () => {
    await expect(assertToolModuleEnabled(KnowledgeBaseIdentifier)).resolves.toBeUndefined();
    expect(assertModuleEnabled).toHaveBeenCalledWith('knowledgeBase');
  });

  it('maps the cloud sandbox tool to the sandbox module', async () => {
    await expect(assertToolModuleEnabled(CloudSandboxIdentifier)).resolves.toBeUndefined();
    expect(assertModuleEnabled).toHaveBeenCalledWith('sandbox');
  });
});
