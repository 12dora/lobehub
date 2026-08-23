'use client';

import type { PlatformAgentVersionConfig } from '@lobechat/types';
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  buildAgentConfig,
  collectAgentMissingRequirements,
  createFallbackAgentKey,
  isAgentKeyValid,
  seedAgentEditorValue,
  suggestAgentKey,
} from './agentEditorValue';
import type { DependencyValidity } from './DependencyEditor';
import type {
  AdminAgentDetailOutput,
  AdminAgentDraftDependencies,
  AdminAgentEditorValue,
} from './types';

export interface UseAgentEditorDraftParams {
  /** Present → edit an existing assistant; absent → create a new one. */
  agent?: AdminAgentDetailOutput;
  isCreate: boolean;
  /** Called before every authoring edit, so the previous submit's outcome can be retired. */
  onChanged: () => void;
}

/**
 * What the admin is editing, plus everything derivable from it alone: the contract-shaped config,
 * whether the identifier is legal, which required fields are still empty, and the fingerprints the
 * commit side compares against. Nothing here knows about writes.
 */
export const useAgentEditorDraft = ({ agent, isCreate, onChanged }: UseAgentEditorDraftParams) => {
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

  const patchConfig = useCallback(
    <Key extends keyof PlatformAgentVersionConfig>(
      key: Key,
      next: PlatformAgentVersionConfig[Key],
    ) => {
      onChanged();
      setValue((current) => ({ ...current, config: { ...current.config, [key]: next } }));
    },
    [onChanged],
  );

  const setDependencies = useCallback(
    (next: AdminAgentDraftDependencies) => {
      onChanged();
      setValue((current) => ({ ...current, dependencies: next }));
    },
    [onChanged],
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
      onChanged();
      setAgentKey(next.trim().toLowerCase());
    },
    [onChanged],
  );

  const valueFingerprint = useMemo(() => JSON.stringify(value), [value]);
  const baselineFingerprint = useMemo(() => JSON.stringify(baseline), [baseline]);
  const config = useMemo(() => buildAgentConfig(value), [value]);
  const keyValid = !isCreate || isAgentKeyValid(agentKey);
  const missingRequirements = useMemo(
    () => collectAgentMissingRequirements({ agentKey, isCreate, value }),
    [agentKey, isCreate, value],
  );

  return {
    agentKey,
    /** The seed the editor opened on — the reference point for "still unsaved". */
    baselineFingerprint,
    changeAgentKey,
    /** Contract-shaped config, or null while a required field is missing/invalid. */
    config,
    depValidity,
    keyValid,
    missingRequirements,
    patchConfig,
    setDependencies,
    setDepValidity,
    setDisplayName,
    value,
    valueFingerprint,
  };
};

export type AgentEditorDraft = ReturnType<typeof useAgentEditorDraft>;
