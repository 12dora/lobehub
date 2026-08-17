/**
 * One-click geoip + geosite install helpers for `admin.networkProxy.installGeodata`.
 *
 * Lives beside the router so G1a can own `networkProxySupport.ts` without a merge
 * conflict. Imports the per-kind primitives from that file; does not reimplement them.
 */
import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type { LobeChatDatabase } from '@/database/type';
import type { DesiredArtifacts, NetworkProxyArtifactKind } from '@/types/platform/networkProxy';

import type {
  AdminNetworkProxyInstallGeodataResult,
  AdminNetworkProxyLocalOutcome,
} from '../../contracts/adminNetworkProxy';
import type { NetworkProxyRuntime } from './networkProxySupport';
import {
  appendInstallCompletionAudit,
  desiredArtifactsPatchFor,
  runLocalArtifactInstall,
} from './networkProxySupport';

export const NETWORK_PROXY_GEODATA_KINDS = ['geoip', 'geosite'] as const satisfies readonly [
  NetworkProxyArtifactKind,
  NetworkProxyArtifactKind,
];

export const mergeDesiredGeodataPatch = (requestedAt: string): DesiredArtifacts => ({
  ...desiredArtifactsPatchFor('geoip', requestedAt),
  ...desiredArtifactsPatchFor('geosite', requestedAt),
});

export const geodataInstallAfterDiff = (revision: number) => ({
  commit: NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit,
  kinds: [...NETWORK_PROXY_GEODATA_KINDS],
  revision,
  source: 'download' as const,
});

export const aggregateGeodataLocal = (
  results: readonly AdminNetworkProxyInstallGeodataResult[],
): AdminNetworkProxyLocalOutcome => ({
  error: results.find((result) => result.error !== null)?.error ?? null,
  ok: results.every((result) => result.ok),
});

export const runLocalGeodataInstalls = async (
  runtime: NetworkProxyRuntime,
  input: {
    proxyUrl: string | null;
    revision: number;
    serverDB: LobeChatDatabase;
    userId: string;
  },
): Promise<{
  local: AdminNetworkProxyLocalOutcome;
  results: AdminNetworkProxyInstallGeodataResult[];
}> => {
  const results: AdminNetworkProxyInstallGeodataResult[] = [];
  for (const kind of NETWORK_PROXY_GEODATA_KINDS) {
    const installed = await runLocalArtifactInstall(runtime, kind, input.proxyUrl);
    await appendInstallCompletionAudit(
      { serverDB: input.serverDB, userId: input.userId },
      { kind, local: installed, revision: input.revision },
    );
    results.push({ error: installed.error, kind, ok: installed.ok });
  }
  return { local: aggregateGeodataLocal(results), results };
};
