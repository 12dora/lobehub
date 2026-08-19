'use client';

import type { PlatformAgentVersionConfig } from '@lobechat/types';
import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import {
  platformAgentDependencySnapshotSchema,
  platformAgentKeySchema,
  platformAgentVersionConfigSchema,
} from '@/server/enterprise/contracts/platformAgents';

import type { AgentEditorCas } from './agentEditorSubmit';
import {
  applyAssignmentPlan,
  classifySubmitFailure,
  reconcileAgentAfterFailure,
  writeAgentVersion,
} from './agentEditorSubmit';
import { toDependencySnapshot } from './dependencyCatalog';
import type { DependencyValidity } from './DependencyEditor';
import { getAdminAgentErrorMessage } from './errorPresentation';
import type {
  AdminAgentDetailOutput,
  AdminAgentDraftDependencies,
  AdminAgentEditorValue,
  AdminPlatformAgentSaveOutput,
} from './types';
import { useAgentAssignmentDraft } from './useAgentAssignmentDraft';
import {
  selectCurrentPlatformAgentVersion,
  selectLatestPlatformAgentVersion,
} from './versionSelection';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** The contract's own identifier rule (charset AND the 128-char ceiling), never a local copy. */
export const AGENT_KEY_MAX_LENGTH = 128;
export const isAgentKeyValid = (value: string): boolean =>
  platformAgentKeySchema.safeParse(value).success;

/** Trimmed text, or null when the field is empty (the contract forbids empty strings). */
const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Unique, non-empty, trimmed entries — the contract rejects duplicates and blank items. */
export const normalizeList = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

/** Derive a contract-legal agent key from a display name (lowercase letters, digits, `._-`). */
export const suggestAgentKey = (displayName: string): string =>
  displayName
    .trim()
    .toLowerCase()
    .replaceAll(/[^\da-z._-]+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^[^\da-z]+/, '')
    .slice(0, AGENT_KEY_MAX_LENGTH);

/**
 * A readable, contract-legal identifier for names the charset cannot carry (an all-CJK name derives
 * to an empty, illegal key). Generated once per editor so the prefilled value never shifts under
 * the admin — the identifier is permanent after create.
 */
export const createFallbackAgentKey = (): string =>
  `assistant-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;

const EMPTY_CONFIG: PlatformAgentVersionConfig = {
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName: '',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: '',
  tags: [],
};

const EMPTY_DEPENDENCIES: AdminAgentDraftDependencies = {
  connectors: [],
  model: null,
  skills: [],
};

/**
 * True when the assistant HAS a published pointer but that exact version is not in the loaded
 * page. Seeding from any other version would save the wrong config under the operator's nose, so
 * the editor refuses to open the config instead of guessing.
 */
export const isCurrentAgentVersionMissing = (agent: AdminAgentDetailOutput | undefined): boolean =>
  Boolean(agent?.identity.currentVersionId) && !selectCurrentPlatformAgentVersion(agent!);

/**
 * Seed the editor from what is LIVE for assigned members: the published pointer version. The
 * newest-version fallback applies ONLY when there is no pointer at all (legacy rows created before
 * de-drafting) — never when the pointer exists but its version was not loaded.
 */
export const seedAgentEditorValue = (
  agent: AdminAgentDetailOutput | undefined,
): AdminAgentEditorValue => {
  if (!agent) return { config: { ...EMPTY_CONFIG }, dependencies: { ...EMPTY_DEPENDENCIES } };
  const version = agent.identity.currentVersionId
    ? selectCurrentPlatformAgentVersion(agent)
    : selectLatestPlatformAgentVersion(agent.versions);
  if (!version) {
    return {
      config: { ...EMPTY_CONFIG, displayName: agent.identity.agentKey },
      dependencies: { ...EMPTY_DEPENDENCIES },
    };
  }
  return {
    config: structuredClone(version.config),
    // Carry the previous version's exact model/skill/connector refs; re-picking one replaces the
    // whole ref with fresh catalog metadata.
    dependencies: {
      connectors: structuredClone(version.dependencySnapshot.connectors),
      model: structuredClone(version.dependencySnapshot.model),
      skills: structuredClone(version.dependencySnapshot.skills),
    },
  };
};

/** Contract-shaped config, or null when a required field is still missing/invalid. */
export const buildAgentConfig = (
  value: AdminAgentEditorValue,
): PlatformAgentVersionConfig | null => {
  const backgroundColor = value.config.backgroundColor?.trim() ?? '';
  const candidate: PlatformAgentVersionConfig = {
    avatar: textOrNull(value.config.avatar),
    backgroundColor: HEX_COLOR_PATTERN.test(backgroundColor) ? backgroundColor : null,
    description: textOrNull(value.config.description),
    displayName: value.config.displayName.trim(),
    modelParameters: value.config.modelParameters,
    openingMessage: textOrNull(value.config.openingMessage),
    openingQuestions: normalizeList(value.config.openingQuestions),
    systemRole: value.config.systemRole.trim(),
    tags: normalizeList(value.config.tags),
  };
  const parsed = platformAgentVersionConfigSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as PlatformAgentVersionConfig) : null;
};

/** What the submit actually committed, so the caller knows whether a row patch is still enough. */
export interface AgentEditorSaveMeta {
  /** At least one assignment was written — list counters are stale, revalidate rather than patch. */
  assignmentsChanged: boolean;
  created: boolean;
}

export interface UseAgentEditorFormParams {
  /** Present → edit an existing assistant; absent → create a new one. */
  agent?: AdminAgentDetailOutput;
  authMethod?: AdminReauthAuthMethod | null;
  /** AGENT_ASSIGN: without it the assignment section is hidden and never written. */
  canAssign?: boolean;
  /**
   * AGENT_UPDATE + AGENT_PUBLISH. Without it the config is read-only and no version is ever
   * written — an assignment-only operator still opens this modal to edit 分配策略.
   */
  canEditConfig?: boolean;
  /** Shared with the modal opener so a user-initiated close can confirm unsaved input. */
  dirtyRef?: { current: boolean };
  /** Close the hosting modal after a successful save. */
  onClose?: () => void;
  /**
   * Apply the committed output to the caches the caller owns and revalidate. A rejection means the
   * caller did NOT handle the failure, and the editor surfaces the refresh-failed warning itself.
   * `output` is null when only assignments changed — there was no new version to apply.
   */
  onSaved?: (
    output: AdminPlatformAgentSaveOutput | null,
    meta: AgentEditorSaveMeta,
  ) => Promise<void> | void;
  /**
   * Shared with the modal opener: true from the moment the write leaves the client until it
   * commits (or fails). While it is set, EVERY passive dismissal is vetoed — a modal that closes
   * mid-write would strand the admin with no idea whether the assistant changed.
   */
  pendingRef?: { current: boolean };
}

export const useAgentEditorForm = ({
  agent,
  authMethod,
  canAssign = false,
  canEditConfig = true,
  dirtyRef,
  onClose,
  onSaved,
  pendingRef,
}: UseAgentEditorFormParams) => {
  const { t } = useTranslation('admin');
  const isCreate = !agent;
  const baseline = useMemo(() => seedAgentEditorValue(agent), [agent]);
  const [value, setValue] = useState<AdminAgentEditorValue>(() => structuredClone(baseline));
  const [agentKey, setAgentKey] = useState(agent?.identity.agentKey ?? '');
  const [fallbackAgentKey] = useState(createFallbackAgentKey);
  const keyTouchedRef = useRef(false);
  const [depValidity, setDepValidity] = useState<DependencyValidity>({
    blockers: [],
    issues: [],
    ready: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // A truncated assignment page cannot be diffed safely — the section renders read-only instead.
  const assignmentsTruncated = Boolean(agent?.collectionMeta?.assignmentsTruncated);
  const assignments = useAgentAssignmentDraft(canAssign ? agent?.assignments : undefined, {
    truncated: assignmentsTruncated,
  });
  // The published pointer is not among the loaded versions: nothing here may author a version.
  const currentVersionMissing = useMemo(() => isCurrentAgentVersionMissing(agent), [agent]);
  const configEditable = canEditConfig && !currentVersionMissing;
  /**
   * Set when a rejected write may still have committed AND the reconcile read could not tell us.
   * Retrying blind could create a second assistant, so Save stays closed until the modal is
   * reopened against a fresh read.
   */
  const [resumeBlocked, setResumeBlocked] = useState(false);

  /**
   * The CAS the NEXT write must echo. It starts at the loaded aggregate and advances after every
   * committed write, so a submit whose assignment chain failed half-way can be retried from the
   * modal without a conflict — and without replaying the writes that already landed.
   */
  const [identity, setIdentity] = useState<AgentEditorCas | null>(() =>
    agent
      ? {
          agentId: agent.identity.id,
          draftToken: agent.draftToken,
          revision: agent.identity.revision,
        }
      : null,
  );
  /** The version output of the last committed save/create, replayed to `onSaved` on a retry. */
  const [lastOutput, setLastOutput] = useState<AdminPlatformAgentSaveOutput | null>(null);
  /** Fingerprint of the value at the last committed save — what "already saved" means now. */
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);

  // Set once the write commits: the form value still differs from the seed baseline, but it is no
  // longer unsaved, so the close guard must not challenge it.
  const committedRef = useRef(false);

  const valueFingerprint = useMemo(() => JSON.stringify(value), [value]);
  const baselineFingerprint = useMemo(() => JSON.stringify(baseline), [baseline]);
  // A read-only config can never be dirty, so it can never schedule a version write.
  const configDirty =
    configEditable &&
    (valueFingerprint !== (savedFingerprint ?? baselineFingerprint) ||
      (isCreate && !identity && agentKey.trim().length > 0));
  const dirty = configDirty || assignments.dirty;
  // NOT cleared while saving: a write can still fail, and the input would then be unsaved again.
  // The in-flight window is covered by `pendingRef`, which vetoes dismissal outright.
  if (dirtyRef) dirtyRef.current = dirty && !committedRef.current;

  const markChanged = useCallback(() => {
    committedRef.current = false;
    setError(null);
    setConflict(false);
  }, []);

  const patchConfig = useCallback(
    <Key extends keyof PlatformAgentVersionConfig>(
      key: Key,
      next: PlatformAgentVersionConfig[Key],
    ) => {
      markChanged();
      setValue((current) => ({ ...current, config: { ...current.config, [key]: next } }));
    },
    [markChanged],
  );

  const setDependencies = useCallback(
    (next: AdminAgentDraftDependencies) => {
      markChanged();
      setValue((current) => ({ ...current, dependencies: next }));
    },
    [markChanged],
  );

  const setDisplayName = useCallback(
    (next: string) => {
      patchConfig('displayName', next);
      // Create only: keep the identifier in step with the name until the admin edits it by hand.
      if (!isCreate || keyTouchedRef.current) return;
      // NEVER let the suggestion write an illegal identifier: a name the charset cannot carry
      // (an all-CJK one) derives to '', which silently blocks Save with nothing on screen to fix.
      const suggested = suggestAgentKey(next);
      if (isAgentKeyValid(suggested)) setAgentKey(suggested);
      else setAgentKey(next.trim().length > 0 ? fallbackAgentKey : '');
    },
    [fallbackAgentKey, isCreate, patchConfig],
  );

  const changeAgentKey = useCallback(
    (next: string) => {
      keyTouchedRef.current = true;
      markChanged();
      setAgentKey(next.trim().toLowerCase());
    },
    [markChanged],
  );

  const config = useMemo(() => buildAgentConfig(value), [value]);
  const keyValid = !isCreate || isAgentKeyValid(agentKey);
  // An assignment-only operator never writes a version, so the config requirements (a valid
  // config, a resolved model catalog, a legal key) are not theirs to satisfy.
  const configReady = !configEditable || (Boolean(config) && keyValid && depValidity.ready);
  // `!identity` covers create before its first commit; once anything committed, Save needs a change.
  const canSubmit =
    !saving && !resumeBlocked && configReady && (dirty || (configEditable && !identity));

  /**
   * The required fields that are still empty, as i18n keys. Save is disabled by four independent
   * conditions and three of them used to be invisible — this is the list the footer names so a
   * blocked Save always says what to do next.
   */
  const missingRequirements = useMemo(() => {
    const list: string[] = [];
    if (value.config.displayName.trim().length === 0) list.push('agentCatalog.editor.missing.name');
    if (value.config.systemRole.trim().length === 0) {
      list.push('agentCatalog.editor.missing.systemRole');
    }
    if (isCreate && !isAgentKeyValid(agentKey)) list.push('agentCatalog.editor.missing.key');
    if (!value.dependencies.model) list.push('agentCatalog.editor.missing.model');
    return list;
  }, [agentKey, isCreate, value]);

  /**
   * Ask the server what actually landed after an ambiguous failure, and re-base every piece of
   * resume state on the answer: the CAS, the assignment baseline, and whether the config we tried
   * to write is already live.
   *
   * Returns `'found'` when the assistant exists (state has been re-based), `'absent'` when the
   * create provably never happened, and `'unknown'` when we could not tell — the one case where
   * retrying could create a second assistant, so the caller must refuse to resume.
   */
  const reconcile = useCallback(
    async (agentId: string | undefined) =>
      reconcileAgentAfterFailure({
        agentId,
        agentKey: agentKey.trim(),
        onFound: (fresh) => {
          setIdentity({
            agentId: fresh.identity.id,
            draftToken: fresh.draftToken,
            revision: fresh.identity.revision,
          });
          assignments.reconcile(fresh.assignments);
          // Only claim the config is saved when the LIVE version really matches what we tried to
          // write; otherwise the next Save must author it again.
          const live = JSON.stringify(seedAgentEditorValue(fresh));
          setSavedFingerprint(live === valueFingerprint ? valueFingerprint : null);
        },
      }),
    [agentKey, assignments, valueFingerprint],
  );

  const submit = useCallback(async () => {
    if (saving || resumeBlocked) return;
    const nextConfig = buildAgentConfig(value);
    const dependencySnapshot = toDependencySnapshot(value.dependencies);
    // Only a submit that will actually author a version has to satisfy the version contract.
    const willWriteConfig = configEditable && (configDirty || !identity);
    if (
      willWriteConfig &&
      (!nextConfig ||
        !keyValid ||
        !dependencySnapshot ||
        !platformAgentDependencySnapshotSchema.safeParse(dependencySnapshot).success)
    ) {
      setError(t('agentCatalog.save.invalid'));
      return;
    }
    setSaving(true);
    if (pendingRef) pendingRef.current = true; // veto every dismissal until this write settles
    setError(null);
    setConflict(false);
    // Frozen for the whole chain: the plan the operator saw when they pressed Save.
    const plan = canAssign ? assignments.plan : { removals: [], upserts: [] };
    const assignmentsChanged = plan.removals.length > 0 || plan.upserts.length > 0;
    const created = !identity;
    let output: AdminPlatformAgentSaveOutput | null = lastOutput;
    let cas: AgentEditorCas | null = identity;
    // Once the identity write is settled, a later failure is an ASSIGNMENT failure — a different
    // story for the operator: the assistant is live, the distribution is not (fully) applied.
    let identityCommitted = false;
    try {
      if (willWriteConfig) {
        const written = await writeAgentVersion({
          agentKey,
          authMethod: authMethod ?? null,
          cas,
          config: nextConfig!,
          dependencySnapshot: dependencySnapshot!,
        });
        output = written.output;
        cas = written.cas;
        setIdentity(cas);
        setLastOutput(output);
        setSavedFingerprint(valueFingerprint);
      }
      identityCommitted = true;
      cas = await applyAssignmentPlan({
        authMethod: authMethod ?? null,
        cas,
        onCas: setIdentity,
        onRemoved: assignments.markRemoved,
        onUpserted: assignments.markUpserted,
        plan,
      });
      // Everything committed: the input is no longer unsaved and no write can still fail, so both
      // guards are released before the (slower) cache apply + revalidate.
      committedRef.current = true;
      if (dirtyRef) dirtyRef.current = false;
      if (pendingRef) pendingRef.current = false;
      // A deferred invalidation means the new version is live but some servers still serve the old
      // one — say so instead of claiming an unqualified success.
      if (output?.invalidationStatus === 'deferred') {
        toast.warning(t('agentCatalog.toast.refreshDeferred'));
      } else {
        toast.success(t(created ? 'agentCatalog.toast.created' : 'agentCatalog.toast.saved'));
      }
      try {
        await onSaved?.(output, { assignmentsChanged, created });
      } catch {
        // The write already committed, so the modal still closes — but never silently: the caller
        // could not apply/revalidate its cache, and the admin must know the screen is behind.
        toast.warning(t('agentCatalog.recovery.refreshFailed'));
      }
      onClose?.();
    } catch (cause) {
      switch (
        await classifySubmitFailure({
          cas,
          cause,
          created,
          identityCommitted,
          reconcile,
        })
      ) {
        case 'conflict': {
          // A revision conflict is the SERVER refusing the write — a definitive "did not commit".
          setConflict(true);
          setError(null);
          return;
        }
        case 'resume-blocked': {
          // We could neither confirm nor rule out a commit. Retrying could duplicate the assistant.
          setResumeBlocked(true);
          setError(t('agentCatalog.editor.resumeBlocked'));
          break;
        }
        case 'partial-assignment': {
          // The assistant itself is live; only the distribution chain broke.
          setError(
            `${t('agentCatalog.assignment.partialFailure')} ${getAdminAgentErrorMessage(cause, t)}`,
          );
          try {
            await onSaved?.(output, { assignmentsChanged: true, created });
          } catch {
            toast.warning(t('agentCatalog.recovery.refreshFailed'));
          }
          break;
        }
        case 'identity-failed': {
          setError(getAdminAgentErrorMessage(cause, t));
          break;
        }
      }
    } finally {
      setSaving(false);
      if (pendingRef) pendingRef.current = false;
    }
  }, [
    agentKey,
    assignments,
    authMethod,
    canAssign,
    configDirty,
    configEditable,
    dirtyRef,
    identity,
    reconcile,
    resumeBlocked,
    keyValid,
    lastOutput,
    onClose,
    onSaved,
    pendingRef,
    saving,
    t,
    value,
    valueFingerprint,
  ]);

  return {
    agentKey,
    /** The 分配策略 editor state; only meaningful when `canAssign` is true. */
    assignments,
    canAssign,
    /** False for an assignment-only operator, or when the live version could not be loaded. */
    configEditable,
    /** The published pointer version is not in the loaded page — the config must not be authored. */
    currentVersionMissing,
    canSubmit,
    changeAgentKey,
    conflict,
    depValidity,
    dirty,
    error,
    isCreate,
    keyValid,
    missingRequirements,
    patchConfig,
    saving,
    setDependencies,
    setDepValidity,
    setDisplayName,
    submit,
    /** A rejected write may have committed and we could not tell — Save is closed until reopened. */
    resumeBlocked,
    /** `default-inbox` for the platform's built-in assistant, which every member already gets. */
    systemKey: agent?.identity.systemKey ?? null,
    value,
  };
};
