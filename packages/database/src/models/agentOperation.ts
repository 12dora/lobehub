import type {
  PlatformOperationMetadata,
  PlatformOperationModelPin,
  PlatformOperationPin,
  VerifyRunStatus,
} from '@lobechat/types';
import { and, eq, gte, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';

import { today } from '@/utils/time';

import type {
  AgentOperationAppContext,
  AgentOperationError,
  AgentOperationInterruption,
  NewAgentOperation,
} from '../schemas/agentOperations';
import { agentOperations } from '../schemas/agentOperations';
import type { LobeChatDatabase } from '../type';
import { buildWorkspaceWhere } from '../utils/workspace';

/**
 * A platform operation start collided with an existing `agent_operations` row that is NOT a
 * byte-for-byte exact-idempotent replay of this start (a different owner/workspace, an ordinary /
 * missing-pin row, or inconsistent pins). Thrown so the runtime fails the start CLOSED instead of
 * silently continuing on a row whose (wrong) metadata would route the per-call model runtime to the
 * managed *latest* pointer (M10 PR-049 · RR3-2). Stable + identifier-free.
 */
/**
 * The ONLY operation status an EXTERNAL (execAgent message-anchor) platform resume may replay a pin
 * from (M10 PR-049 · RR4-2): a turn genuinely parked on human intervention. `waiting_for_async_tool`
 * is deliberately excluded — an async-tool park resumes INTERNALLY under the SAME operationId via a
 * state CAS (`tryResumeFromAsyncTool`), never through an external message anchor. Terminal
 * (`done`/`error`/`interrupted`) and pre-start (`idle`/`running`) rows are never a resume source, so
 * a completed historical operation can't be derived from indefinitely.
 */
const RESUMABLE_OPERATION_STATUSES = ['waiting_for_human'] as const;

/**
 * The ONLY previous statuses an atomic human-intervention park may transition FROM (M10 PR-049 ·
 * RR5-3): a live `running` op, or an idempotent re-park of an already `waiting_for_human` op (same
 * server-computed anchors). A terminal / cancelled / interrupted op is deliberately excluded so a
 * late or duplicate park can never resurrect it back into a paused, resumable state.
 */
const PARK_EXPECTED_PREV_STATUSES = ['running', 'waiting_for_human'] as const;

export class PlatformOperationStartConflictError extends Error {
  constructor() {
    super('PLATFORM_OPERATION_START_CONFLICT');
    this.name = 'PlatformOperationStartConflictError';
  }
}

/** Order-independent deep equality for the secret-free pin objects/arrays stored in metadata. */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};
const pinsEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonicalize(a ?? null)) === JSON.stringify(canonicalize(b ?? null));

/**
 * A platform start's metadata is COMPLETE only when EVERY exact-binding field is present (M10 PR-049
 * · RR4-3): the operation pin, the model pin, the skill + connector ref arrays (an EMPTY array is
 * valid — `undefined` is not), and the server-owned assistant-message anchor. Incompleteness on
 * either side of a start conflict is a mismatch (never idempotent).
 */
const isCompletePlatformStartMetadata = (
  meta: PlatformOperationMetadata | undefined,
): meta is Required<
  Pick<
    PlatformOperationMetadata,
    | 'assistantMessageId'
    | 'platformConnectors'
    | 'platformModel'
    | 'platformOperation'
    | 'platformSkills'
  >
> &
  PlatformOperationMetadata =>
  !!meta &&
  !!meta.platformOperation &&
  !!meta.platformModel &&
  Array.isArray(meta.platformSkills) &&
  Array.isArray(meta.platformConnectors) &&
  typeof meta.assistantMessageId === 'string' &&
  meta.assistantMessageId.length > 0;

/**
 * The exact-binding fields that mark an operation's start metadata as PLATFORM-managed (M10 PR-049 ·
 * RR5-4). The presence of ANY one of them means the row must carry the COMPLETE set — otherwise a
 * start that dropped, say, the model pin but kept the operation pin would slip through as "ordinary"
 * and later route every LLM call to the managed *latest* pointer.
 */
const PLATFORM_START_MARKER_FIELDS = [
  'assistantMessageId',
  'platformConnectors',
  'platformModel',
  'platformOperation',
  'platformSkills',
] as const;

/**
 * Classify a start's metadata into a single, unambiguous bucket (M10 PR-049 · RR5-4), shared by
 * `recordStart` and the completion-lifecycle park so the two never diverge:
 *
 * - `ordinary`  — carries NO platform marker field at all; the upstream idempotent no-op applies.
 * - `complete`  — carries a marker AND the FULL exact binding (`isCompletePlatformStartMetadata`).
 * - `partial`   — carries SOME marker but not the full set; this is INVALID and must fail closed,
 *   never silently downgrade to `ordinary`.
 *
 * Keying on any-marker-present (not just `platformOperation`) is what prevents a partial platform
 * start from masquerading as ordinary.
 */
export const classifyPlatformStart = (
  meta: PlatformOperationMetadata | undefined,
): 'complete' | 'ordinary' | 'partial' => {
  if (!meta) return 'ordinary';
  const hasMarker = PLATFORM_START_MARKER_FIELDS.some(
    (field) => (meta as Record<string, unknown>)[field] !== undefined,
  );
  if (!hasMarker) return 'ordinary';
  return isCompletePlatformStartMetadata(meta) ? 'complete' : 'partial';
};

/**
 * Verify rollup states. Aliases the single `VerifyRunStatus` source of truth in
 * `@lobechat/types` (which also backs the `verify_status` column enum and
 * `verify_runs.status`) so the three never drift.
 */
export type VerifyStatus = VerifyRunStatus;

export interface RecordOperationStartParams {
  agentId?: string | null;
  appContext?: AgentOperationAppContext;
  chatGroupId?: string | null;
  maxSteps?: number;
  /**
   * Durable per-run metadata persisted on the operation row (jsonb). Carries the
   * Agent Signal run marker so server-side tools can read it back from the row
   * (`metadata.agentSignal`) at tool-call time.
   */
  metadata?: Record<string, unknown>;
  model?: string;
  modelRuntimeConfig?: Record<string, unknown>;
  operationId: string;
  parentOperationId?: string | null;
  provider?: string;
  startedAt?: Date;
  taskId?: string | null;
  threadId?: string | null;
  topicId?: string | null;
  trigger?: string;
}

export interface RecordOperationCompletionParams {
  completedAt?: Date;
  completionReason?:
    | 'done'
    | 'error'
    | 'interrupted'
    | 'max_steps'
    | 'cost_limit'
    | 'waiting_for_human'
    | 'waiting_for_async_tool';
  cost?: Record<string, unknown> | null;
  error?: AgentOperationError | null;
  interruption?: AgentOperationInterruption | null;
  llmCalls?: number | null;
  /** Backfill the executed model when it's only known at completion (e.g. a
   * heterogeneous run learns its real model from the CLI mid-stream). Omit to
   * keep the value seeded at `recordStart`. */
  model?: string | null;
  processingTimeMs?: number | null;
  /** Backfill the executed provider — see {@link RecordOperationCompletionParams.model}. */
  provider?: string | null;
  status:
    'running' | 'waiting_for_human' | 'waiting_for_async_tool' | 'done' | 'error' | 'interrupted';
  stepCount?: number | null;
  toolCalls?: number | null;
  totalCost?: number | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  totalTokens?: number | null;
  traceS3Key?: string | null;
  usage?: Record<string, unknown> | null;
}

export class AgentOperationModel {
  private readonly db: LobeChatDatabase;
  private readonly userId: string;
  private readonly workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.db = db;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  private ownership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, agentOperations);

  /**
   * Insert the initial row when an operation is created. Idempotent via
   * `onConflictDoNothing` on the primary key so resumed operations don't
   * blow up on the second createOperation call.
   */
  async recordStart(params: RecordOperationStartParams): Promise<void> {
    const values: NewAgentOperation = {
      agentId: params.agentId ?? null,
      appContext: params.appContext,
      chatGroupId: params.chatGroupId ?? null,
      id: params.operationId,
      maxSteps: params.maxSteps,
      ...(params.metadata ? { metadata: params.metadata } : {}),
      model: params.model,
      modelRuntimeConfig: params.modelRuntimeConfig,
      parentOperationId: params.parentOperationId ?? null,
      provider: params.provider,
      startedAt: params.startedAt ?? new Date(),
      status: 'running',
      taskId: params.taskId ?? null,
      threadId: params.threadId ?? null,
      topicId: params.topicId ?? null,
      trigger: params.trigger,
      userId: this.userId,
      workspaceId: this.workspaceId ?? null,
    };

    const desired = params.metadata as PlatformOperationMetadata | undefined;
    const classification = classifyPlatformStart(desired);

    // An ORDINARY operation keeps the upstream idempotent no-op.
    if (classification === 'ordinary') {
      await this.db.insert(agentOperations).values(values).onConflictDoNothing();
      return;
    }

    // A PLATFORM start must carry a COMPLETE exact binding — all four pins present (an empty
    // skills/connectors array is valid, `undefined` is NOT) plus the server-owned assistant anchor.
    // A PARTIAL platform start (some marker, not the full set) is itself invalid and must fail
    // closed — never silently downgrade to the ordinary no-op (RR4-3/RR5-4).
    if (classification !== 'complete' || !isCompletePlatformStartMetadata(desired)) {
      throw new PlatformOperationStartConflictError();
    }

    // A platform operation must NOT silently continue on a pre-existing row: an ordinary /
    // missing-pin / inconsistent / cross-owner row would later be read by the runtime and could drop
    // it to the managed *latest* pointer. The insert + conflict verification run in ONE transaction
    // with a row lock, so a concurrent update/delete/replace can't slip between the conflict and the
    // check (RR4-4); a platform start is idempotent ONLY when the existing row is THIS owner's and
    // carries byte-for-byte the SAME complete binding, otherwise it fails closed (RR3-2/RR4-3).
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(agentOperations)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: agentOperations.id });
      if (inserted.length > 0) return;

      const [existing] = await tx
        .select({
          metadata: agentOperations.metadata,
          userId: agentOperations.userId,
          workspaceId: agentOperations.workspaceId,
        })
        .from(agentOperations)
        .where(eq(agentOperations.id, params.operationId))
        .for('update')
        .limit(1);
      const existingMeta = existing?.metadata as PlatformOperationMetadata | undefined;
      const exactIdempotent =
        !!existing &&
        existing.userId === this.userId &&
        (existing.workspaceId ?? null) === (this.workspaceId ?? null) &&
        isCompletePlatformStartMetadata(existingMeta) &&
        pinsEqual(existingMeta.platformOperation, desired.platformOperation) &&
        pinsEqual(existingMeta.platformModel, desired.platformModel) &&
        pinsEqual(existingMeta.platformSkills, desired.platformSkills) &&
        pinsEqual(existingMeta.platformConnectors, desired.platformConnectors) &&
        existingMeta.assistantMessageId === desired.assistantMessageId;
      if (!exactIdempotent) throw new PlatformOperationStartConflictError();
    });
  }

  /**
   * Update the row when the operation reaches a terminal state. Scoped by
   * `userId` so a leaked operationId can't be used to flip another user's
   * row. No-op when the start row was never written.
   */
  private buildCompletionUpdates(
    params: RecordOperationCompletionParams,
  ): Partial<NewAgentOperation> {
    const updates: Partial<NewAgentOperation> = {
      completionReason: params.completionReason,
      status: params.status,
    };

    // Only set completedAt when explicitly provided so callers can mark a
    // non-terminal status (e.g. waiting_for_human) without falsely stamping
    // completion time.
    if (params.completedAt !== undefined) updates.completedAt = params.completedAt;
    if (params.processingTimeMs !== undefined) updates.processingTimeMs = params.processingTimeMs;
    if (params.stepCount !== undefined) updates.stepCount = params.stepCount;
    if (params.totalCost !== undefined) updates.totalCost = params.totalCost;
    if (params.totalTokens !== undefined) updates.totalTokens = params.totalTokens;
    if (params.totalInputTokens !== undefined) updates.totalInputTokens = params.totalInputTokens;
    if (params.totalOutputTokens !== undefined)
      updates.totalOutputTokens = params.totalOutputTokens;
    if (params.llmCalls !== undefined) updates.llmCalls = params.llmCalls;
    if (params.toolCalls !== undefined) updates.toolCalls = params.toolCalls;
    if (params.model !== undefined) updates.model = params.model;
    if (params.provider !== undefined) updates.provider = params.provider;
    if (params.cost !== undefined) updates.cost = params.cost;
    if (params.usage !== undefined) updates.usage = params.usage;
    if (params.error !== undefined) updates.error = params.error;
    if (params.interruption !== undefined) updates.interruption = params.interruption;
    if (params.traceS3Key !== undefined) updates.traceS3Key = params.traceS3Key;

    return updates;
  }

  async recordCompletion(
    operationId: string,
    params: RecordOperationCompletionParams,
  ): Promise<void> {
    await this.db
      .update(agentOperations)
      .set(this.buildCompletionUpdates(params))
      .where(and(eq(agentOperations.id, operationId), this.ownership()));
  }

  async findById(operationId: string) {
    const [row] = await this.db
      .select()
      .from(agentOperations)
      .where(and(eq(agentOperations.id, operationId), this.ownership()))
      .limit(1);
    return row ?? null;
  }

  /**
   * Load the secret-free platform operation pin of the EXACT parent operation a resume continues, via
   * a SERVER-CONTROLLED anchor binding keyed by resume kind (M10 PR-049 · RR3-1/RR4-1). The link is
   * NEVER derived from a client-writable `message.parentId`:
   *
   * - a DIRECT (regeneration) resume matches the operation's own server-recorded assistant-turn id
   *   (`metadata.assistantMessageId`, written once at start);
   * - an APPROVAL / TOOL-RESULT resume matches one of the pending tool-message ids the RUNTIME created
   *   when the operation parked, under its OWN kind (`metadata.pendingResumeAnchors[kind]`, recorded
   *   atomically with the park by `parkForHumanIntervention`).
   *
   * so a fabricated / forged anchor message (spoofed parentId, forged pending plugin) is never among
   * the server-owned ids, and an approval id can't cross-match the tool-result slot (or vice versa).
   * The
   * lookup jointly enforces owner + workspace (via `ownership()`), the exact topic (REQUIRED — no
   * topic ⇒ no resume) and thread leg, the requested `platformAgentId`, and the ONLY externally
   * resumable status (`waiting_for_human`; `waiting_for_async_tool` resumes internally, terminal /
   * historical ops are never a source). Returns null (→ caller fails closed) when nothing matches.
   * The caller still re-derives the exact pinned version from `versionId` and fails closed on a
   * checksum mismatch.
   */
  async findResumablePlatformOperationPin(params: {
    anchorKind: 'approval' | 'toolResult';
    anchorMessageId: string;
    platformAgentId: string;
    threadId: string | null;
    topicId: string | null;
  }): Promise<PlatformOperationPin | null> {
    // A resume MUST bind to a topic — without one the operation cannot be jointly scoped.
    if (!params.topicId) return null;

    // Per RR4-1/RR5-2 the anchor match is EXACT against a SERVER-owned id under its OWN kind — never a
    // client-writable `message.parentId`. `approval` / `toolResult` anchors are recorded separately
    // (by the runtime, at park, from the tool's verified intervention kind), so a client-forged tool
    // message is not among them and an approval anchor can never be replayed as a tool-result (or
    // vice versa). Only approval/tool-result are paused resumes; regeneration/continue never reaches
    // here (it starts a fresh operation — RR5-5).
    const anchorMatch = sql`${agentOperations.metadata} -> 'pendingResumeAnchors' -> ${params.anchorKind} @> to_jsonb(${params.anchorMessageId}::text)`;

    const [row] = await this.db
      .select({ metadata: agentOperations.metadata })
      .from(agentOperations)
      .where(
        and(
          this.ownership(),
          eq(agentOperations.topicId, params.topicId),
          // A thread resume must match the same thread; a main-turn resume (threadId null) must match
          // a main-turn op — never a thread op on the same topic.
          params.threadId
            ? eq(agentOperations.threadId, params.threadId)
            : isNull(agentOperations.threadId),
          inArray(agentOperations.status, RESUMABLE_OPERATION_STATUSES),
          anchorMatch,
          sql`${agentOperations.metadata} -> 'platformOperation' ->> 'platformAgentId' = ${params.platformAgentId}`,
        ),
      )
      .limit(1);
    return (row?.metadata as PlatformOperationMetadata | undefined)?.platformOperation ?? null;
  }

  /**
   * Park an operation on human intervention ATOMICALLY (M10 PR-049 · RR5-3): a SINGLE
   * owner/workspace-scoped, expected-previous-status CAS that flips the row to `waiting_for_human`
   * AND records the SERVER-created pending tool-message ids as KIND-KEYED resume anchors
   * (`metadata.pendingResumeAnchors[kind]`) in one statement. Merging the status flip and the anchor
   * write removes the old two-write window where a late/duplicate park could land the paused status
   * without (or after) its anchors.
   *
   * The CAS only fires from `running` / `waiting_for_human` (an idempotent re-park), so a late write
   * can NEVER resurrect a cancelled / completed / interrupted op back into `waiting_for_human`, and a
   * concurrent newer park isn't clobbered. Anchor kinds present are merged without disturbing the
   * sibling kind (an approval-only park keeps any recorded toolResult set). The pins are untouched.
   *
   * Returns the affected row count so the caller can fail CLOSED (fatal for a platform operation)
   * when it isn't exactly 1 — e.g. the row was already cancelled, deleted, or replaced.
   */
  async parkForHumanIntervention(
    operationId: string,
    params: RecordOperationCompletionParams & {
      anchors: { approval?: string[]; toolResult?: string[] };
    },
  ): Promise<{ affected: number }> {
    const { anchors, ...completion } = params;
    const updates = this.buildCompletionUpdates({ ...completion, status: 'waiting_for_human' });

    const normalize = (ids: string[] | undefined) =>
      [...new Set(ids ?? [])].filter((id) => typeof id === 'string' && id.length > 0);
    const approval = normalize(anchors.approval);
    const toolResult = normalize(anchors.toolResult);

    // Build the kind-keyed anchor object with ONLY the kinds present, so a park surfacing just one
    // kind never clobbers the sibling kind's recorded ids.
    const kindPairs: SQL[] = [];
    if (approval.length > 0) kindPairs.push(sql`'approval', ${JSON.stringify(approval)}::jsonb`);
    if (toolResult.length > 0) {
      kindPairs.push(sql`'toolResult', ${JSON.stringify(toolResult)}::jsonb`);
    }

    const metadataSql =
      kindPairs.length > 0
        ? sql`coalesce(${agentOperations.metadata}, '{}'::jsonb) || jsonb_build_object('pendingResumeAnchors', coalesce(${agentOperations.metadata} -> 'pendingResumeAnchors', '{}'::jsonb) || jsonb_build_object(${sql.join(kindPairs, sql`, `)}))`
        : undefined;

    const rows = await this.db
      .update(agentOperations)
      .set(metadataSql ? { ...updates, metadata: metadataSql } : updates)
      .where(
        and(
          eq(agentOperations.id, operationId),
          this.ownership(),
          inArray(agentOperations.status, [...PARK_EXPECTED_PREV_STATUSES]),
        ),
      )
      .returning({ id: agentOperations.id });
    return { affected: rows.length };
  }

  /**
   * Load the secret-free exact model pin persisted on an operation (MODEL-EXACT), owner- and
   * workspace-scoped by operationId, so a leaked operationId can never surface another principal's
   * pin. Returns null for an ordinary / builtin operation. The caller resolves the exact historical
   * provider revision from it and fails closed on a checksum/revision mismatch.
   */
  async findPlatformModelPin(operationId: string): Promise<PlatformOperationModelPin | null> {
    const [row] = await this.db
      .select({ metadata: agentOperations.metadata })
      .from(agentOperations)
      .where(and(eq(agentOperations.id, operationId), this.ownership()))
      .limit(1);
    return (row?.metadata as PlatformOperationMetadata | undefined)?.platformModel ?? null;
  }

  /**
   * Classify an operation for the per-LLM-call runtime (M10 PR-049 · RR2-2). Returns, owner- and
   * workspace-scoped by operationId:
   *
   * - `isPlatformOperation` — true when the row carries a `platformOperation` pin, i.e. it started
   *   as a platform-managed Agent. Because a platform operation's start is persisted fail-closed
   *   (see `CompletionLifecycle.recordStart`), this marker is reliably present by the time any LLM
   *   call runs — so the model runtime can DISTINGUISH a genuine ordinary/builtin op (no marker)
   *   from a platform op, instead of guessing from the model pin alone.
   * - `modelPin` — the secret-free exact model ref, or null.
   *
   * Returns null only when the operation row does not exist under this owner scope (a genuinely
   * ordinary/anonymous call). A DB read error propagates (the caller fails the call closed).
   */
  async findPlatformOperationRef(operationId: string): Promise<{
    isPlatformOperation: boolean;
    modelPin: PlatformOperationModelPin | null;
  } | null> {
    const [row] = await this.db
      .select({ metadata: agentOperations.metadata })
      .from(agentOperations)
      .where(and(eq(agentOperations.id, operationId), this.ownership()))
      .limit(1);
    if (!row) return null;
    const metadata = row.metadata as PlatformOperationMetadata | undefined;
    return {
      isPlatformOperation: Boolean(metadata?.platformOperation),
      modelPin: metadata?.platformModel ?? null,
    };
  }

  /**
   * Longest single operation (agent run) wall-clock execution time over the last
   * year, in seconds. Wall clock (`completedAt - startedAt`) is the most faithful
   * "task duration" — it spans the whole run including tool calls and waiting,
   * not just LLM compute. Returns 0 when there are no completed operations.
   */
  async getMaxDurationSeconds(): Promise<number> {
    const startDate = today().subtract(1, 'year').startOf('day').toDate();

    const [row] = await this.db
      .select({
        seconds:
          sql<number>`COALESCE(MAX(EXTRACT(EPOCH FROM (${agentOperations.completedAt} - ${agentOperations.startedAt}))), 0)`.mapWith(
            Number,
          ),
      })
      .from(agentOperations)
      .where(
        and(
          this.ownership(),
          isNotNull(agentOperations.startedAt),
          isNotNull(agentOperations.completedAt),
          gte(agentOperations.createdAt, startDate),
        ),
      );

    return row?.seconds ?? 0;
  }

  /**
   * Atomically flip a parked parent op from `waiting_for_async_tool` back to
   * `running`. Returns true only for the single winner (affected === 1) so
   * concurrent sub-op completions that lose the race no-op instead of
   * double-resuming the parent.
   */
  async tryResumeFromAsyncTool(operationId: string): Promise<boolean> {
    const rows = await this.db
      .update(agentOperations)
      .set({ status: 'running' })
      .where(
        and(
          eq(agentOperations.id, operationId),
          eq(agentOperations.userId, this.userId),
          eq(agentOperations.status, 'waiting_for_async_tool'),
        ),
      )
      .returning({ id: agentOperations.id });
    return rows.length === 1;
  }

  // ============================================
  // Verify (delivery checker)
  // ============================================
  // The verify plan snapshot + rollup status moved off this table onto
  // `verify_runs` (the session entity), addressed via `VerifyRunModel`. The
  // `verify_plan` / `verify_status` columns here are deprecated (see schema) and
  // no longer read or written through this model.
}
