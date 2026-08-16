'use client';

import { useCallback, useReducer } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  type AdminReauthAuthMethod,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import type { AdminSkillCreateInput } from './types';

/** Create identity only — versions are added later via the version editor. */
export type AdminSkillCreateWithVersionInput = AdminSkillCreateInput;

export const runCreateSkillSubmission = async (
  input: AdminSkillCreateWithVersionInput,
  onSubmit: (input: AdminSkillCreateWithVersionInput) => Promise<void>,
  options: {
    authMethod?: AdminReauthAuthMethod;
    runReauth?: (
      commit: () => Promise<void>,
      options: { authMethod: AdminReauthAuthMethod },
    ) => Promise<void>;
  } = {},
) => {
  const frozen = structuredClone(input);
  const commit = () => onSubmit(structuredClone(frozen));
  if (!frozen.allowBuiltinOverride) return commit();
  return (options.runReauth ?? withAdminReauthRetry)(commit, {
    authMethod: options.authMethod ?? null,
  });
};

export interface CreateSkillFormState {
  allowBuiltinOverride: boolean;
  description: string;
  displayName: string;
  distribution: AdminSkillCreateInput['distribution'];
  enabled: boolean;
  error: string | null;
  loading: boolean;
  skillKey: string;
}

/**
 * Free-text fields editable via `setField`.
 * Booleans (`enabled`, `allowBuiltinOverride`) and the distribution enum use dedicated actions
 * so callers cannot assign a string into a non-string field.
 */
export type CreateSkillFormStringField = 'description' | 'displayName' | 'skillKey';

export type CreateSkillFormAction =
  | {
      type: 'setField';
      field: CreateSkillFormStringField;
      value: string;
    }
  | { type: 'setDistribution'; value: AdminSkillCreateInput['distribution'] }
  | { type: 'setEnabled'; value: boolean }
  | { type: 'setAllowBuiltinOverride'; value: boolean }
  | { type: 'submitStart' }
  | { type: 'submitError'; error: string }
  | { type: 'submitEnd' };

export const initialCreateSkillFormState = (): CreateSkillFormState => ({
  allowBuiltinOverride: false,
  description: '',
  displayName: '',
  distribution: 'default',
  enabled: true,
  error: null,
  loading: false,
  skillKey: '',
});

export const createSkillFormReducer = (
  state: CreateSkillFormState,
  action: CreateSkillFormAction,
): CreateSkillFormState => {
  switch (action.type) {
    case 'setField': {
      return { ...state, [action.field]: action.value, error: state.error };
    }
    case 'setDistribution': {
      return { ...state, distribution: action.value };
    }
    case 'setEnabled': {
      return { ...state, enabled: action.value };
    }
    case 'setAllowBuiltinOverride': {
      return { ...state, allowBuiltinOverride: action.value };
    }
    case 'submitStart': {
      return { ...state, error: null, loading: true };
    }
    case 'submitError': {
      return { ...state, error: action.error, loading: false };
    }
    case 'submitEnd': {
      return { ...state, loading: false };
    }
    default: {
      return state;
    }
  }
};

export const buildCreateSkillInput = (
  state: CreateSkillFormState,
): AdminSkillCreateWithVersionInput | { error: 'required' } => {
  const skillKey = state.skillKey.trim();
  const displayName = state.displayName.trim();
  if (!skillKey || !displayName) return { error: 'required' };
  return {
    allowBuiltinOverride: state.allowBuiltinOverride,
    description: state.description.trim() || null,
    displayName,
    distribution: state.distribution,
    enabled: state.enabled,
    skillKey,
  };
};

export interface UseCreateSkillFormOptions {
  authMethod?: AdminReauthAuthMethod;
  onSubmit: (input: AdminSkillCreateWithVersionInput) => Promise<void>;
  onSuccess?: () => void;
}

/**
 * Typed form state + submission orchestration for identity-only Skill creation.
 * Keeps field validation, reauth, and error mapping out of the modal view.
 */
export const useCreateSkillForm = ({
  authMethod,
  onSubmit,
  onSuccess,
}: UseCreateSkillFormOptions) => {
  const { t } = useTranslation('admin');
  const [state, dispatch] = useReducer(
    createSkillFormReducer,
    undefined,
    initialCreateSkillFormState,
  );

  const submit = useCallback(async () => {
    const built = buildCreateSkillInput(state);
    if ('error' in built) {
      dispatch({ error: t('skillCatalog.form.required'), type: 'submitError' });
      return;
    }
    dispatch({ type: 'submitStart' });
    try {
      await runCreateSkillSubmission(built, onSubmit, { authMethod });
      onSuccess?.();
      dispatch({ type: 'submitEnd' });
    } catch (cause) {
      const mapped = mapEnterpriseError(cause);
      dispatch({
        error: mapped
          ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
          : t('skillCatalog.errors.generic'),
        type: 'submitError',
      });
    }
  }, [authMethod, onSubmit, onSuccess, state, t]);

  return { dispatch, state, submit };
};
