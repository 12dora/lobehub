import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';

import { redactSecrets } from './b1';

export interface EngineLogRing {
  append: (chunk: string) => void;
  clear: () => void;
  get: () => string[];
}

export const createEngineLogRing = (
  maxLines: number = NETWORK_PROXY_LIMITS.ENGINE_LOG_LINES,
): EngineLogRing => {
  const lines: string[] = [];

  return {
    append: (chunk: string) => {
      const redacted = redactSecrets(chunk);
      for (const line of redacted.split(/\r?\n/u)) {
        if (!line) continue;
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    clear: () => {
      lines.length = 0;
    },
    get: () => [...lines],
  };
};
