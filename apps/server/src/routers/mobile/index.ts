/**
 * This file contains the root router of Lobe Chat tRPC-backend for Mobile App
 * Only includes routers that are actually used by the mobile client
 */
import { publicProcedure, router } from '@/libs/trpc/lambda';
import { lazyRouter } from '@/server/enterprise/routers/lazyRouter';
import { moduleRouter } from '@/server/enterprise/routers/moduleRouter';

export const mobileRouter = router({
  agent: lazyRouter(() => import('../lambda/agent').then((m) => m.agentRouter)),
  agentSkills: lazyRouter(() => import('../lambda/agentSkills').then((m) => m.agentSkillsRouter)),
  aiAgent: lazyRouter(() => import('../lambda/aiAgent').then((m) => m.aiAgentRouter)),
  aiChat: lazyRouter(() => import('../lambda/aiChat').then((m) => m.aiChatRouter)),
  brief: lazyRouter(() => import('../lambda/brief').then((m) => m.briefRouter)),
  aiModel: lazyRouter(() => import('../lambda/aiModel').then((m) => m.aiModelRouter)),
  aiProvider: lazyRouter(() => import('../lambda/aiProvider').then((m) => m.aiProviderRouter)),
  chunk: moduleRouter('knowledgeBase', () => import('../lambda/chunk').then((m) => m.chunkRouter)),
  composio: lazyRouter(() => import('../lambda/composio').then((m) => m.composioRouter)),
  config: lazyRouter(() => import('../lambda/config').then((m) => m.configRouter)),
  device: lazyRouter(() => import('../lambda/device').then((m) => m.deviceRouter)),
  document: lazyRouter(() => import('../lambda/document').then((m) => m.documentRouter)),
  file: lazyRouter(() => import('../lambda/file').then((m) => m.fileRouter)),
  healthcheck: publicProcedure.query(() => "i'm live!"),
  home: lazyRouter(() => import('../lambda/home').then((m) => m.homeRouter)),
  knowledgeBase: moduleRouter('knowledgeBase', () =>
    import('../lambda/knowledgeBase').then((m) => m.knowledgeBaseRouter),
  ),
  market: moduleRouter('market', () => import('../lambda/market').then((m) => m.marketRouter)),
  message: lazyRouter(() => import('../lambda/message').then((m) => m.messageRouter)),
  plugin: lazyRouter(() => import('../lambda/plugin').then((m) => m.pluginRouter)),
  pushToken: lazyRouter(() => import('../lambda/pushToken').then((m) => m.pushTokenRouter)),
  session: lazyRouter(() => import('../lambda/session').then((m) => m.sessionRouter)),
  sessionGroup: lazyRouter(() =>
    import('../lambda/sessionGroup').then((m) => m.sessionGroupRouter),
  ),
  subscription: lazyRouter(() =>
    import('@/business/server/mobile-routers/mobileSubscription').then(
      (m) => m.mobileSubscriptionRouter,
    ),
  ),
  task: lazyRouter(() => import('../lambda/task').then((m) => m.taskRouter)),
  taskTemplate: moduleRouter('taskTemplates', () =>
    import('../lambda/taskTemplate').then((m) => m.taskTemplateRouter),
  ),
  topic: lazyRouter(() => import('../lambda/topic').then((m) => m.topicRouter)),
  upload: lazyRouter(() => import('../lambda/upload').then((m) => m.uploadRouter)),
  user: lazyRouter(() => import('../lambda/user').then((m) => m.userRouter)),
});
