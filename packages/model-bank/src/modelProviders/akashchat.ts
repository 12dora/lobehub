import type { ModelProviderCard } from '../types';

const AkashChat: ModelProviderCard = {
  chatModels: [],
  checkModel: 'zai-org/GLM-5.2',
  description:
    'AkashML provides managed inference for open source AI models, powered by the Akash Network.',
  id: 'akashchat',
  modelsUrl: 'https://akashml.com/docs',
  name: 'AkashML',
  settings: {
    sdkType: 'openai',
    showModelFetcher: true,
  },
  url: 'https://akashml.com/',
};

export default AkashChat;
