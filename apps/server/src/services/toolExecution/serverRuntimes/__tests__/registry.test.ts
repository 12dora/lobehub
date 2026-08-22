// @vitest-environment node
import { LobeActivatorIdentifier } from '@lobechat/builtin-tool-activator/manifest';
import { AgentBuilderIdentifier } from '@lobechat/builtin-tool-agent-builder/manifest';
import { AgentDocumentsIdentifier } from '@lobechat/builtin-tool-agent-documents/manifest';
import { AgentManagementIdentifier } from '@lobechat/builtin-tool-agent-management/manifest';
import {
  AGENT_SIGNAL_FEEDBACK_INTENT_IDENTIFIER,
  AGENT_SIGNAL_REFLECTION_IDENTIFIER,
  AGENT_SIGNAL_REVIEW_IDENTIFIER,
  AGENT_SIGNAL_SKILL_MANAGEMENT_IDENTIFIER,
} from '@lobechat/builtin-tool-agent-signal/manifest';
import { BriefIdentifier } from '@lobechat/builtin-tool-brief/manifest';
import { CalculatorIdentifier } from '@lobechat/builtin-tool-calculator/manifest';
import { CloudSandboxIdentifier } from '@lobechat/builtin-tool-cloud-sandbox/manifest';
import { CredsIdentifier } from '@lobechat/builtin-tool-creds/manifest';
import { DocumentPagesIdentifier } from '@lobechat/builtin-tool-document-pages/manifest';
import { GroupManagementIdentifier } from '@lobechat/builtin-tool-group-management/manifest';
import { KnowledgeBaseIdentifier } from '@lobechat/builtin-tool-knowledge-base/manifest';
import { LobeAgentIdentifier } from '@lobechat/builtin-tool-lobe-agent/manifest';
import { LobeDeliveryCheckerIdentifier } from '@lobechat/builtin-tool-lobe-delivery-checker/manifest';
import { LocalSystemIdentifier } from '@lobechat/builtin-tool-local-system/manifest';
import { MemoryIdentifier } from '@lobechat/builtin-tool-memory/manifest';
import { MessageToolIdentifier } from '@lobechat/builtin-tool-message/manifest';
import { NotebookIdentifier } from '@lobechat/builtin-tool-notebook/manifest';
import { PageAgentIdentifier } from '@lobechat/builtin-tool-page-agent/manifest';
import { RemoteDeviceIdentifier } from '@lobechat/builtin-tool-remote-device/manifest';
import { SELF_FEEDBACK_INTENT_IDENTIFIER } from '@lobechat/builtin-tool-self-iteration/manifest';
import { SkillMaintainerIdentifier } from '@lobechat/builtin-tool-skill-maintainer/manifest';
import { SkillStoreIdentifier } from '@lobechat/builtin-tool-skill-store/manifest';
import { SkillsIdentifier } from '@lobechat/builtin-tool-skills/manifest';
import { TaskIdentifier } from '@lobechat/builtin-tool-task/manifest';
import { TopicReferenceIdentifier } from '@lobechat/builtin-tool-topic-reference/manifest';
import { UserInteractionIdentifier } from '@lobechat/builtin-tool-user-interaction/manifest';
import { VerifyToolIdentifier } from '@lobechat/builtin-tool-verify/manifest';
import { WebBrowsingManifest } from '@lobechat/builtin-tool-web-browsing/manifest';
import { WebOnboardingIdentifier } from '@lobechat/builtin-tool-web-onboarding/manifest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolExecutionContext } from '../../types';

const mocks = vi.hoisted(() => {
  let releaseBrief: () => void = () => undefined;
  const briefGate = new Promise<void>((resolve) => {
    releaseBrief = resolve;
  });
  return {
    assertToolModuleEnabled: vi.fn(async (_identifier: string) => undefined),
    briefGate,
    briefInits: 0,
    knowledgeBaseEvaluated: false,
    releaseBrief: () => releaseBrief(),
  };
});

const mockRuntime = (exportName: string, identifier: string, runtime: Record<string, unknown>) => ({
  [exportName]: {
    factory: () => runtime,
    identifier,
  },
});

vi.mock('@/server/enterprise/guards/toolModuleGate', () => ({
  assertToolModuleEnabled: (identifier: string) => mocks.assertToolModuleEnabled(identifier),
}));

vi.mock('../agentBuilder', () =>
  mockRuntime('agentBuilderRuntime', 'lobe-agent-builder', { id: 'agentBuilder' }),
);
vi.mock('../webBrowsing', () =>
  mockRuntime('webBrowsingRuntime', 'lobe-web-browsing', { id: 'webBrowsing' }),
);
vi.mock('../cloudSandbox', () =>
  mockRuntime('cloudSandboxRuntime', 'lobe-cloud-sandbox', { id: 'cloudSandbox' }),
);
vi.mock('../calculator', () =>
  mockRuntime('calculatorRuntime', 'lobe-calculator', { id: 'calculator' }),
);
vi.mock('../documentPages', () =>
  mockRuntime('documentPagesRuntime', 'lobe-document-pages', { id: 'documentPages' }),
);
vi.mock('../agentDocuments', () =>
  mockRuntime('agentDocumentsRuntime', 'lobe-agent-documents', { id: 'agentDocuments' }),
);
vi.mock('../agentManagement', () =>
  mockRuntime('agentManagementRuntime', 'lobe-agent-management', { id: 'agentManagement' }),
);
vi.mock('../skillManagement', () =>
  mockRuntime('skillManagementRuntime', 'lobe-skill-maintainer', { id: 'skillManagement' }),
);
vi.mock('../notebook', () => mockRuntime('notebookRuntime', 'lobe-notebook', { id: 'notebook' }));
vi.mock('../skillStore', () =>
  mockRuntime('skillStoreRuntime', 'lobe-skill-store', { id: 'skillStore' }),
);
vi.mock('../skills', () => mockRuntime('skillsRuntime', 'lobe-skills', { id: 'skills' }));
vi.mock('../memory', () => mockRuntime('memoryRuntime', 'lobe-user-memory', { id: 'memory' }));
vi.mock('../activator', () =>
  mockRuntime('activatorRuntime', 'lobe-activator', { id: 'activator' }),
);
vi.mock('../message', () => mockRuntime('messageRuntime', 'lobe-message', { id: 'message' }));
vi.mock('../localSystem', () =>
  mockRuntime('localSystemRuntime', 'lobe-local-system', { id: 'localSystem' }),
);
vi.mock('../remoteDevice', () =>
  mockRuntime('remoteDeviceRuntime', 'lobe-remote-device', { id: 'remoteDevice' }),
);
vi.mock('../brief', async () => {
  mocks.briefInits += 1;
  await mocks.briefGate;
  return mockRuntime('briefRuntime', 'lobe-brief', { id: 'brief' });
});
vi.mock('../task', () => mockRuntime('taskRuntime', 'lobe-task', { id: 'task' }));
vi.mock('../topicReference', () =>
  mockRuntime('topicReferenceRuntime', 'lobe-topic-reference', { id: 'topicReference' }),
);
vi.mock('../userInteraction', () =>
  mockRuntime('userInteractionRuntime', 'lobe-user-interaction', { id: 'userInteraction' }),
);
vi.mock('../creds', () => mockRuntime('credsRuntime', 'lobe-creds', { id: 'creds' }));
vi.mock('../groupManagement', () =>
  mockRuntime('groupManagementRuntime', 'lobe-group-management', { id: 'groupManagement' }),
);
vi.mock('../knowledgeBase', () => {
  mocks.knowledgeBaseEvaluated = true;
  return mockRuntime('knowledgeBaseRuntime', 'lobe-knowledge-base', { id: 'knowledgeBase' });
});
vi.mock('../webOnboarding', () =>
  mockRuntime('webOnboardingRuntime', 'lobe-web-onboarding', { id: 'webOnboarding' }),
);
vi.mock('../lobeAgent', () => mockRuntime('lobeAgentRuntime', 'lobe-agent', { id: 'lobeAgent' }));
vi.mock('../selfFeedbackIntent', () =>
  mockRuntime('selfFeedbackIntentRuntime', 'lobe-self-feedback-intent', {
    id: 'selfFeedbackIntent',
  }),
);
vi.mock('../agentSignalSkillManagement', () =>
  mockRuntime('agentSignalSkillManagementRuntime', 'agent-signal-skill-management', {
    id: 'agentSignalSkillManagement',
  }),
);
vi.mock('../agentSignalReview', () =>
  mockRuntime('agentSignalReviewRuntime', 'agent-signal-review', { id: 'agentSignalReview' }),
);
vi.mock('../agentSignalReflection', () =>
  mockRuntime('agentSignalReflectionRuntime', 'agent-signal-reflection', {
    id: 'agentSignalReflection',
  }),
);
vi.mock('../agentSignalFeedbackIntent', () =>
  mockRuntime('agentSignalFeedbackIntentRuntime', 'agent-signal-feedback-intent', {
    id: 'agentSignalFeedbackIntent',
  }),
);
vi.mock('../pageAgent', () =>
  mockRuntime('pageAgentRuntime', 'lobe-page-agent', { id: 'pageAgent' }),
);
vi.mock('../verifyResult', () =>
  mockRuntime('verifyResultRuntime', 'lobe-verify', { id: 'verifyResult' }),
);
vi.mock('../lobeDeliveryChecker', () =>
  mockRuntime('lobeDeliveryCheckerRuntime', 'lobe-delivery-checker', { id: 'lobeDeliveryChecker' }),
);

const { getServerRuntime, getServerRuntimeIdentifiers, hasServerRuntime } =
  await import('../index');

const emptyContext = { toolManifestMap: {} } as ToolExecutionContext;

const STATIC_IDENTIFIERS = [
  AgentBuilderIdentifier,
  WebBrowsingManifest.identifier,
  CloudSandboxIdentifier,
  CalculatorIdentifier,
  DocumentPagesIdentifier,
  AgentDocumentsIdentifier,
  AgentManagementIdentifier,
  SkillMaintainerIdentifier,
  NotebookIdentifier,
  SkillStoreIdentifier,
  SkillsIdentifier,
  MemoryIdentifier,
  LobeActivatorIdentifier,
  MessageToolIdentifier,
  LocalSystemIdentifier,
  RemoteDeviceIdentifier,
  BriefIdentifier,
  TaskIdentifier,
  TopicReferenceIdentifier,
  UserInteractionIdentifier,
  CredsIdentifier,
  GroupManagementIdentifier,
  KnowledgeBaseIdentifier,
  WebOnboardingIdentifier,
  LobeAgentIdentifier,
  SELF_FEEDBACK_INTENT_IDENTIFIER,
  AGENT_SIGNAL_SKILL_MANAGEMENT_IDENTIFIER,
  AGENT_SIGNAL_REVIEW_IDENTIFIER,
  AGENT_SIGNAL_REFLECTION_IDENTIFIER,
  AGENT_SIGNAL_FEEDBACK_INTENT_IDENTIFIER,
  PageAgentIdentifier,
  VerifyToolIdentifier,
  LobeDeliveryCheckerIdentifier,
];

describe('server runtime registry', () => {
  beforeEach(() => {
    mocks.assertToolModuleEnabled.mockReset();
    mocks.assertToolModuleEnabled.mockResolvedValue(undefined);
  });

  it('does not load a disabled module runtime (gate runs before import)', async () => {
    expect(mocks.knowledgeBaseEvaluated).toBe(false);

    mocks.assertToolModuleEnabled.mockRejectedValueOnce(new Error('PLATFORM_MODULE_DISABLED'));

    await expect(getServerRuntime(KnowledgeBaseIdentifier, emptyContext)).rejects.toThrow(
      'PLATFORM_MODULE_DISABLED',
    );
    expect(mocks.knowledgeBaseEvaluated).toBe(false);
    expect(mocks.assertToolModuleEnabled).toHaveBeenCalledWith(KnowledgeBaseIdentifier);
  });

  it('initialises a deferred runtime only once under concurrent first calls', async () => {
    expect(mocks.briefInits).toBe(0);

    const first = getServerRuntime(BriefIdentifier, emptyContext);
    const second = getServerRuntime(BriefIdentifier, emptyContext);

    await vi.waitFor(() => {
      expect(mocks.briefInits).toBe(1);
    });

    mocks.releaseBrief();

    const [left, right] = await Promise.all([first, second]);
    expect(mocks.briefInits).toBe(1);
    expect(left).toEqual({ id: 'brief' });
    expect(right).toBe(left);
  });

  it('resolves every registered identifier to a factory result', async () => {
    mocks.releaseBrief();

    const identifiers = getServerRuntimeIdentifiers();
    expect(identifiers).toEqual(STATIC_IDENTIFIERS);
    expect(new Set(identifiers).size).toBe(STATIC_IDENTIFIERS.length);

    for (const identifier of identifiers) {
      expect(hasServerRuntime(identifier)).toBe(true);
      const pending = getServerRuntime(identifier, emptyContext);
      expect(pending).toBeInstanceOf(Promise);
      const runtime = await pending;
      expect(runtime).toEqual({ id: expect.any(String) });
    }
  });

  it('returns undefined for an unknown identifier (same as before)', async () => {
    expect(hasServerRuntime('not-a-registered-tool')).toBe(false);
    await expect(getServerRuntime('not-a-registered-tool', emptyContext)).resolves.toBeUndefined();
    expect(mocks.assertToolModuleEnabled).toHaveBeenCalledWith('not-a-registered-tool');
  });
});
