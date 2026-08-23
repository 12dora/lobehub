import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';

import { SettingsPathError } from './effectiveSettingsErrors';
import { flattenLeaves } from './pathUtils';
import { settingsRegistry } from './registry';

export function collectLegacyOverrideOps(
  validatedInput: Record<string, unknown>,
): Array<{ path: string; value: unknown }> {
  const leaves = flattenLeaves(validatedInput).filter((l) => !l.path.startsWith('keyVaults'));
  const ops: Array<{ path: string; value: unknown }> = [];

  for (const leaf of leaves) {
    const { path, value } = leaf;
    if (settingsRegistry.isSecretPath(path)) {
      throw new SettingsPathError(
        MANAGED_ERROR_CODES.MANAGED_SETTING_SECRET_PATH,
        `Secret path not allowed: ${path}`,
      );
    }
    if (!settingsRegistry.has(path)) {
      // known catalog leaf not in platform registry → stays in legacy partial
      continue;
    }
    // Legacy updateSettings is a user-facing client API (web/desktop/mobile)
    const gate = settingsRegistry.assertPathWritable({ client: 'web', path });
    if (gate) throw new SettingsPathError(gate);

    const validated = settingsRegistry.validateValue(path, value);
    if (!validated.ok) {
      throw new SettingsPathError(
        MANAGED_ERROR_CODES.MANAGED_SETTING_INVALID_VALUE,
        validated.message,
      );
    }
    ops.push({ path, value: validated.value });
  }

  return ops;
}
