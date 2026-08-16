'use client';

import type { InterestAreaKey, TaskTemplateCategory, TaskTemplateIcon } from '@lobechat/const';
import { useMemo, useReducer, useState } from 'react';

import { TASK_TEMPLATE_MAX_CONNECTORS } from '@/server/enterprise/contracts/adminTaskTemplates';

import { isKnownConnector } from './connectorCatalog';
import {
  buildCronFromDraft,
  draftFromCron,
  isValidTaskTemplateCron,
  type TaskTemplateScheduleDraft,
  type TaskTemplateSchedulePreset,
} from './schedule';
import type { AdminTaskTemplateConnector, AdminTaskTemplateItem } from './types';

export interface TaskTemplateFormState {
  category: TaskTemplateCategory;
  connectors: AdminTaskTemplateConnector[];
  description: string;
  enabled: boolean;
  icon: TaskTemplateIcon | null;
  instruction: string;
  interests: InterestAreaKey[];
  schedule: TaskTemplateScheduleDraft;
  title: string;
}

export type TaskTemplateFormAction =
  | { field: 'description' | 'instruction' | 'title'; type: 'setText'; value: string }
  | { index: number; type: 'removeConnector' }
  | {
      index: number;
      type: 'setConnector';
      value: { identifier: string; source: AdminTaskTemplateConnector['source'] };
    }
  | { index: number; type: 'setConnectorRequired'; value: boolean }
  | { type: 'addConnector' }
  | { type: 'setCategory'; value: string }
  | { type: 'setCronPattern'; value: string }
  | { type: 'setEnabled'; value: boolean }
  | { type: 'setHour'; value: number }
  | { type: 'setIcon'; value: string | null }
  | { type: 'setInterests'; value: string[] }
  | { type: 'setInterval'; value: number }
  | { type: 'setMinute'; value: number }
  | { type: 'setPreset'; value: TaskTemplateSchedulePreset }
  | { type: 'setWeekday'; value: number };

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : min;

export const createTaskTemplateFormState = (
  item?: AdminTaskTemplateItem,
): TaskTemplateFormState => ({
  category: item?.category ?? 'operations',
  connectors: item ? item.connectors.map((connector) => ({ ...connector })) : [],
  description: item?.description ?? '',
  enabled: item?.enabled ?? true,
  icon: item?.icon ?? null,
  instruction: item?.instruction ?? '',
  interests: item ? [...item.interests] : [],
  schedule: draftFromCron(item?.cronPattern ?? '0 9 * * *'),
  title: item?.title ?? '',
});

const reducer = (
  state: TaskTemplateFormState,
  action: TaskTemplateFormAction,
): TaskTemplateFormState => {
  const patchSchedule = (patch: Partial<TaskTemplateScheduleDraft>): TaskTemplateFormState => ({
    ...state,
    schedule: { ...state.schedule, ...patch },
  });

  switch (action.type) {
    case 'setText': {
      return { ...state, [action.field]: action.value };
    }
    case 'setCategory': {
      return { ...state, category: action.value as TaskTemplateCategory };
    }
    case 'setIcon': {
      return { ...state, icon: (action.value as TaskTemplateIcon | null) || null };
    }
    case 'setInterests': {
      return { ...state, interests: action.value as InterestAreaKey[] };
    }
    case 'setEnabled': {
      return { ...state, enabled: action.value };
    }
    case 'setPreset': {
      // Moving into the advanced field must show what the presets were building, not a blank box.
      return action.value === 'custom'
        ? patchSchedule({ pattern: buildCronFromDraft(state.schedule), preset: 'custom' })
        : patchSchedule({ preset: action.value });
    }
    case 'setHour': {
      return patchSchedule({ hour: clamp(action.value, 0, 23) });
    }
    case 'setMinute': {
      return patchSchedule({ minute: clamp(action.value, 0, 59) });
    }
    case 'setWeekday': {
      return patchSchedule({ weekday: clamp(action.value, 0, 6) });
    }
    case 'setInterval': {
      return patchSchedule({ interval: clamp(action.value, 1, 23) });
    }
    case 'setCronPattern': {
      return patchSchedule({ pattern: action.value });
    }
    case 'addConnector': {
      return {
        ...state,
        connectors: [...state.connectors, { identifier: '', required: true, source: 'lobehub' }],
      };
    }
    case 'removeConnector': {
      return {
        ...state,
        connectors: state.connectors.filter((_, index) => index !== action.index),
      };
    }
    case 'setConnector':
    case 'setConnectorRequired': {
      return {
        ...state,
        connectors: state.connectors.map((connector, index) => {
          if (index !== action.index) return connector;
          return action.type === 'setConnectorRequired'
            ? { ...connector, required: action.value }
            : { ...connector, identifier: action.value.identifier, source: action.value.source };
        }),
      };
    }
    default: {
      return state;
    }
  }
};

export interface TaskTemplateFormErrors {
  connectors?: string;
  cron?: string;
  instruction?: string;
  title?: string;
}

/** Error copy the form needs; keys mirror {@link TaskTemplateFormErrors} plus its variants. */
export interface TaskTemplateFormMessages extends Required<TaskTemplateFormErrors> {
  connectorLimit: string;
  connectorRetired: string;
}

export const validateTaskTemplateForm = (
  state: TaskTemplateFormState,
  messages: TaskTemplateFormMessages,
): TaskTemplateFormErrors => {
  const errors: TaskTemplateFormErrors = {};
  if (!state.title.trim()) errors.title = messages.title;
  if (!state.instruction.trim()) errors.instruction = messages.instruction;
  if (!isValidTaskTemplateCron(buildCronFromDraft(state.schedule))) errors.cron = messages.cron;

  if (state.connectors.length > TASK_TEMPLATE_MAX_CONNECTORS) {
    // The API contract caps the array; say so here instead of letting the server reject the save.
    errors.connectors = messages.connectorLimit;
  } else if (state.connectors.some((connector) => !connector.identifier.trim())) {
    errors.connectors = messages.connectors;
  } else if (state.connectors.some((connector) => !isKnownConnector(connector))) {
    // A row loaded from storage may point at a since-retired provider: it can no longer render,
    // so it must be replaced or removed before this template can be saved again.
    errors.connectors = messages.connectorRetired;
  }
  return errors;
};

/** Serializable payload shared by create and update. */
export const toTaskTemplatePayload = (state: TaskTemplateFormState) => ({
  category: state.category,
  connectors: state.connectors.map((connector) => ({
    identifier: connector.identifier.trim(),
    required: connector.required,
    source: connector.source,
  })),
  cronPattern: buildCronFromDraft(state.schedule),
  description: state.description.trim(),
  enabled: state.enabled,
  icon: state.icon,
  instruction: state.instruction.trim(),
  interests: state.interests,
  title: state.title.trim(),
});

export const useTaskTemplateForm = (
  item: AdminTaskTemplateItem | undefined,
  messages: TaskTemplateFormMessages,
) => {
  const [state, dispatch] = useReducer(reducer, item, createTaskTemplateFormState);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();

  const errors = useMemo(() => validateTaskTemplateForm(state, messages), [messages, state]);
  const valid = Object.keys(errors).length === 0;

  return {
    dispatch,
    errors,
    setSubmitError,
    setSubmitting,
    state,
    submitError,
    submitting,
    valid,
  };
};
