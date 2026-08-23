import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';

const execFileAsync = promisify(execFile);
const SMOKE_TIMEOUT_MS = 10_000;

let lastSmokeOutput: string | null = null;

export const getLastEngineSmokeOutput = (): string | null => lastSmokeOutput;

export const resetSmokeCachesForTest = (): void => {
  lastSmokeOutput = null;
};

export const parseMihomoVersion = (output: string): string | null => {
  const match = /v?\d+\.\d+\.\d+/u.exec(output);
  return match?.[0] ? (match[0].startsWith('v') ? match[0] : `v${match[0]}`) : null;
};

export const smokeTestEngineBinary = async (
  binPath: string,
): Promise<{ smokeOutput: string; version: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, ['-v'], {
      timeout: SMOKE_TIMEOUT_MS,
    });
    const text = `${stdout}\n${stderr}`;
    const firstLine = text.trim().split('\n')[0] ?? 'unknown';
    lastSmokeOutput = firstLine;
    return {
      smokeOutput: firstLine,
      version: parseMihomoVersion(text) ?? firstLine,
    };
  } catch {
    return throwNetworkProxyError(
      NETWORK_PROXY_ENGINE_ERROR_CODES.ENGINE_ERROR,
      'engine binary failed the -v smoke test',
    );
  }
};
