import { randomBytes } from 'node:crypto';

import type { z } from 'zod';

import { connectorOAuthStatePayloadSchema } from '../../contracts/platformConnectors';
import { PlatformConnectorContractError } from './errors';

type ConnectorOAuthStatePayload = z.infer<typeof connectorOAuthStatePayloadSchema>;

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_ISSUE_ATTEMPTS = 3;

/**
 * Persistence contract for OAuth state. `take` MUST atomically read and delete
 * the value in one storage operation (for Redis, use GETDEL or a Lua script).
 */
export interface ConnectorOAuthStateBackend {
  putIfAbsent: (key: string, value: string, ttlMs: number) => Promise<boolean>;
  take: (key: string) => Promise<string | null>;
}

interface ConnectorOAuthStateStoreOptions {
  backend: ConnectorOAuthStateBackend;
  clock?: () => number;
  createOpaqueState?: () => string;
  ttlMs?: number;
}

type IssueConnectorOAuthStateInput = Omit<ConnectorOAuthStatePayload, 'expiresAt' | 'issuedAt'>;

export class ConnectorOAuthStateStore {
  private readonly backend: ConnectorOAuthStateBackend;
  private readonly clock: () => number;
  private readonly createOpaqueState: () => string;
  private readonly ttlMs: number;

  constructor(options: ConnectorOAuthStateStoreOptions) {
    this.backend = options.backend;
    this.clock = options.clock ?? Date.now;
    this.createOpaqueState =
      options.createOpaqueState ?? (() => randomBytes(32).toString('base64url'));
    this.ttlMs = options.ttlMs ?? DEFAULT_STATE_TTL_MS;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > MAX_STATE_TTL_MS) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
    }
  }

  issue = async (input: IssueConnectorOAuthStateInput): Promise<string> => {
    const issuedAt = this.clock();
    const payload = connectorOAuthStatePayloadSchema.parse({
      ...input,
      expiresAt: issuedAt + this.ttlMs,
      issuedAt,
    });
    const serialized = JSON.stringify(payload);

    for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
      const state = this.createOpaqueState();
      if (state.length < 32 || state.length > 512) continue;
      if (await this.backend.putIfAbsent(state, serialized, this.ttlMs)) return state;
    }

    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
  };

  consume = async (state: string): Promise<ConnectorOAuthStatePayload> => {
    if (state.length < 32 || state.length > 512) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
    }

    const serialized = await this.backend.take(state);
    if (!serialized) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
    }

    const parsed = connectorOAuthStatePayloadSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
    }
    if (parsed.data.expiresAt <= this.clock()) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_EXPIRED');
    }
    return parsed.data;
  };
}
