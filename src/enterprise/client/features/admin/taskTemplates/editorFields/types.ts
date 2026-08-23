import type { TaskTemplateFormAction, TaskTemplateFormState } from '../useTaskTemplateForm';

/** Scopes a field name to the form's `useId`, so every label keeps pointing at its own input. */
export type TaskTemplateFieldId = (name: string) => string;

export interface TaskTemplateFieldSectionProps {
  dispatch: (action: TaskTemplateFormAction) => void;
  id: TaskTemplateFieldId;
  state: TaskTemplateFormState;
  submitting: boolean;
}
