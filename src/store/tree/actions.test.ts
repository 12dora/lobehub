import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TreeActionImpl } from './actions';
import type { TreeState } from './types';

const {
  mockGetKnowledgeItems,
  mockRefreshFileList,
  mockResourceMove,
  mockStoreMove,
  mockUpdateResource,
} = vi.hoisted(() => ({
  mockGetKnowledgeItems: vi.fn(),
  mockRefreshFileList: vi.fn(),
  mockResourceMove: vi.fn(),
  mockStoreMove: vi.fn(),
  mockUpdateResource: vi.fn(),
}));

vi.mock('@/services/file', () => ({
  fileService: { getKnowledgeItems: mockGetKnowledgeItems },
}));

const fileStoreState = {
  moveResource: mockStoreMove,
  refreshFileList: mockRefreshFileList,
  resourceMap: new Map<string, unknown>(),
};

vi.mock('@/services/resource', () => ({
  resourceService: {
    moveResource: mockResourceMove,
    updateResource: mockUpdateResource,
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
  revisions: {},
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

/** A promise the test resolves by hand, so "in flight" is an observable state. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const treeRow = (id: string, name: string) => ({
  fileType: 'text/directory',
  id,
  metadata: null,
  name,
  slug: id,
  url: '',
});

describe('TreeActionImpl folder read ordering', () => {
  beforeEach(() => {
    mockGetKnowledgeItems.mockReset();
    mockRefreshFileList.mockReset().mockResolvedValue(undefined);
    mockUpdateResource.mockReset().mockResolvedValue(undefined);
  });

  it('lets the newest read for a folder win, whichever one answers last', async () => {
    const state = createState();
    state.children = { '': [treeRow('folder-a', 'Before') as never] };
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );

    const remount = deferred<{ items: unknown[] }>();
    const afterRename = deferred<{ items: unknown[] }>();
    mockGetKnowledgeItems.mockReturnValueOnce(remount.promise);
    mockGetKnowledgeItems.mockReturnValueOnce(afterRename.promise);

    // The sidebar remounts and refreshes the root; the rename that follows
    // refreshes it again before the first read has answered.
    const remountRead = actions.revalidate('');
    const postMutationRead = actions.revalidate('');

    afterRename.resolve({ items: [treeRow('folder-a', 'After')] });
    await postMutationRead;

    // The library-wide epoch is the same for both reads, so it cannot separate
    // them: without a per-folder revision the stale one restores the old name.
    remount.resolve({ items: [treeRow('folder-a', 'Before')] });
    await remountRead;

    expect(state.children['']?.map((item) => item.name)).toEqual(['After']);
  });

  it('supersedes a read that was already running when a mutation starts', async () => {
    const state = createState();
    state.children = { '': [treeRow('folder-a', 'Current') as never] };
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );

    const inFlight = deferred<{ items: unknown[] }>();
    mockGetKnowledgeItems.mockReturnValueOnce(inFlight.promise);
    const remountRead = actions.revalidate('');
    const revisionWhenReadStarted = state.revisions[''];

    // The rename starts while that read is still out. Its optimistic write is
    // the truth from this moment on, so the read has to be superseded right
    // away — waiting for the rename's own refresh to start is too late.
    mockGetKnowledgeItems.mockResolvedValue({ items: [treeRow('folder-a', 'Renamed')] });
    void actions.renameItem('folder-a', '', 'Renamed').catch(() => undefined);

    expect(state.revisions['']).toBeGreaterThan(revisionWhenReadStarted);

    inFlight.resolve({ items: [treeRow('folder-a', 'Stale')] });
    await remountRead;

    expect(state.children['']?.map((item) => item.name)).not.toContain('Stale');
  });

  it('never leaves a folder busy when a mutation supersedes its first load', async () => {
    const state = createState();
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );

    const inFlight = deferred<{ items: unknown[] }>();
    mockGetKnowledgeItems.mockReturnValueOnce(inFlight.promise);
    const load = actions.loadChildren('folder-x');
    expect(state.status['folder-x']).toBe('loading');

    // A rename in that folder starts while the first load is still out.
    mockGetKnowledgeItems.mockResolvedValue({ items: [treeRow('n1', 'After')] });
    void actions.renameItem('n1', 'folder-x', 'After').catch(() => undefined);

    inFlight.resolve({ items: [treeRow('n1', 'Stale')] });
    await load;

    // The superseded load owns the `loading` it set. Bailing out silently left
    // it behind, and `revalidate` used to refuse to run against a folder that
    // said `loading` — so the folder span stayed busy with nothing running.
    expect(state.status['folder-x']).not.toBe('loading');

    await actions.revalidate('folder-x');
    expect(state.children['folder-x']?.map((item) => item.name)).toEqual(['After']);
  });

  it('lets a post-mutation revalidation supersede a load that is still running', async () => {
    const state = createState();
    const actions = new TreeActionImpl(
      createSetter(() => state),
      () => state,
    );

    const inFlight = deferred<{ items: unknown[] }>();
    mockGetKnowledgeItems.mockReturnValueOnce(inFlight.promise);
    const load = actions.loadChildren('folder-x');

    // The rename's refresh arrives while that load is still out. Refusing to
    // start against a `loading` folder dropped it entirely, and the folder was
    // left with whatever the pre-mutation load happened to be fetching.
    mockGetKnowledgeItems.mockResolvedValue({ items: [treeRow('n1', 'After')] });
    const afterMutation = actions.revalidate('folder-x');

    inFlight.resolve({ items: [treeRow('n1', 'Stale')] });
    await Promise.all([load, afterMutation]);

    expect(state.children['folder-x']?.map((item) => item.name)).toEqual(['After']);
    expect(state.status['folder-x']).toBe('idle');
  });
});
