/**
 * Server Runtime Registry
 *
 * Central registry for all builtin tool server runtimes.
 * Uses factory functions to support both:
 * - Pre-instantiated runtimes (e.g., WebBrowsing - no per-request context needed)
 * - Per-request runtimes (e.g., CloudSandbox - needs topicId, userId)
 *
 * Identifiers come from the light `@lobechat/builtin-tool-*` roots. Each
 * execution body is loaded with `import()` on first use so a chat request
 * does not pull every runtime (discord.js, search providers, editor, …).
 */
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

import { assertToolModuleEnabled } from '@/server/enterprise/guards/toolModuleGate';

import type { ToolExecutionContext } from '../types';
import type { ServerRuntimeFactory, ServerRuntimeRegistration } from './types';

/**
 * Memoised dynamic import of each runtime module. `import()` is cached by the
 * loader; this Map additionally shares the pending factory so concurrent first
 * calls do not double-init pre-instantiated runtimes.
 */
const loadedFactories = new Map<string, Promise<ServerRuntimeFactory>>();

const lazyRuntime = (
  identifier: string,
  load: () => Promise<ServerRuntimeRegistration>,
): ServerRuntimeRegistration => ({
  factory: async (context) => {
    let pending = loadedFactories.get(identifier);
    if (!pending) {
      pending = (async () => {
        const registration = await load();
        return registration.factory;
      })();
      loadedFactories.set(identifier, pending);
    }
    const factory = await pending;
    return factory(context);
  },
  identifier,
});

/**
 * Static identifier list — `has` / `list` stay eager without loading runtimes.
 * Order matches the historical registration order.
 */
const SERVER_RUNTIME_REGISTRATIONS: ServerRuntimeRegistration[] = [
  lazyRuntime(
    AgentBuilderIdentifier,
    async () => (await import('./agentBuilder')).agentBuilderRuntime,
  ),
  lazyRuntime(
    WebBrowsingManifest.identifier,
    async () => (await import('./webBrowsing')).webBrowsingRuntime,
  ),
  lazyRuntime(
    CloudSandboxIdentifier,
    async () => (await import('./cloudSandbox')).cloudSandboxRuntime,
  ),
  lazyRuntime(CalculatorIdentifier, async () => (await import('./calculator')).calculatorRuntime),
  lazyRuntime(
    DocumentPagesIdentifier,
    async () => (await import('./documentPages')).documentPagesRuntime,
  ),
  lazyRuntime(
    AgentDocumentsIdentifier,
    async () => (await import('./agentDocuments')).agentDocumentsRuntime,
  ),
  lazyRuntime(
    AgentManagementIdentifier,
    async () => (await import('./agentManagement')).agentManagementRuntime,
  ),
  lazyRuntime(
    SkillMaintainerIdentifier,
    async () => (await import('./skillManagement')).skillManagementRuntime,
  ),
  lazyRuntime(NotebookIdentifier, async () => (await import('./notebook')).notebookRuntime),
  lazyRuntime(SkillStoreIdentifier, async () => (await import('./skillStore')).skillStoreRuntime),
  lazyRuntime(SkillsIdentifier, async () => (await import('./skills')).skillsRuntime),
  lazyRuntime(MemoryIdentifier, async () => (await import('./memory')).memoryRuntime),
  lazyRuntime(LobeActivatorIdentifier, async () => (await import('./activator')).activatorRuntime),
  lazyRuntime(MessageToolIdentifier, async () => (await import('./message')).messageRuntime),
  lazyRuntime(
    LocalSystemIdentifier,
    async () => (await import('./localSystem')).localSystemRuntime,
  ),
  lazyRuntime(
    RemoteDeviceIdentifier,
    async () => (await import('./remoteDevice')).remoteDeviceRuntime,
  ),
  lazyRuntime(BriefIdentifier, async () => (await import('./brief')).briefRuntime),
  lazyRuntime(TaskIdentifier, async () => (await import('./task')).taskRuntime),
  lazyRuntime(
    TopicReferenceIdentifier,
    async () => (await import('./topicReference')).topicReferenceRuntime,
  ),
  lazyRuntime(
    UserInteractionIdentifier,
    async () => (await import('./userInteraction')).userInteractionRuntime,
  ),
  lazyRuntime(CredsIdentifier, async () => (await import('./creds')).credsRuntime),
  lazyRuntime(
    GroupManagementIdentifier,
    async () => (await import('./groupManagement')).groupManagementRuntime,
  ),
  lazyRuntime(
    KnowledgeBaseIdentifier,
    async () => (await import('./knowledgeBase')).knowledgeBaseRuntime,
  ),
  lazyRuntime(
    WebOnboardingIdentifier,
    async () => (await import('./webOnboarding')).webOnboardingRuntime,
  ),
  lazyRuntime(LobeAgentIdentifier, async () => (await import('./lobeAgent')).lobeAgentRuntime),
  lazyRuntime(
    SELF_FEEDBACK_INTENT_IDENTIFIER,
    async () => (await import('./selfFeedbackIntent')).selfFeedbackIntentRuntime,
  ),
  lazyRuntime(
    AGENT_SIGNAL_SKILL_MANAGEMENT_IDENTIFIER,
    async () => (await import('./agentSignalSkillManagement')).agentSignalSkillManagementRuntime,
  ),
  lazyRuntime(
    AGENT_SIGNAL_REVIEW_IDENTIFIER,
    async () => (await import('./agentSignalReview')).agentSignalReviewRuntime,
  ),
  lazyRuntime(
    AGENT_SIGNAL_REFLECTION_IDENTIFIER,
    async () => (await import('./agentSignalReflection')).agentSignalReflectionRuntime,
  ),
  lazyRuntime(
    AGENT_SIGNAL_FEEDBACK_INTENT_IDENTIFIER,
    async () => (await import('./agentSignalFeedbackIntent')).agentSignalFeedbackIntentRuntime,
  ),
  lazyRuntime(PageAgentIdentifier, async () => (await import('./pageAgent')).pageAgentRuntime),
  lazyRuntime(
    VerifyToolIdentifier,
    async () => (await import('./verifyResult')).verifyResultRuntime,
  ),
  lazyRuntime(
    LobeDeliveryCheckerIdentifier,
    async () => (await import('./lobeDeliveryChecker')).lobeDeliveryCheckerRuntime,
  ),
];

/**
 * Registry of server runtime factories by identifier
 */
const serverRuntimeFactories = new Map<string, ServerRuntimeFactory>();

/**
 * Register server runtimes
 */
const registerRuntimes = (runtimes: ServerRuntimeRegistration[]) => {
  for (const runtime of runtimes) {
    serverRuntimeFactories.set(runtime.identifier, runtime.factory);
  }
};

registerRuntimes(SERVER_RUNTIME_REGISTRATIONS);

// ==================== Registry API ====================

/**
 * Get a server runtime by identifier
 * @param identifier - The tool identifier
 * @param context - Execution context (required for per-request runtimes)
 * @returns Runtime instance (may be a Promise for async factories)
 */
export const getServerRuntime = async (
  identifier: string,
  context: ToolExecutionContext,
): Promise<any> => {
  // Gate BEFORE import — a disabled module's runtime must not even load.
  await assertToolModuleEnabled(identifier);
  const factory = serverRuntimeFactories.get(identifier);
  return factory?.(context);
};

/**
 * Check if a server runtime exists for the given identifier
 */
export const hasServerRuntime = (identifier: string): boolean => {
  return serverRuntimeFactories.has(identifier);
};

/**
 * Get all registered server runtime identifiers
 */
export const getServerRuntimeIdentifiers = (): string[] => {
  return Array.from(serverRuntimeFactories.keys());
};
