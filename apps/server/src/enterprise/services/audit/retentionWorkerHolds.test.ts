// @vitest-environment node
/**
 * Characterization of legal-hold predicates (SAO-009).
 * Records current boolean outcomes — do not "fix" over-skip to under-skip.
 */
import { describe, expect, it } from 'vitest';

import type {
  PlatformAuditExportFilterSnapshot,
  PlatformAuditExportKind,
} from '@/database/models/platform';

import type { HoldIndex } from './retentionWorkerHolds';
import {
  exportArtifactHeld,
  HOLD_CLASS_SENTINEL,
  operationLogHeld,
  topicHeld,
} from './retentionWorkerHolds';

const KINDS = ['operation_logs', 'conversations', 'user_timeline'] as const;

const emptyIndex = (): HoldIndex => ({
  global: false,
  sessions: new Set(),
  topics: new Set(),
  users: new Set(),
  workspaces: new Set(),
});

const indexWith = (partial: Partial<HoldIndex>): HoldIndex => ({
  ...emptyIndex(),
  ...partial,
});

const users = (...ids: string[]) => indexWith({ users: new Set(ids) });
const topics = (...ids: string[]) => indexWith({ topics: new Set(ids) });
const sessions = (...ids: string[]) => indexWith({ sessions: new Set(ids) });
const workspaces = (...ids: string[]) => indexWith({ workspaces: new Set(ids) });

const GLOBAL = indexWith({ global: true });

/** Suppresses every operation_logs broad/partial rule (actor + hold-relevant target). */
const OP_LOG_NARROW = {
  actorUserId: 'actor-unheld',
  targetId: 'target-unheld',
  targetType: 'user',
} as const;

const FILTER_SHAPES: Array<PlatformAuditExportFilterSnapshot | null | undefined> = [
  undefined,
  null,
  {},
  { q: 'search' },
  { action: 'admin.x', from: '2020-01-01T00:00:00.000Z' },
  { userId: 'u1' },
  { actorUserId: 'a1' },
  { actorUserIds: ['a1', 'a2'] },
  { topicId: 't1' },
  { sessionId: 's1' },
  { workspaceId: 'w1' },
  { targetId: 'x1', targetType: 'user' },
  { targetId: 'x1', targetType: 'settings' },
  { targetId: 'x1' },
];

type HeldCase = {
  filter: PlatformAuditExportFilterSnapshot | null | undefined;
  held: boolean;
  index: HoldIndex;
  kind: PlatformAuditExportKind;
  name: string;
};

const runHeldTable = (cases: HeldCase[]) => {
  it.each(cases)('$name', ({ index, kind, filter, held }) => {
    expect(exportArtifactHeld(index, kind, filter)).toBe(held);
  });
};

describe('exportArtifactHeld', () => {
  describe('global hold → true for every kind / filter', () => {
    const cases: HeldCase[] = KINDS.flatMap((kind) =>
      FILTER_SHAPES.map((filter, i) => ({
        filter,
        held: true,
        index: GLOBAL,
        kind,
        name: `${kind} #${i}`,
      })),
    );
    runHeldTable(cases);
  });

  describe('empty index → false for every kind / filter', () => {
    const cases: HeldCase[] = KINDS.flatMap((kind) =>
      FILTER_SHAPES.map((filter, i) => ({
        filter,
        held: false,
        index: emptyIndex(),
        kind,
        name: `${kind} #${i}`,
      })),
    );
    runHeldTable(cases);
  });

  describe('exact pins — hit and miss', () => {
    runHeldTable([
      // userId
      {
        filter: { userId: 'u1' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: 'userId hit (operation_logs)',
      },
      {
        filter: { userId: 'u1' },
        held: true,
        index: users('u1'),
        kind: 'conversations',
        name: 'userId hit (conversations)',
      },
      {
        filter: { userId: 'u1' },
        held: true,
        index: users('u1'),
        kind: 'user_timeline',
        name: 'userId hit (user_timeline)',
      },
      {
        filter: { userId: 'u-miss', ...OP_LOG_NARROW },
        held: false,
        index: users('u1'),
        kind: 'operation_logs',
        name: 'userId miss isolated (operation_logs)',
      },
      {
        filter: { userId: 'u-miss' },
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: 'userId miss (conversations; user holds do not broad-skip)',
      },
      {
        filter: { userId: 'u-miss' },
        held: false,
        index: users('u1'),
        kind: 'user_timeline',
        name: 'userId miss (user_timeline; user holds do not broad-skip)',
      },

      // actorUserId
      {
        filter: { actorUserId: 'a1' },
        held: true,
        index: users('a1'),
        kind: 'operation_logs',
        name: 'actorUserId hit (operation_logs)',
      },
      {
        filter: { actorUserId: 'a1' },
        held: true,
        index: users('a1'),
        kind: 'conversations',
        name: 'actorUserId hit (conversations)',
      },
      {
        filter: { actorUserId: 'a-miss', targetId: 't-unheld', targetType: 'user' },
        held: false,
        index: users('a1'),
        kind: 'operation_logs',
        name: 'actorUserId miss isolated (operation_logs)',
      },
      {
        filter: { actorUserId: 'a-miss' },
        held: false,
        index: users('a1'),
        kind: 'conversations',
        name: 'actorUserId miss (conversations)',
      },

      // actorUserIds[]
      {
        filter: { actorUserIds: ['nope', 'a1'] },
        held: true,
        index: users('a1'),
        kind: 'operation_logs',
        name: 'actorUserIds hit one of many (operation_logs)',
      },
      {
        filter: { actorUserIds: ['a1'] },
        held: true,
        index: users('a1'),
        kind: 'conversations',
        name: 'actorUserIds hit (conversations)',
      },
      {
        filter: { actorUserIds: ['a-miss'], targetId: 't-unheld', targetType: 'user' },
        held: false,
        index: users('a1'),
        kind: 'operation_logs',
        name: 'actorUserIds miss isolated (operation_logs)',
      },
      {
        filter: { actorUserIds: ['a-miss'] },
        held: false,
        index: users('a1'),
        kind: 'conversations',
        name: 'actorUserIds miss (conversations)',
      },
      {
        filter: { actorUserIds: [], targetId: 't-unheld', targetType: 'user' },
        held: true,
        index: users('a1'),
        kind: 'operation_logs',
        name: 'empty actorUserIds is not an actor pin so :231 still holds (operation_logs)',
      },

      // topicId
      {
        filter: { topicId: 't1' },
        held: true,
        index: topics('t1'),
        kind: 'operation_logs',
        name: 'topicId hit (operation_logs)',
      },
      {
        filter: { topicId: 't1' },
        held: true,
        index: topics('t1'),
        kind: 'conversations',
        name: 'topicId hit (conversations)',
      },
      {
        filter: { topicId: 't-miss', ...OP_LOG_NARROW },
        held: false,
        index: topics('t1'),
        kind: 'operation_logs',
        name: 'topicId miss isolated (operation_logs)',
      },
      {
        filter: { topicId: 't-miss' },
        held: false,
        index: topics('t1'),
        kind: 'conversations',
        name: 'topicId miss (conversations; only topics held)',
      },
      {
        filter: { topicId: 't-miss' },
        held: false,
        index: topics('t1'),
        kind: 'user_timeline',
        name: 'topicId miss (user_timeline; only topics held)',
      },

      // sessionId
      {
        filter: { sessionId: 's1' },
        held: true,
        index: sessions('s1'),
        kind: 'operation_logs',
        name: 'sessionId hit (operation_logs)',
      },
      {
        filter: { sessionId: 's1' },
        held: true,
        index: sessions('s1'),
        kind: 'conversations',
        name: 'sessionId hit (conversations)',
      },
      {
        filter: { sessionId: 's-miss', ...OP_LOG_NARROW },
        held: false,
        index: sessions('s1'),
        kind: 'operation_logs',
        name: 'sessionId miss isolated (operation_logs)',
      },
      {
        filter: { sessionId: 's-miss' },
        held: false,
        index: sessions('s1'),
        kind: 'conversations',
        name: 'sessionId miss (conversations; only sessions held)',
      },

      // workspaceId
      {
        filter: { workspaceId: 'w1' },
        held: true,
        index: workspaces('w1'),
        kind: 'operation_logs',
        name: 'workspaceId hit (operation_logs)',
      },
      {
        filter: { workspaceId: 'w1' },
        held: true,
        index: workspaces('w1'),
        kind: 'conversations',
        name: 'workspaceId hit (conversations)',
      },
      {
        filter: { workspaceId: 'w-miss', ...OP_LOG_NARROW },
        held: false,
        index: workspaces('w1'),
        kind: 'operation_logs',
        name: 'workspaceId miss isolated (operation_logs)',
      },
      {
        filter: { workspaceId: 'w-miss' },
        held: false,
        index: workspaces('w1'),
        kind: 'conversations',
        name: 'workspaceId miss (conversations; only workspaces held)',
      },

      // targetId × whitelisted type
      {
        filter: { targetId: 'u1', targetType: 'user' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: 'targetId+user hit (operation_logs)',
      },
      {
        filter: { targetId: 's1', targetType: 'session' },
        held: true,
        index: sessions('s1'),
        kind: 'conversations',
        name: 'targetId+session hit (conversations)',
      },
      {
        filter: { targetId: 't1', targetType: 'topic' },
        held: true,
        index: topics('t1'),
        kind: 'user_timeline',
        name: 'targetId+topic hit (user_timeline)',
      },
      {
        filter: { targetId: 'w1', targetType: 'workspace' },
        held: true,
        index: workspaces('w1'),
        kind: 'operation_logs',
        name: 'targetId+workspace hit (operation_logs)',
      },
      {
        filter: { targetId: 'u-miss', targetType: 'user', actorUserId: 'actor-unheld' },
        held: false,
        index: users('u1'),
        kind: 'operation_logs',
        name: 'targetId+user miss isolated (operation_logs)',
      },
      {
        filter: { targetId: 'u-miss', targetType: 'user' },
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: 'targetId+user miss (conversations)',
      },
      {
        filter: { targetId: 's1', targetType: 'user', actorUserId: 'actor-unheld' },
        held: false,
        index: sessions('s1'),
        kind: 'operation_logs',
        name: 'targetId+user does not match session id (operation_logs isolated)',
      },

      // targetId × unknown type (over-skip any class)
      {
        filter: { targetId: 'u1', targetType: 'settings' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: 'targetId+unknown type hit via users (operation_logs)',
      },
      {
        filter: { targetId: 't1', targetType: 'Settings' },
        held: true,
        index: topics('t1'),
        kind: 'conversations',
        name: 'targetId+unknown type hit via topics (conversations)',
      },
      {
        filter: { targetId: 's1', targetType: 'foo' },
        held: true,
        index: sessions('s1'),
        kind: 'user_timeline',
        name: 'targetId+unknown type hit via sessions (user_timeline)',
      },
      {
        filter: { targetId: 'w1', targetType: 'bar' },
        held: true,
        index: workspaces('w1'),
        kind: 'operation_logs',
        name: 'targetId+unknown type hit via workspaces (operation_logs)',
      },
      {
        filter: { targetId: 'miss', targetType: 'settings' },
        held: false,
        index: topics('t1'),
        kind: 'operation_logs',
        name: 'targetId+unknown type miss isolated via topics only (operation_logs)',
      },
      {
        filter: { targetId: 'miss', targetType: 'settings' },
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: 'targetId+unknown type miss (conversations; user holds only)',
      },
      // Naive miss on operation_logs with a user hold is still over-skipped
      // (rule 235 / 224) — characterizing current behavior, not a bug to "fix".
      {
        filter: { targetId: 'miss', targetType: 'settings' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: 'targetId+unknown type naive miss still held via rule 235 (operation_logs)',
      },

      // targetId × missing type (over-skip any class)
      {
        filter: { targetId: 'u1' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: 'targetId missing type hit via users (operation_logs)',
      },
      {
        filter: { targetId: 't1' },
        held: true,
        index: topics('t1'),
        kind: 'conversations',
        name: 'targetId missing type hit via topics (conversations)',
      },
      {
        filter: { targetId: 'miss' },
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: 'targetId missing type miss (conversations; user holds only)',
      },
      {
        filter: { targetId: 'miss' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: 'targetId missing type naive miss still held via rule 205 (operation_logs)',
      },
      {
        filter: { targetId: 'miss', actorUserId: 'actor-unheld' },
        held: true,
        index: topics('t1'),
        kind: 'operation_logs',
        name: 'targetId missing type + actor pin still held via rule 224 (operation_logs)',
      },
    ]);
  });

  describe('broad / partial rules', () => {
    runHeldTable([
      // Rule :205 — operation_logs && !hasActorPin && !hasAnyTargetPin → true
      {
        filter: {},
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: ':205 held empty filter (operation_logs)',
      },
      {
        filter: { q: 'search', action: 'admin.x', from: '2020-01-01T00:00:00.000Z' },
        held: true,
        index: topics('t1'),
        kind: 'operation_logs',
        name: ':205 held time/action/q only (operation_logs)',
      },
      {
        filter: { userId: 'u-miss' },
        held: true,
        index: sessions('s1'),
        kind: 'operation_logs',
        name: ':205 held userId-only is not an actor/target pin (operation_logs)',
      },
      {
        filter: { ...OP_LOG_NARROW },
        held: false,
        index: users('u1'),
        kind: 'operation_logs',
        name: ':205 free when actor + hold-target pins isolate (operation_logs)',
      },
      {
        filter: {},
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: ':205 does not apply (conversations; user holds only)',
      },
      {
        filter: {},
        held: false,
        index: users('u1'),
        kind: 'user_timeline',
        name: ':205 does not apply (user_timeline; user holds only)',
      },
      {
        filter: {},
        held: true,
        index: indexWith({ users: new Set([HOLD_CLASS_SENTINEL]) }),
        kind: 'operation_logs',
        name: ':205 held via class-presence sentinel (operation_logs)',
      },

      // Rule :211 — conversation kind, no topic/session/workspace pin, t/s/w holds
      {
        filter: {},
        held: true,
        index: topics('t1'),
        kind: 'conversations',
        name: ':211 held empty filter + topic holds (conversations)',
      },
      {
        filter: { userId: 'u-miss', q: 'title' },
        held: true,
        index: sessions('s1'),
        kind: 'user_timeline',
        name: ':211 held userId/q without tighter pin (user_timeline)',
      },
      {
        filter: { actorUserId: 'a-miss' },
        held: true,
        index: workspaces('w1'),
        kind: 'conversations',
        name: ':211 held actor pin does not suppress conversation broad (conversations)',
      },
      {
        filter: { topicId: 't-miss' },
        held: false,
        index: topics('t1'),
        kind: 'conversations',
        name: ':211 free when topic pin + only topics held (conversations)',
      },
      {
        filter: { sessionId: 's-miss' },
        held: false,
        index: sessions('s1'),
        kind: 'user_timeline',
        name: ':211 free when session pin + only sessions held (user_timeline)',
      },
      {
        filter: { userId: 'u-miss' },
        held: true,
        index: topics('t1'),
        kind: 'operation_logs',
        name: ':211 does not apply; :205 still holds (operation_logs)',
      },
      {
        filter: {},
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: ':211 free when only user holds (conversations)',
      },

      // Rule :224 — operation_logs, hasActorPin && !hasHoldTargetPin, any class
      {
        filter: { actorUserId: 'a-miss' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: ':224 held actor pin + user holds (operation_logs)',
      },
      {
        filter: { actorUserIds: ['a-miss'] },
        held: true,
        index: topics('t1'),
        kind: 'operation_logs',
        name: ':224 held actorUserIds + topic holds (operation_logs)',
      },
      {
        filter: { actorUserId: 'a-miss' },
        held: true,
        index: sessions('s1'),
        kind: 'operation_logs',
        name: ':224 held actor pin + session holds (operation_logs)',
      },
      {
        filter: { actorUserId: 'a-miss', targetId: 'x', targetType: 'settings' },
        held: true,
        index: workspaces('w1'),
        kind: 'operation_logs',
        name: ':224 held actor + non-hold target type + workspace holds (operation_logs)',
      },
      {
        filter: { actorUserId: 'a-miss', targetId: 'x', targetType: 'user' },
        held: false,
        index: users('u1'),
        kind: 'operation_logs',
        name: ':224 free when hold-target pin isolates (operation_logs)',
      },
      {
        filter: { actorUserId: 'a-miss' },
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: ':224 does not apply (conversations)',
      },
      {
        filter: { actorUserId: 'a-miss' },
        held: false,
        index: users('u1'),
        kind: 'user_timeline',
        name: ':224 does not apply (user_timeline)',
      },

      // Rule :231 — operation_logs, hasHoldTargetPin && !hasActorPin && users
      {
        filter: { targetId: 'x-miss', targetType: 'session' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: ':231 held hold-target pin + user holds (operation_logs)',
      },
      {
        filter: { targetId: 'x-miss', targetType: 'topic' },
        held: true,
        index: indexWith({ users: new Set([HOLD_CLASS_SENTINEL]) }),
        kind: 'operation_logs',
        name: ':231 held via user-class sentinel (operation_logs)',
      },
      {
        filter: { targetId: 'x-miss', targetType: 'session', actorUserId: 'a-miss' },
        held: false,
        index: users('u1'),
        kind: 'operation_logs',
        name: ':231 free when actor pin isolates (operation_logs)',
      },
      {
        filter: { targetId: 'x-miss', targetType: 'workspace' },
        held: false,
        index: topics('t1'),
        kind: 'operation_logs',
        name: ':231 free when no user holds (operation_logs)',
      },
      {
        filter: { targetId: 'x-miss', targetType: 'session' },
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: ':231 does not apply (conversations)',
      },
      {
        filter: { targetId: 'x-miss', targetType: 'session' },
        held: false,
        index: users('u1'),
        kind: 'user_timeline',
        name: ':231 does not apply (user_timeline)',
      },

      // Rule :235 — operation_logs, non-hold target type, no actor, users
      {
        filter: { targetId: 'x', targetType: 'settings' },
        held: true,
        index: users('u1'),
        kind: 'operation_logs',
        name: ':235 held non-hold target type + user holds (operation_logs)',
      },
      {
        filter: { targetId: 'x', targetType: 'policy' },
        held: true,
        index: indexWith({ users: new Set([HOLD_CLASS_SENTINEL]) }),
        kind: 'operation_logs',
        name: ':235 held via user-class sentinel (operation_logs)',
      },
      {
        filter: { targetId: 'x', targetType: 'settings' },
        held: false,
        index: topics('t1'),
        kind: 'operation_logs',
        name: ':235 free when no user holds (operation_logs)',
      },
      {
        filter: { targetId: 'x', targetType: 'user' },
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: ':235 does not apply (conversations; hold-target + users only)',
      },
      {
        filter: { targetId: 'x', targetType: 'settings' },
        held: false,
        index: users('u1'),
        kind: 'conversations',
        name: ':235 does not apply (conversations; non-hold target + users only)',
      },
      {
        filter: { targetId: 'x', targetType: 'settings' },
        held: false,
        index: users('u1'),
        kind: 'user_timeline',
        name: ':235 does not apply (user_timeline)',
      },

      // Rule :242 — conversation, hasTopicPin && (sessions|workspaces)
      {
        filter: { topicId: 't-miss' },
        held: true,
        index: sessions('s1'),
        kind: 'conversations',
        name: ':242 held topic pin + session holds (conversations)',
      },
      {
        filter: { topicId: 't-miss' },
        held: true,
        index: workspaces('w1'),
        kind: 'user_timeline',
        name: ':242 held topic pin + workspace holds (user_timeline)',
      },
      {
        filter: { topicId: 't-miss' },
        held: false,
        index: topics('t1'),
        kind: 'conversations',
        name: ':242 free when only topics held (conversations)',
      },
      {
        filter: { topicId: 't-miss', ...OP_LOG_NARROW },
        held: false,
        index: sessions('s1'),
        kind: 'operation_logs',
        name: ':242 does not apply (operation_logs isolated)',
      },

      // Rule :246 — conversation, hasSessionPin && !hasTopicPin && (topics|workspaces)
      {
        filter: { sessionId: 's-miss' },
        held: true,
        index: topics('t1'),
        kind: 'conversations',
        name: ':246 held session pin + topic holds (conversations)',
      },
      {
        filter: { sessionId: 's-miss' },
        held: true,
        index: workspaces('w1'),
        kind: 'user_timeline',
        name: ':246 held session pin + workspace holds (user_timeline)',
      },
      {
        filter: { sessionId: 's-miss' },
        held: false,
        index: sessions('s1'),
        kind: 'conversations',
        name: ':246 free when only sessions held (conversations)',
      },
      {
        filter: { sessionId: 's-miss', topicId: 't-miss' },
        held: false,
        index: topics('t1'),
        kind: 'conversations',
        name: ':246 free when topic pin suppresses it (conversations)',
      },
      {
        filter: { sessionId: 's-miss', ...OP_LOG_NARROW },
        held: false,
        index: topics('t1'),
        kind: 'operation_logs',
        name: ':246 does not apply (operation_logs isolated)',
      },

      // Rule :250 — conversation, workspace pin only && (topics|sessions)
      {
        filter: { workspaceId: 'w-miss' },
        held: true,
        index: topics('t1'),
        kind: 'conversations',
        name: ':250 held workspace pin + topic holds (conversations)',
      },
      {
        filter: { workspaceId: 'w-miss' },
        held: true,
        index: sessions('s1'),
        kind: 'user_timeline',
        name: ':250 held workspace pin + session holds (user_timeline)',
      },
      {
        filter: { workspaceId: 'w-miss' },
        held: false,
        index: workspaces('w1'),
        kind: 'conversations',
        name: ':250 free when only workspaces held (conversations)',
      },
      {
        filter: { workspaceId: 'w-miss', topicId: 't-miss' },
        held: false,
        index: topics('t1'),
        kind: 'conversations',
        name: ':250 free when topic pin suppresses it (conversations)',
      },
      {
        filter: { workspaceId: 'w-miss', sessionId: 's-miss' },
        held: false,
        index: sessions('s1'),
        kind: 'user_timeline',
        name: ':250 free when session pin suppresses it (user_timeline)',
      },
      {
        filter: { workspaceId: 'w-miss', ...OP_LOG_NARROW },
        held: false,
        index: topics('t1'),
        kind: 'operation_logs',
        name: ':250 does not apply (operation_logs isolated)',
      },
    ]);
  });
});

describe('operationLogHeld', () => {
  const row = (partial: {
    actorUserId?: string | null;
    targetId?: string | null;
    targetType?: string;
  }) => ({
    actorUserId: partial.actorUserId ?? null,
    targetId: partial.targetId ?? null,
    targetType: partial.targetType ?? '',
  });

  it.each([
    { held: true, index: GLOBAL, name: 'global hold', row: row({}) },
    {
      held: false,
      index: emptyIndex(),
      name: 'empty index',
      row: row({ actorUserId: 'a1', targetId: 't1', targetType: 'user' }),
    },
    { held: true, index: users('a1'), name: 'actorUserId hit', row: row({ actorUserId: 'a1' }) },
    {
      held: false,
      index: users('a1'),
      name: 'actorUserId miss',
      row: row({ actorUserId: 'a-miss' }),
    },
    { held: false, index: users('a1'), name: 'null actorUserId', row: row({ actorUserId: null }) },
    {
      held: false,
      index: users(''),
      name: 'empty-string actorUserId is not a pin',
      row: row({ actorUserId: '' }),
    },
    {
      held: true,
      index: users('u1'),
      name: 'targetType user hit',
      row: row({ targetId: 'u1', targetType: 'user' }),
    },
    {
      held: false,
      index: users('u1'),
      name: 'targetType user miss',
      row: row({ targetId: 'u-miss', targetType: 'user' }),
    },
    {
      held: true,
      index: sessions('s1'),
      name: 'targetType session hit',
      row: row({ targetId: 's1', targetType: 'session' }),
    },
    {
      held: false,
      index: sessions('s1'),
      name: 'targetType session miss',
      row: row({ targetId: 's-miss', targetType: 'session' }),
    },
    {
      held: true,
      index: topics('t1'),
      name: 'targetType topic hit',
      row: row({ targetId: 't1', targetType: 'topic' }),
    },
    {
      held: false,
      index: topics('t1'),
      name: 'targetType topic miss',
      row: row({ targetId: 't-miss', targetType: 'topic' }),
    },
    {
      held: true,
      index: workspaces('w1'),
      name: 'targetType workspace hit',
      row: row({ targetId: 'w1', targetType: 'workspace' }),
    },
    {
      held: false,
      index: workspaces('w1'),
      name: 'targetType workspace miss',
      row: row({ targetId: 'w-miss', targetType: 'workspace' }),
    },
    {
      held: false,
      index: sessions('s1'),
      name: 'whitelisted type does not cross classes',
      row: row({ targetId: 's1', targetType: 'user' }),
    },
    {
      held: true,
      index: users('x1'),
      name: 'unknown type over-skip via users',
      row: row({ targetId: 'x1', targetType: 'settings' }),
    },
    {
      held: true,
      index: sessions('x1'),
      name: 'unknown type over-skip via sessions',
      row: row({ targetId: 'x1', targetType: 'settings' }),
    },
    {
      held: true,
      index: topics('x1'),
      name: 'unknown type over-skip via topics',
      row: row({ targetId: 'x1', targetType: 'settings' }),
    },
    {
      held: true,
      index: workspaces('x1'),
      name: 'unknown type over-skip via workspaces',
      row: row({ targetId: 'x1', targetType: 'settings' }),
    },
    {
      held: false,
      index: users('u1'),
      name: 'unknown type miss',
      row: row({ targetId: 'miss', targetType: 'settings' }),
    },
    {
      held: false,
      index: users('u1'),
      name: 'missing targetId',
      row: row({ targetId: null, targetType: 'user' }),
    },
    {
      held: true,
      index: users('u1'),
      name: 'empty targetType is unknown-type over-skip',
      row: row({ targetId: 'u1', targetType: '' }),
    },
    {
      held: false,
      index: users('u1'),
      name: 'empty targetType miss',
      row: row({ targetId: 'miss', targetType: '' }),
    },
  ])('$name', ({ index, row: r, held }) => {
    expect(operationLogHeld(index, r)).toBe(held);
  });
});

describe('topicHeld', () => {
  const row = (partial: {
    id?: string;
    sessionId?: string | null;
    userId?: string;
    workspaceId?: string | null;
  }) => ({
    id: partial.id ?? 'topic-1',
    sessionId: partial.sessionId === undefined ? 'session-1' : partial.sessionId,
    userId: partial.userId ?? 'user-1',
    workspaceId: partial.workspaceId === undefined ? 'ws-1' : partial.workspaceId,
  });

  it.each([
    { held: true, index: GLOBAL, name: 'global hold', row: row({}) },
    { held: false, index: emptyIndex(), name: 'empty index', row: row({}) },
    { held: true, index: users('user-1'), name: 'userId hit', row: row({ userId: 'user-1' }) },
    { held: false, index: users('other'), name: 'userId miss', row: row({ userId: 'user-1' }) },
    { held: true, index: topics('topic-1'), name: 'topic id hit', row: row({ id: 'topic-1' }) },
    { held: false, index: topics('other'), name: 'topic id miss', row: row({ id: 'topic-1' }) },
    {
      held: true,
      index: sessions('session-1'),
      name: 'sessionId hit',
      row: row({ sessionId: 'session-1' }),
    },
    {
      held: false,
      index: sessions('other'),
      name: 'sessionId miss',
      row: row({ sessionId: 'session-1' }),
    },
    {
      held: false,
      index: sessions('session-1'),
      name: 'null sessionId',
      row: row({ sessionId: null }),
    },
    {
      held: true,
      index: workspaces('ws-1'),
      name: 'workspaceId hit',
      row: row({ workspaceId: 'ws-1' }),
    },
    {
      held: false,
      index: workspaces('other'),
      name: 'workspaceId miss',
      row: row({ workspaceId: 'ws-1' }),
    },
    {
      held: false,
      index: workspaces('ws-1'),
      name: 'null workspaceId',
      row: row({ workspaceId: null }),
    },
  ])('$name', ({ index, row: r, held }) => {
    expect(topicHeld(index, r)).toBe(held);
  });
});
