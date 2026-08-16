'use client';

import type { PlatformAgentVersionConfig } from '@lobechat/types';
import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  mapEnterpriseError,
  PLATFORM_ERROR_CODES,
} from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';
import {
  platformAgentDependencySnapshotSchema,
  platformAgentKeySchema,
  platformAgentVersionConfigSchema,
} from '@/server/enterprise/contracts/platformAgents';

import { toDependencySnapshot } from './dependencyCatalog';
import type { DependencyValidity } from './DependencyEditor';
import { getAdminAgentErrorMessage } from './errorPresentation';
import type {
  AdminAgentDetailOutput,
  AdminAgentDraftDependencies,
  AdminAgentEditorValue,
  AdminPlatformAgentSaveOutput,
} from './types';
import {
  selectCurrentPlatformAgentVersion,
  selectLatestPlatformAgentVersion,
} from './versionSelection';

/**
 * Stable, non-localized audit reasons. The server still requires a non-empty reason; keeping the
 * text locale-independent keeps the audit trail consistent across admin languages (mirrors delete).
 */
export const CREATE_AGENT_REASON = 'Platform assistant created from admin console';
export const SAVE_AGENT_REASON = 'Platform assistant saved from admin console';

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
 * Seed the editor from what is LIVE for assigned members: the published pointer version, falling
 * back to the newest version only when no pointer exists (legacy rows created before de-drafting).
 */
export const seedAgentEditorValue = (
  agent: AdminAgentDetailOutput | undefined,
): AdminAgentEditorValue => {
  if (!agent) return { config: { ...EMPTY_CONFIG }, dependencies: { ...EMPTY_DEPENDENCIES } };
  const version =
    selectCurrentPlatformAgentVersion(agent) ?? selectLatestPlatformAgentVersion(agent.versions);
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

const isRevisionConflict = (cause: unknown): boolean => {
  if (mapEnterpriseError(cause)?.code === PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT) {
    return true;
  }
  return cause instanceof Error && cause.message.includes('CONFLICT');
};

export interface UseAgentEditorFormParams {
  /** Present → edit an existing assistant; absent → create a new one. */
  agent?: AdminAgentDetailOutput;
  authMethod?: AdminReauthAuthMethod | null;
  /** Shared with the modal opener so a user-initiated close can confirm unsaved input. */
  dirtyRef?: { current: boolean };
  /** Close the hosting modal after a successful save. */
  onClose?: () => void;
  /**
   * Apply the committed output to the caches the caller owns and revalidate. A rejection means the
   * caller did NOT handle the failure, and the editor surfaces the refresh-failed warning itself.
   */
  onSaved?: (output: AdminPlatformAgentSaveOutput, created: boolean) => Promise<void> | void;
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

  // Set once the write commits: the form value still differs from the seed baseline, but it is no
  // longer unsaved, so the close guard must not challenge it.
  const committedRef = useRef(false);

  const dirty = useMemo(
    () =>
      JSON.stringify(value) !== JSON.stringify(baseline) ||
      (isCreate && agentKey.trim().length > 0),
    [agentKey, baseline, isCreate, value],
  );
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
  const canSubmit =
    !saving && Boolean(config) && keyValid && depValidity.ready && (isCreate || dirty);

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

  const submit = useCallback(async () => {
    if (saving) return;
    const nextConfig = buildAgentConfig(value);
    const dependencySnapshot = toDependencySnapshot(value.dependencies);
    if (
      !nextConfig ||
      !keyValid ||
      !dependencySnapshot ||
      !platformAgentDependencySnapshotSchema.safeParse(dependencySnapshot).success
    ) {
      setError(t('agentCatalog.save.invalid'));
      return;
    }
    setSaving(true);
    if (pendingRef) pendingRef.current = true; // veto every dismissal until this write settles
    setError(null);
    setConflict(false);
    try {
      const output = agent
        ? await withAdminReauthRetry(
            () =>
              adminAgentsService.save({
                agentId: agent.identity.id,
                config: nextConfig,
                dependencySnapshot,
                expectedDraftToken: agent.draftToken,
                expectedRevision: agent.identity.revision,
                reason: SAVE_AGENT_REASON,
              }),
            { authMethod: authMethod ?? null },
          )
        : await withAdminReauthRetry(
            () =>
              adminAgentsService.create({
                agentKey,
                config: nextConfig,
                dependencySnapshot,
                isDefault: false,
                reason: CREATE_AGENT_REASON,
                systemKey: null,
              }),
            { authMethod: authMethod ?? null },
          );
      // Committed on the server: the input is no longer unsaved and the write can no longer fail,
      // so both guards are released before the (slower) cache apply + revalidate.
      committedRef.current = true;
      if (dirtyRef) dirtyRef.current = false;
      if (pendingRef) pendingRef.current = false;
      // A deferred invalidation means the new version is live but some servers still serve the old
      // one — say so instead of claiming an unqualified success.
      if (output.invalidationStatus === 'deferred') {
        toast.warning(t('agentCatalog.toast.refreshDeferred'));
      } else {
        toast.success(t(isCreate ? 'agentCatalog.toast.created' : 'agentCatalog.toast.saved'));
      }
      try {
        await onSaved?.(output, isCreate);
      } catch {
        // The write already committed, so the modal still closes — but never silently: the caller
        // could not apply/revalidate its cache, and the admin must know the screen is behind.
        toast.warning(t('agentCatalog.recovery.refreshFailed'));
      }
      onClose?.();
    } catch (cause) {
      if (isRevisionConflict(cause)) {
        setConflict(true);
        setError(null);
      } else {
        setError(getAdminAgentErrorMessage(cause, t));
      }
    } finally {
      setSaving(false);
      if (pendingRef) pendingRef.current = false;
    }
  }, [
    agent,
    agentKey,
    authMethod,
    dirtyRef,
    isCreate,
    keyValid,
    onClose,
    onSaved,
    pendingRef,
    saving,
    t,
    value,
  ]);

  return {
    agentKey,
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
    value,
  };
};
