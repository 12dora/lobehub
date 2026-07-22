import { OPENAI_RESPONSES_SDK_OPTION, type RequestFormatOptionValue } from './providerSettings';

export const CUSTOM_PROVIDER_SDK_OPTIONS = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'OpenAI Response', value: OPENAI_RESPONSES_SDK_OPTION },
  { label: 'Azure OpenAI', value: 'azure' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Google', value: 'google' },
  { label: 'Cloudflare', value: 'cloudflare' },
  { label: 'Qwen', value: 'qwen' },
  { label: 'Volcengine', value: 'volcengine' },
  { label: 'Ollama', value: 'ollama' },
  { label: 'New API', value: 'router' },
] satisfies { label: string; value: RequestFormatOptionValue }[];
