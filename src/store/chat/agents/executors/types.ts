import type { ToolsEngine } from '@lobechat/context-engine';
import type { MessageMetadata } from '@lobechat/types';

import type { ResolvedAgentConfig } from '@/services/chat/mecha';
import type { ChatStore } from '@/store/chat/store';

export interface CreateAgentExecutorsContext {
  /** Pre-resolved agent config with isSubAgent filtering applied */
  agentConfig: ResolvedAgentConfig;
  get: () => ChatStore;
  messageKey: string;
  metadata?: Pick<MessageMetadata, 'trigger'>;
  operationId: string;
  parentId: string;
  skipCreateFirstMessage?: boolean;
  /** ToolsEngine for expanding dynamically activated tools */
  toolsEngine?: ToolsEngine;
}
