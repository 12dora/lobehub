import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TreeActionImpl } from './actions';
import type { TreeState } from './types';

const { mockRefreshFileList, mockResourceMove, mockStoreMove } = vi.hoisted(() => ({
  mockRefreshFileList: vi.fn(),
  mockResourceMove: vi.fn(),
  mockStoreMove: vi.fn(),
}));

const fileStoreState = {
  moveResource: mockStoreMove,
  refreshFileList: mockRefreshFileList,
  resourceMap: new Map<string, unknown>(),
};

vi.mock('@/services/resource', () => ({
  resourceService: {
    moveResource: mockResourceMove,
  },
}));

vi.mock('@/store/file', () => ({
  useFileStore: {
    getState: () => fileStoreState,
  },
}));

const createState = (): TreeState => ({
  children: {},
  epoch: 0,
  errors: {},
  expanded: {},
  init: vi.fn(),
  knowledgeBaseId: 'kb-1',
  loadChildren: vi.fn(),
  moveItem: vi.fn(),
  moveItems: vi.fn(),
  expandAncestors: vi.fn(),
  reconcile: vi.fn(),
  removeItems: vi.fn(),
  renameItem: vi.fn(),
  reset: vi.fn(),
  revalidate: vi.fn(),
  status: {},
  toggle: vi.fn(),
});

const createSetter = (getState: () => TreeState) => {
  return (
    partial:
      Partial<TreeState> | TreeState | ((state: TreeState) => Partial<TreeState> | TreeState),
  ) => {
    const next = typeof partial === 'function' ? partial(getState()) : partial;
    Object.assign(getState(), next);
  };
};

describe('TreeActionImpl.moveItem', () => {
  beforeEach(() => {
    mockRefreshFileList.mockReset();
    mockResourceMove.mockReset();
    mockStoreMove.mockReset();
    fileStoreState.resourceMap = new Map();
  });

  it('falls back to backend move when the source node is absent from tree cache', async () => {
    const state = createState();
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );
    const revalidateSpy = vi.spyOn(actions, 'revalidate').mockResolvedValue();

    await actions.moveItem('file-1', 'folder-a', 'folder-b');
    await Promise.resolve();

    expect(mockResourceMove).toHaveBeenCalledWith('file-1', 'folder-b');
    expect(mockRefreshFileList).toHaveBeenCalledTimes(1);
    expect(mockStoreMove).not.toHaveBeenCalled();
    expect(revalidateSpy).toHaveBeenCalledWith('folder-a');
    expect(revalidateSpy).toHaveBeenCalledWith('folder-b');
  });

  it('delegates to the file store when explorer state already has the item', async () => {
    const state = createState();
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );

    fileStoreState.resourceMap = new Map([['file-1', { id: 'file-1' }]]);

    await actions.moveItem('file-1', 'folder-a', 'folder-b');
    await Promise.resolve();

    expect(mockStoreMove).toHaveBeenCalledWith('file-1', 'folder-b');
    expect(mockResourceMove).not.toHaveBeenCalled();
    expect(mockRefreshFileList).not.toHaveBeenCalled();
  });
});

describe('TreeActionImpl.init', () => {
  it('keeps the cached tree when re-initialising the library already in the store', () => {
    const state = createState();
    state.children = { '': [{ id: 'folder-a' } as never] };
    state.expanded = { 'folder-a': true };
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );
    const loadChildrenSpy = vi.spyOn(actions, 'loadChildren').mockResolvedValue();
    const revalidateSpy = vi.spyOn(actions, 'revalidate').mockResolvedValue();

    actions.init('kb-1');

    // A remount is not a reset: wiping here flashed the tree skeleton (and
    // collapsed every open folder) on every visit to the same library.
    expect(state.children['']).toHaveLength(1);
    expect(state.expanded['folder-a']).toBe(true);
    expect(state.epoch).toBe(0);
    expect(loadChildrenSpy).not.toHaveBeenCalled();
    expect(revalidateSpy).toHaveBeenCalledWith('');
  });

  it('resets and cold-loads when the library actually changes', () => {
    const state = createState();
    state.children = { '': [{ id: 'folder-a' } as never] };
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );
    const loadChildrenSpy = vi.spyOn(actions, 'loadChildren').mockResolvedValue();

    actions.init('kb-2');

    expect(state.children).toEqual({});
    expect(state.knowledgeBaseId).toBe('kb-2');
    expect(state.epoch).toBe(1);
    expect(loadChildrenSpy).toHaveBeenCalledWith('');
  });
});
