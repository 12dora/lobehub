/**
 * This file contains the root router of Lobe Chat tRPC-backend
 */
import { publicProcedure, router } from '@/libs/trpc/lambda';
import { adminRouter } from '@/server/enterprise/routers/admin';
import { lazyRouter } from '@/server/enterprise/routers/lazyRouter';
import { moduleRouter } from '@/server/enterprise/routers/moduleRouter';
import { platformRouter } from '@/server/enterprise/routers/platform';

import { configRouter } from './config';
import { userRouter } from './user';

export const lambdaRouter = router({
  admin: adminRouter,
  agent: lazyRouter(() => import('./agent').then((m) => m.agentRouter)),
  agentBotProvider: moduleRouter('bots', () =>
    import('./agentBotProvider').then((m) => m.agentBotProviderRouter),
  ),
  agentNotify: lazyRouter(() => import('./agentNotify').then((m) => m.agentNotifyRouter)),
  botMessage: moduleRouter('bots', () => import('./botMessage').then((m) => m.botMessageRouter)),
  agentDocument: lazyRouter(() => import('./agentDocument').then((m) => m.agentDocumentRouter)),
  agentEval: lazyRouter(() => import('./agentEval').then((m) => m.agentEvalRouter)),
  agentEvalExternal: lazyRouter(() =>
    import('./agentEvalExternal').then((m) => m.agentEvalExternalRouter),
  ),
  agentSkills: lazyRouter(() => import('./agentSkills').then((m) => m.agentSkillsRouter)),
  agentSignal: moduleRouter('agentSignal', () =>
    import('./agentSignal').then((m) => m.agentSignalRouter),
  ),
  task: lazyRouter(() => import('./task').then((m) => m.taskRouter)),
  changelog: lazyRouter(() => import('./changelog').then((m) => m.changelogRouter)),
  brief: lazyRouter(() => import('./brief').then((m) => m.briefRouter)),
  aiAgent: lazyRouter(() => import('./aiAgent').then((m) => m.aiAgentRouter)),
  aiChat: lazyRouter(() => import('./aiChat').then((m) => m.aiChatRouter)),
  aiModel: lazyRouter(() => import('./aiModel').then((m) => m.aiModelRouter)),
  aiProvider: lazyRouter(() => import('./aiProvider').then((m) => m.aiProviderRouter)),
  apiKey: lazyRouter(() => import('./apiKey').then((m) => m.apiKeyRouter)),
  asr: moduleRouter('speech', () => import('./asr').then((m) => m.asrRouter)),
  chunk: moduleRouter('knowledgeBase', () => import('./chunk').then((m) => m.chunkRouter)),
  comfyui: moduleRouter('imageGen', () => import('./comfyui').then((m) => m.comfyuiRouter)),
  config: configRouter,
  connector: lazyRouter(() => import('./connector').then((m) => m.connectorRouter)),
  device: lazyRouter(() => import('./device').then((m) => m.deviceRouter)),
  document: lazyRouter(() => import('./document').then((m) => m.documentRouter)),
  exporter: lazyRouter(() => import('./exporter').then((m) => m.exporterRouter)),
  file: lazyRouter(() => import('./file').then((m) => m.fileRouter)),
  followUpAction: lazyRouter(() => import('./followUpAction').then((m) => m.followUpActionRouter)),
  generation: moduleRouter('imageGen', () =>
    import('./generation').then((m) => m.generationRouter),
  ),
  generationBatch: moduleRouter('imageGen', () =>
    import('./generationBatch').then((m) => m.generationBatchRouter),
  ),
  generationTopic: moduleRouter('imageGen', () =>
    import('./generationTopic').then((m) => m.generationTopicRouter),
  ),
  group: lazyRouter(() => import('./agentGroup').then((m) => m.agentGroupRouter)),
  healthcheck: publicProcedure.query(() => "i'm live!"),
  home: lazyRouter(() => import('./home').then((m) => m.homeRouter)),
  image: moduleRouter('imageGen', () => import('./image').then((m) => m.imageRouter)),
  importer: lazyRouter(() => import('./importer').then((m) => m.importerRouter)),
  composio: lazyRouter(() => import('./composio').then((m) => m.composioRouter)),

  klavis: lazyRouter(() => import('./klavis').then((m) => m.klavisRouter)),
  knowledge: lazyRouter(() => import('./knowledge').then((m) => m.knowledgeRouter)),
  knowledgeBase: moduleRouter('knowledgeBase', () =>
    import('./knowledgeBase').then((m) => m.knowledgeBaseRouter),
  ),
  llmGenerationTracing: lazyRouter(() =>
    import('./llmGenerationTracing').then((m) => m.llmGenerationTracingRouter),
  ),
  market: moduleRouter('market', () => import('./market').then((m) => m.marketRouter)),
  message: lazyRouter(() => import('./message').then((m) => m.messageRouter)),
  messenger: moduleRouter('bots', () => import('./messenger').then((m) => m.messengerRouter)),
  notebook: lazyRouter(() => import('./notebook').then((m) => m.notebookRouter)),
  notification: lazyRouter(() => import('./notification').then((m) => m.notificationRouter)),
  oauthDeviceFlow: lazyRouter(() =>
    import('./oauthDeviceFlow').then((m) => m.oauthDeviceFlowRouter),
  ),
  platform: platformRouter,
  plugin: lazyRouter(() => import('./plugin').then((m) => m.pluginRouter)),
  pushToken: lazyRouter(() => import('./pushToken').then((m) => m.pushTokenRouter)),
  ragEval: moduleRouter('knowledgeBase', () => import('./ragEval').then((m) => m.ragEvalRouter)),
  recent: lazyRouter(() => import('./recent').then((m) => m.recentRouter)),
  search: lazyRouter(() => import('./search').then((m) => m.searchRouter)),
  session: lazyRouter(() => import('./session').then((m) => m.sessionRouter)),
  sessionGroup: lazyRouter(() => import('./sessionGroup').then((m) => m.sessionGroupRouter)),
  share: lazyRouter(() => import('./share').then((m) => m.shareRouter)),
  thread: lazyRouter(() => import('./thread').then((m) => m.threadRouter)),
  topic: lazyRouter(() => import('./topic').then((m) => m.topicRouter)),
  upload: lazyRouter(() => import('./upload').then((m) => m.uploadRouter)),
  usage: lazyRouter(() => import('./usage').then((m) => m.usageRouter)),
  user: userRouter,
  userMemories: moduleRouter('memory', () =>
    import('./userMemories').then((m) => m.userMemoriesRouter),
  ),
  userMemory: moduleRouter('memory', () => import('./userMemory').then((m) => m.userMemoryRouter)),
  verify: lazyRouter(() => import('./verify').then((m) => m.verifyRouter)),
  video: moduleRouter('imageGen', () => import('./video').then((m) => m.videoRouter)),
  webBrowsing: moduleRouter('webSearch', () =>
    import('./webBrowsing').then((m) => m.webBrowsingRouter),
  ),
  workspace: lazyRouter(() =>
    import('@/business/server/lambda-routers/workspace').then((m) => m.workspaceRouter),
  ),
  workspaceAuditLog: lazyRouter(() =>
    import('@/business/server/lambda-routers/workspaceAuditLog').then(
      (m) => m.workspaceAuditLogRouter,
    ),
  ),
  workspaceCreds: lazyRouter(() =>
    import('@/business/server/lambda-routers/workspaceCreds').then((m) => m.workspaceCredsRouter),
  ),
  workspaceCredits: lazyRouter(() =>
    import('@/business/server/lambda-routers/workspaceCredits').then(
      (m) => m.workspaceCreditsRouter,
    ),
  ),
  workspaceData: lazyRouter(() =>
    import('@/business/server/lambda-routers/workspaceData').then((m) => m.workspaceDataRouter),
  ),
  workspaceMember: lazyRouter(() =>
    import('@/business/server/lambda-routers/workspaceMember').then((m) => m.workspaceMemberRouter),
  ),
  workspaceUsage: lazyRouter(() =>
    import('@/business/server/lambda-routers/workspaceUsage').then((m) => m.workspaceUsageRouter),
  ),
  accountDeletion: lazyRouter(() =>
    import('@/business/server/lambda-routers/accountDeletion').then((m) => m.accountDeletionRouter),
  ),
  pageShare: lazyRouter(() =>
    import('@/business/server/lambda-routers/pageShare').then((m) => m.pageShareRouter),
  ),
  referral: lazyRouter(() =>
    import('@/business/server/lambda-routers/referral').then((m) => m.referralRouter),
  ),
  spend: lazyRouter(() =>
    import('@/business/server/lambda-routers/spend').then((m) => m.spendRouter),
  ),
  storageOverage: lazyRouter(() =>
    import('@/business/server/lambda-routers/storageOverage').then((m) => m.storageOverageRouter),
  ),
  subscription: lazyRouter(() =>
    import('@/business/server/lambda-routers/subscription').then((m) => m.subscriptionRouter),
  ),
  taskTemplate: moduleRouter('taskTemplates', () =>
    import('./taskTemplate').then((m) => m.taskTemplateRouter),
  ),
  topUp: lazyRouter(() =>
    import('@/business/server/lambda-routers/topUp').then((m) => m.topUpRouter),
  ),
});

export type LambdaRouter = typeof lambdaRouter;
