import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
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
const checkSql = (table: Parameters<typeof getTableConfig>[0], name: string) => {
  const check = getTableConfig(table).checks.find((item) => item.name === name);
  if (!check) throw new Error(`Missing check: ${name}`);
  return new PgDialect().sqlToQuery(check.value).sql;
};

describe('platform connector persistence invariants', () => {
  it('declares durable connection-test columns for multi-instance publish gates', () => {
    const config = getTableConfig(platformConnectors);
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'connection_test_status',
        'connection_test_latency_ms',
        'connection_test_error_category',
        'connection_test_message_code',
        'connection_tested_at',
        'connection_tested_draft_token',
        'connection_tested_revision',
      ]),
    );
  });

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
    expect(checkSql(platformConnectors, 'platform_connectors_published_pointer_check')).toMatch(
      /published_revision.*published_checksum.*published_at.*status/s,
    );
    expect(checkSql(platformConnectors, 'platform_connectors_credential_slot_check')).toMatch(
      /shared_secret_ref.*shared_secret_fingerprint.*shared_secret_updated_at.*oauth_client_secret_ref/s,
    );
    expect(checkSql(platformConnectors, 'platform_connectors_oauth_config_check')).toMatch(
      /jsonb_typeof.*octet_length.*client_\?secret/s,
    );
    const publishedForeignKey = config.foreignKeys.find(
      (item) => item.getName() === 'platform_connectors_published_revision_fk',
    );
    const reference = publishedForeignKey?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      'published_resource_type',
      'id',
      'published_revision',
      'published_checksum',
    ]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual([
      'resource_type',
      'resource_id',
      'revision',
      'checksum',
    ]);
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
    expect(checkSql(platformConnectorTools, 'platform_connector_tools_schema_check')).toMatch(
      /jsonb_typeof.*input_schema.*jsonb_typeof.*output_schema.*65536/s,
    );
    expect(checkSql(platformConnectorTools, 'platform_connector_tools_confirmation_check')).toMatch(
      /risk_level.*high.*critical.*requires_confirmation/s,
    );
  });

  it('defines complete binding state and token-reference checks', () => {
    const config = getTableConfig(platformUserConnectorBindings);

    expect(indexNames(config.indexes)).toContain(
      'platform_user_connector_bindings_oauth_state_owner_unique',
    );
    expect(foreignKeyNames(config.foreignKeys)).toContain(
      'platform_user_connector_bindings_revision_fk',
    );
    expect(checkNames(config.checks)).toEqual(
      expect.arrayContaining([
        'platform_user_connector_bindings_revision_check',
        'platform_user_connector_bindings_revoked_check',
        'platform_user_connector_bindings_state_fields_check',
        'platform_user_connector_bindings_token_ref_check',
      ]),
    );
    expect(
      checkSql(
        platformUserConnectorBindings,
        'platform_user_connector_bindings_state_fields_check',
      ),
    ).toMatch(/connected.*oauth_token_ref.*token_fingerprint.*revoked.*cardinality/s);
  });

  it('binds OAuth state to one binding owner and enforces a short positive TTL', () => {
    const config = getTableConfig(platformConnectorOAuthStates);

    expect(foreignKeyNames(config.foreignKeys)).toContain(
      'platform_connector_oauth_states_binding_owner_fk',
    );
    expect(foreignKeyNames(config.foreignKeys)).toContain(
      'platform_connector_oauth_states_revision_fk',
    );
    expect(checkNames(config.checks)).toEqual(
      expect.arrayContaining([
        'platform_connector_oauth_states_outcome_check',
        'platform_connector_oauth_states_revision_check',
        'platform_connector_oauth_states_terminal_check',
        'platform_connector_oauth_states_ttl_check',
      ]),
    );
    expect(
      checkSql(platformConnectorOAuthStates, 'platform_connector_oauth_states_ttl_check'),
    ).toMatch(/expires_at.*created_at.*10 minutes/s);
    expect(
      checkSql(platformConnectorOAuthStates, 'platform_connector_oauth_states_outcome_check'),
    ).toMatch(/authorization_outcome.*finished_at.*completed.*failed/s);
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['authorization_outcome', 'finished_at']),
    );
    const ownerForeignKey = config.foreignKeys.find(
      (item) => item.getName() === 'platform_connector_oauth_states_binding_owner_fk',
    );
    const reference = ownerForeignKey?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      'binding_id',
      'user_id',
      'connector_id',
    ]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual([
      'id',
      'user_id',
      'connector_id',
    ]);
    const revisionForeignKey = config.foreignKeys.find(
      (item) => item.getName() === 'platform_connector_oauth_states_revision_fk',
    );
    const revisionReference = revisionForeignKey?.reference();
    expect(revisionReference?.columns.map((column) => column.name)).toEqual([
      'revision_resource_type',
      'connector_id',
      'published_revision',
    ]);
    expect(revisionReference?.foreignColumns.map((column) => column.name)).toEqual([
      'resource_type',
      'resource_id',
      'revision',
    ]);
  });
});
