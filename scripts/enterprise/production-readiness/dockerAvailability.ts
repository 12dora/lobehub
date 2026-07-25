/**
 * Shared Docker availability probe for production-readiness recovery suites.
 *
 * CI / required lanes must fail closed when Docker is missing.
 * Local developer runs may skip Docker-backed cases (reported as skipped, never as passed).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const probeDockerAvailable = async (timeoutMs = 10_000): Promise<boolean> => {
  try {
    await execFileAsync('docker', ['info'], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
};

/** True when this process must execute Docker-backed recovery assertions (never soft-pass). */
export const dockerIntegrationRequired = (): boolean =>
  process.env.CI === 'true' || process.env.REQUIRE_DOCKER_INTEGRATION === '1';

/**
 * Fail immediately when Docker is required but unavailable.
 * Call after probe so CI never records a green recovery suite without real DB checks.
 */
export const assertDockerAvailableForIntegration = (hasDocker: boolean): void => {
  if (hasDocker) return;
  if (!dockerIntegrationRequired()) return;
  throw new Error(
    'Docker is required for production-readiness recovery integration assertions but is not available. ' +
      'Install/start Docker, or unset CI/REQUIRE_DOCKER_INTEGRATION for a local unit-only run.',
  );
};
