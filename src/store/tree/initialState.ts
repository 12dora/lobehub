import type { TreeDataState } from './types';

export interface TreeInitialState extends TreeDataState {
  epoch: number;
  errors: Record<string, unknown>;
  expanded: Record<string, boolean>;
  knowledgeBaseId: string | null;
  /** Per-folder read counter; only the newest read for a folder may write. */
  revisions: Record<string, number>;
}

export const initialTreeState: TreeInitialState = {
  children: {},
  epoch: 0,
  errors: {},
  expanded: {},
  knowledgeBaseId: null,
  revisions: {},
  status: {},
};
