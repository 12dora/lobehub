import type { ModelProviderCard } from '../types';

// Not on DEFAULT_MODEL_PROVIDER_LIST: GitHub Models retired 2026-07-30 (catalogue + inference 410).
const Github: ModelProviderCard = {
  chatModels: [],
  checkModel: 'microsoft/Phi-3-mini-4k-instruct',
  description: 'GitHub Models has been retired. Existing credentials can still be disabled here.',
  id: 'github',
  name: 'GitHub',
  settings: {
    sdkType: 'azure',
    showModelFetcher: false,
  },
  url: 'https://github.blog/changelog/2026-07-30-github-models-is-now-retired/',
};

export default Github;
