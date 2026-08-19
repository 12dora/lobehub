import type {
  AdminAuditExportsCreateInput,
  AdminAuditPolicy,
} from '@/enterprise/client/services/adminAudit';

import { parseAuditDate } from '../shared/timeWindow';

export type ExportKind = AdminAuditExportsCreateInput['kind'];

export interface ExportCreateDraft {
  action: string;
  actorUserId: string | undefined;
  includeBodies: boolean;
  kind: ExportKind;
  q: string;
  range: [Date, Date];
  step: number;
  topicId: string;
  userId: string | undefined;
}

export const parseExportPrefill = (
  searchParams: URLSearchParams | undefined,
  freshWindow: { from: Date; to: Date },
): ExportCreateDraft => {
  let nextKind: ExportKind = 'operation_logs';
  let nextRange: [Date, Date] = [freshWindow.from, freshWindow.to];
  let nextUserId: string | undefined;
  let nextActorUserId: string | undefined;
  let nextTopicId = '';
  let nextQ = '';
  const nextIncludeBodies = false;
  let nextAction = '';
  let nextStep = 0;

  if (searchParams) {
    const k = searchParams.get('kind');
    if (k === 'operation_logs' || k === 'conversations' || k === 'user_timeline') {
      nextKind = k;
      nextStep = 1;
    }
    const from = parseAuditDate(searchParams.get('from'));
    const to = parseAuditDate(searchParams.get('to'));
    if (from && to) nextRange = [from, to];
    const act = searchParams.get('action');
    if (act) nextAction = act;
    const uid = searchParams.get('userId');
    if (uid) nextUserId = uid;
    const actor = searchParams.get('actorUserId');
    if (actor) nextActorUserId = actor;
    const tid = searchParams.get('topicId');
    if (tid) nextTopicId = tid;
    const query = searchParams.get('q');
    if (query) nextQ = query;
  }

  return {
    action: nextAction,
    actorUserId: nextActorUserId,
    includeBodies: nextIncludeBodies,
    kind: nextKind,
    q: nextQ,
    range: nextRange,
    step: nextStep,
    topicId: nextTopicId,
    userId: nextUserId,
  };
};

export const exportBodyAllowed = (
  canReadPolicy: boolean,
  policy: Pick<AdminAuditPolicy, 'contentAccessMode' | 'messageBodyInExport'> | null | undefined,
): boolean =>
  Boolean(
    canReadPolicy && policy?.contentAccessMode === 'content_allowed' && policy?.messageBodyInExport,
  );

export const canAdvanceFromFilters = (
  kind: ExportKind,
  range: readonly [unknown, unknown],
  userId: string | undefined,
): boolean => {
  if (!range[0] || !range[1]) return false;
  if ((kind === 'conversations' || kind === 'user_timeline') && !userId) return false;
  return true;
};

export const buildExportCreateInput = (
  draft: ExportCreateDraft,
  reason: string,
  bodyAllowed: boolean,
): AdminAuditExportsCreateInput => {
  const base: AdminAuditExportsCreateInput = {
    from: draft.range[0],
    kind: draft.kind,
    reason,
    to: draft.range[1],
  };
  if (draft.kind === 'operation_logs') {
    if (draft.action.trim()) base.action = draft.action.trim();
    if (draft.actorUserId) base.actorUserId = draft.actorUserId;
  }
  if (draft.kind === 'conversations' || draft.kind === 'user_timeline') {
    base.userId = draft.userId;
  }
  if (draft.kind === 'conversations') {
    if (draft.topicId.trim()) base.topicId = draft.topicId.trim();
    if (draft.q.trim()) base.q = draft.q.trim();
    if (draft.includeBodies && bodyAllowed) base.includeMessageBodies = true;
  }
  return base;
};
