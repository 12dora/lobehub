import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';
import { type StateCreator } from 'zustand/vanilla';

import { createDevtools } from '../middleware/createDevtools';
import { expose } from '../middleware/expose';
import { flattenActions } from '../utils/flattenActions';
import { type AIProviderStoreState } from './initialState';
import { initialState } from './initialState';
import { type AiInfraServices, defaultAiInfraServices } from './services';
import { type AiModelAction } from './slices/aiModel';
import { createAiModelSlice } from './slices/aiModel';
import { type AiProviderAction } from './slices/aiProvider';
import { createAiProviderSlice } from './slices/aiProvider';

//  ===============  Aggregate createStoreFn ============ //

export interface AiInfraStore extends AIProviderStoreState, AiProviderAction, AiModelAction {
  /* empty */
}

type AiInfraStoreAction = AiProviderAction & AiModelAction;

const createStore =
  (services: AiInfraServices): StateCreator<AiInfraStore, [['zustand/devtools', never]]> =>
  (...parameters: Parameters<StateCreator<AiInfraStore, [['zustand/devtools', never]]>>) => ({
    ...initialState,
    ...flattenActions<AiInfraStoreAction>([
      createAiModelSlice(services)(...parameters),
      createAiProviderSlice(services)(...parameters),
    ]),
  });

//  ===============  Implement useStore ============ //
const devtools = createDevtools('aiInfra');

/**
 * Create an isolated aiInfra store bound to the given services (user or admin adapter).
 * The default export {@link useAiInfraStore} is the user-scoped singleton.
 */
export const createAiInfraStore = (services: AiInfraServices = defaultAiInfraServices) =>
  createWithEqualityFn<AiInfraStore>()(devtools(createStore(services)), shallow);

export type AiInfraStoreApi = ReturnType<typeof createAiInfraStore>;

export const useAiInfraStore = createAiInfraStore(defaultAiInfraServices);

expose('aiInfra', useAiInfraStore);

export const getAiInfraStoreState = () => useAiInfraStore.getState();
