import type { InfraSecretAction } from '@/types/platform/infraSettings';

import { INFRA_SECRET_REUSE_MESSAGE } from './destinationTuple';
import { InfraSettingsSecretReuseError } from './errors';
import { sealInfraSecret } from './secrets';

const KEEP_SECRET = { action: 'keep' as const };

export const resolveInfraSecretCiphertext = async (params: {
  action: InfraSecretAction | undefined;
  field: string;
  /** Enable-path only: if keep + stored ciphertext, destination must be unchanged. */
  reuse?: { destinationUnchanged: boolean };
  storedCiphertext: string | undefined;
}): Promise<string | undefined> => {
  const action = params.action ?? KEEP_SECRET;

  if (action.action === 'clear') {
    return undefined;
  }

  if (action.action === 'replace') {
    return sealInfraSecret(action.value);
  }

  const { reuse, storedCiphertext } = params;
  if (reuse && storedCiphertext && !reuse.destinationUnchanged) {
    throw new InfraSettingsSecretReuseError(params.field, INFRA_SECRET_REUSE_MESSAGE);
  }

  return storedCiphertext;
};
