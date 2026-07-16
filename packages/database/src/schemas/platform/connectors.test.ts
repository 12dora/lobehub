import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorTools,
  platformUserConnectorBindings,
} from './connectors';

const checkNames = (items: Array<{ name: string }>) => items.map((item) => item.name);
const foreignKeyNames = (items: Array<{ getName: () => string }>) =>
  items.map((item) => item.getName());
const indexNames = (items: Array<{ config: { name?: string } }>) =>
  items.map((item) => item.config.name);

describe('platform connector persistence invariants', () => {
  it('pins a published connector to an immutable revision from the same resource identity', () => {
    const config = getTableConfig(platformConnectors);

    expect(foreignKeyNames(config.foreignKeys)).toContain(
      'platform_connectors_published_revision_fk',
    );
    expect(checkNames(config.checks)).toEqual(
      expect.arrayContaining([
        'platform_connectors_credential_slot_check',
        'platform_connectors_oauth_config_check',
        'platform_connectors_published_pointer_check',
        'platform_connectors_published_shared_secret_check',
        'platform_connectors_revision_check',
      ]),
    );
  });

  it('keeps tool schemas bounded and forces confirmation for high-risk tools', () => {
    const config = getTableConfig(platformConnectorTools);

    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['input_schema', 'output_schema']),
    );
    expect(checkNames(config.checks)).toEqual(
      expect.arrayContaining([
        'platform_connector_tools_confirmation_check',
        'platform_connector_tools_schema_check',
      ]),
    );
  });

  it('defines complete binding state and token-reference checks', () => {
    const config = getTableConfig(platformUserConnectorBindings);

    expect(indexNames(config.indexes)).toContain(
      'platform_user_connector_bindings_oauth_state_owner_unique',
    );
    expect(checkNames(config.checks)).toEqual(
      expect.arrayContaining([
        'platform_user_connector_bindings_revision_check',
        'platform_user_connector_bindings_revoked_check',
        'platform_user_connector_bindings_state_fields_check',
        'platform_user_connector_bindings_token_ref_check',
      ]),
    );
  });

  it('binds OAuth state to one binding owner and enforces a short positive TTL', () => {
    const config = getTableConfig(platformConnectorOAuthStates);

    expect(foreignKeyNames(config.foreignKeys)).toContain(
      'platform_connector_oauth_states_binding_owner_fk',
    );
    expect(checkNames(config.checks)).toEqual(
      expect.arrayContaining([
        'platform_connector_oauth_states_revision_check',
        'platform_connector_oauth_states_terminal_check',
        'platform_connector_oauth_states_ttl_check',
      ]),
    );
  });
});
