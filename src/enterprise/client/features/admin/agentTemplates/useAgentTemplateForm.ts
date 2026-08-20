'use client';

import { useMemo, useReducer, useState } from 'react';

import {
  AGENT_TEMPLATE_MAX_TAGS,
  AGENT_TEMPLATE_TAG_MAX,
} from '@/server/enterprise/contracts/adminAgentTemplates';

import type { AdminAgentTemplateItem } from './types';

export interface AgentTemplateFormState {
  avatar: string | null;
  backgroundColor: string | null;
  description: string;
  enabled: boolean;
  systemRole: string;
  tags: string[];
  title: string;
}

export type AgentTemplateFormAction =
  | { field: 'description' | 'systemRole' | 'title'; type: 'setText'; value: string }
  | { type: 'setAvatar'; value: string | null }
  | { type: 'setBackgroundColor'; value: string | null }
  | { type: 'setEnabled'; value: boolean }
  | { type: 'setTags'; value: string[] };

export const createAgentTemplateFormState = (
  item?: AdminAgentTemplateItem,
): AgentTemplateFormState => ({
  avatar: item?.avatar ?? null,
  backgroundColor: item?.backgroundColor ?? null,
  description: item?.description ?? '',
  enabled: item?.enabled ?? true,
  systemRole: item?.systemRole ?? '',
  tags: item ? [...item.tags] : [],
  title: item?.title ?? '',
});

const reducer = (
  state: AgentTemplateFormState,
  action: AgentTemplateFormAction,
): AgentTemplateFormState => {
  switch (action.type) {
    case 'setText': {
      return { ...state, [action.field]: action.value };
    }
    case 'setAvatar': {
      return { ...state, avatar: action.value || null };
    }
    case 'setBackgroundColor': {
      return { ...state, backgroundColor: action.value || null };
    }
    case 'setEnabled': {
      return { ...state, enabled: action.value };
    }
    case 'setTags': {
      return { ...state, tags: action.value };
    }
    default: {
      return state;
    }
  }
};

export interface AgentTemplateFormErrors {
  systemRole?: string;
  tags?: string;
  title?: string;
}

/** Error copy the form needs; keys mirror {@link AgentTemplateFormErrors} plus its variants. */
export interface AgentTemplateFormMessages extends Required<AgentTemplateFormErrors> {
  tagLength: string;
}

export const validateAgentTemplateForm = (
  state: AgentTemplateFormState,
  messages: AgentTemplateFormMessages,
): AgentTemplateFormErrors => {
  const errors: AgentTemplateFormErrors = {};
  if (!state.title.trim()) errors.title = messages.title;
  if (!state.systemRole.trim()) errors.systemRole = messages.systemRole;

  const tags = state.tags.map((tag) => tag.trim()).filter(Boolean);
  if (tags.length > AGENT_TEMPLATE_MAX_TAGS) {
    // The API contract caps the array; say so here instead of letting the server reject the save.
    errors.tags = messages.tags;
  } else if (tags.some((tag) => tag.length > AGENT_TEMPLATE_TAG_MAX)) {
    errors.tags = messages.tagLength;
  }
  return errors;
};

/** Serializable payload shared by create and update. */
export const toAgentTemplatePayload = (state: AgentTemplateFormState) => ({
  avatar: state.avatar,
  backgroundColor: state.backgroundColor,
  description: state.description.trim(),
  enabled: state.enabled,
  systemRole: state.systemRole.trim(),
  tags: state.tags.map((tag) => tag.trim()).filter(Boolean),
  title: state.title.trim(),
});

export const useAgentTemplateForm = (
  item: AdminAgentTemplateItem | undefined,
  messages: AgentTemplateFormMessages,
) => {
  const [state, dispatch] = useReducer(reducer, item, createAgentTemplateFormState);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();

  const errors = useMemo(() => validateAgentTemplateForm(state, messages), [messages, state]);
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
