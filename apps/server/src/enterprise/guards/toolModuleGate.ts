/**
 * Maps builtin server-runtime tool identifiers to the platform module that owns
 * them. Unlisted identifiers are core and always allowed.
 */
import { CloudSandboxIdentifier } from '@lobechat/builtin-tool-cloud-sandbox/manifest';
import { KnowledgeBaseIdentifier } from '@lobechat/builtin-tool-knowledge-base/manifest';
import { MemoryIdentifier } from '@lobechat/builtin-tool-memory/manifest';
import { RemoteDeviceIdentifier } from '@lobechat/builtin-tool-remote-device/manifest';
import { SkillStoreIdentifier } from '@lobechat/builtin-tool-skill-store/manifest';
import { WebBrowsingManifest } from '@lobechat/builtin-tool-web-browsing/manifest';

import type { PlatformModuleId } from '@/const/platform/modules';

import { assertModuleEnabled } from '../services/moduleSettings';

export const TOOL_MODULE_BY_IDENTIFIER: Readonly<Record<string, PlatformModuleId>> = {
  [CloudSandboxIdentifier]: 'sandbox',
  [KnowledgeBaseIdentifier]: 'knowledgeBase',
  [MemoryIdentifier]: 'memory',
  [RemoteDeviceIdentifier]: 'deviceGateway',
  [SkillStoreIdentifier]: 'market',
  [WebBrowsingManifest.identifier]: 'webSearch',
};

export const assertToolModuleEnabled = async (identifier: string): Promise<void> => {
  const moduleId = TOOL_MODULE_BY_IDENTIFIER[identifier];
  if (!moduleId) return;
  await assertModuleEnabled(moduleId);
};
