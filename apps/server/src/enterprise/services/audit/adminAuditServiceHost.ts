/** Host surface shared by AdminAuditService domain modules (SAO-009). */

import type {
  PlatformAuditConversationModel,
  PlatformAuditLegalHoldModel,
  PlatformAuditLogModel,
  PlatformAuditPolicyModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

export type AdminAuditServiceHost = {
  conversationModel: PlatformAuditConversationModel;
  db: LobeChatDatabase | Transaction;
  legalHoldModel: PlatformAuditLegalHoldModel;
  logModel: PlatformAuditLogModel;
  policyModel: PlatformAuditPolicyModel;
};
