import type { ModelProviderCard } from '../types';

// Not on DEFAULT_MODEL_PROVIDER_LIST: Jamba/Maestro sunset 2026-08-09, no replacement.
const Ai21: ModelProviderCard = {
  chatModels: [],
  checkModel: 'jamba-mini',
  description:
    'AI21 Labs builds foundation models and AI systems for enterprises, accelerating generative AI in production.',
  id: 'ai21',
  name: 'Ai21Labs',
  settings: {
    sdkType: 'openai',
  },
  url: 'https://www.ai21.com/',
};

export default Ai21;
