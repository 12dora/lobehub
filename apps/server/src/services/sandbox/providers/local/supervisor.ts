import { createHash } from 'node:crypto';

import debug from 'debug';

import {
  CONTAINER_NAME_PREFIX,
  DEFAULT_IDLE_TTL_SEC,
  DEFAULT_MAX_CONTAINERS,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_NANO_CPUS,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_LABEL,
  SANDBOX_LABEL_VALUE,
  SANDBOX_TMP,
  SANDBOX_USER,
  SANDBOX_WORKSPACE,
  VOLUME_NAME_PREFIX,
} from './constants';
import type { DockerEngineClient } from './dockerEngineClient';
import { DockerEngineError, isDockerNotFound } from './dockerEngineClient';
import type { LocalSandboxSession } from './sessionContext';

const log = debug('lobe-server:sandbox:local:supervisor');

export class LocalSandboxCapacityError extends Error {
  constructor(maxContainers: number) {
    super(
      `Local sandbox capacity exceeded: ${maxContainers} concurrent containers. Wait for idle sandboxes to expire or stop unused sessions.`,
    );
    this.name = 'LocalSandboxCapacityError';
  }
}

export class LocalSandboxImageError extends Error {
  constructor(image: string, cause?: string) {
    super(
      cause ||
        `Sandbox image '${image}' is not present on the Docker daemon. Pull it manually or enable pullOnDemand.`,
    );
    this.name = 'LocalSandboxImageError';
  }
}

export interface LocalSandboxSupervisorOptions {
  idleTtlSec: number;
  image: string;
  maxContainers: number;
  memoryBytes: number;
  nanoCpus: number;
  network: 'bridge' | 'none';
  pidsLimit: number;
  pullOnDemand: boolean;
  pullPolicy: 'always' | 'if-missing' | 'never';
  reaperIntervalMs?: number;
}

export interface SandboxSessionRecord {
  containerId: string;
  containerName: string;
  inFlight: number;
  lastUsedAt: number;
  volumeName: string;
}

const supervisors = new Map<string, LocalSandboxSupervisor>();

export const getLocalSandboxSupervisor = (
  client: DockerEngineClient,
  options: LocalSandboxSupervisorOptions,
): LocalSandboxSupervisor => {
  const key = client.endpointKey();
  const existing = supervisors.get(key);
  if (existing) return existing;

  const supervisor = new LocalSandboxSupervisor(client, options);
  supervisors.set(key, supervisor);
  return supervisor;
};

export const resetLocalSandboxSupervisors = async (): Promise<void> => {
  const current = [...supervisors.values()];
  supervisors.clear();
  await Promise.all(current.map(async (supervisor) => supervisor.dispose()));
};

const dockerSafeName = (prefix: string, userId: string, topicId: string) => {
  const raw = `${prefix}-${userId}-${topicId}`.replaceAll(/[^\w.-]/g, '-').toLowerCase();
  if (raw.length <= 80 && /^[a-z0-9]/.test(raw)) return raw;
  const hash = createHash('sha256').update(`${userId}:${topicId}`).digest('hex').slice(0, 24);
  return `${prefix}-${hash}`;
};

export const sessionKey = (session: LocalSandboxSession) => `${session.userId}::${session.topicId}`;

export class LocalSandboxSupervisor {
  readonly sessions = new Map<string, SandboxSessionRecord>();

  private readonly client: DockerEngineClient;
  private readonly options: LocalSandboxSupervisorOptions;
  private readonly locks = new Map<string, Promise<void>>();
  private reaper?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(client: DockerEngineClient, options: LocalSandboxSupervisorOptions) {
    this.client = client;
    this.options = {
      ...options,
      idleTtlSec: options.idleTtlSec || DEFAULT_IDLE_TTL_SEC,
      image: options.image || DEFAULT_SANDBOX_IMAGE,
      maxContainers: options.maxContainers || DEFAULT_MAX_CONTAINERS,
      memoryBytes: options.memoryBytes || DEFAULT_MEMORY_BYTES,
      nanoCpus: options.nanoCpus || DEFAULT_NANO_CPUS,
      pidsLimit: options.pidsLimit || DEFAULT_PIDS_LIMIT,
    };

    const interval =
      options.reaperIntervalMs ??
      Math.max(250, Math.min(30_000, Math.floor(this.options.idleTtlSec * 1000) / 6));
    this.reaper = setInterval(() => {
      void this.reapIdle().catch((error) => {
        log('idle reaper failed: %O', error);
      });
    }, interval);
    this.reaper.unref?.();
  }

  activeCount() {
    return this.sessions.size;
  }

  async withSession<T>(
    session: LocalSandboxSession,
    fn: (record: SandboxSessionRecord) => Promise<T>,
  ): Promise<T> {
    const record = await this.ensureContainer(session);
    record.inFlight += 1;
    record.lastUsedAt = Date.now();
    try {
      return await fn(record);
    } finally {
      record.inFlight = Math.max(0, record.inFlight - 1);
      record.lastUsedAt = Date.now();
    }
  }

  async ensureContainer(session: LocalSandboxSession): Promise<SandboxSessionRecord> {
    const key = sessionKey(session);
    const existing = this.sessions.get(key);
    if (existing) {
      return this.withLock(key, async () => {
        const current = this.sessions.get(key);
        if (!current) return this.ensureContainer(session);
        await this.ensureRunning(current);
        current.lastUsedAt = Date.now();
        return current;
      });
    }

    return this.withLock('__create__', async () => {
      const raced = this.sessions.get(key);
      if (raced) {
        await this.ensureRunning(raced);
        raced.lastUsedAt = Date.now();
        return raced;
      }

      if (this.sessions.size >= this.options.maxContainers) {
        await this.reapIdle();
      }
      if (this.sessions.size >= this.options.maxContainers) {
        throw new LocalSandboxCapacityError(this.options.maxContainers);
      }

      await this.ensureImage();

      const containerName = dockerSafeName(CONTAINER_NAME_PREFIX, session.userId, session.topicId);
      const volumeName = dockerSafeName(VOLUME_NAME_PREFIX, session.userId, session.topicId);
      const labels = {
        [SANDBOX_LABEL]: SANDBOX_LABEL_VALUE,
        'aihub.sandbox.topicId': session.topicId,
        'aihub.sandbox.userId': session.userId,
        'aihub.sandbox.volume': volumeName,
      };

      try {
        await this.client.volumeCreate(volumeName, labels);
      } catch (error) {
        if (!(error instanceof DockerEngineError) || error.status !== 409) {
          throw error;
        }
      }

      let containerId: string;
      try {
        const created = await this.client.containerCreate(containerName, {
          Cmd: ['sh', '-c', 'exec sleep 2147483647'],
          Env: ['HOME=/mnt/data', 'TMPDIR=/tmp'],
          HostConfig: {
            CapDrop: ['ALL'],
            Memory: this.options.memoryBytes,
            Mounts: [
              {
                Source: volumeName,
                Target: SANDBOX_WORKSPACE,
                Type: 'volume',
              },
            ],
            NanoCpus: this.options.nanoCpus,
            NetworkMode: this.options.network,
            PidsLimit: this.options.pidsLimit,
            Privileged: false,
            ReadonlyRootfs: true,
            SecurityOpt: ['no-new-privileges'],
            Tmpfs: { [SANDBOX_TMP]: 'rw,noexec,nosuid,size=256m' },
          },
          Image: this.options.image,
          Labels: labels,
          User: SANDBOX_USER,
          WorkingDir: SANDBOX_WORKSPACE,
        });
        containerId = created.Id;
      } catch (error) {
        if (error instanceof DockerEngineError && error.status === 409) {
          const inspect = await this.client.containerInspect(containerName);
          containerId = inspect.Id;
        } else {
          throw error;
        }
      }

      const record: SandboxSessionRecord = {
        containerId,
        containerName,
        inFlight: 0,
        lastUsedAt: Date.now(),
        volumeName,
      };

      await this.ensureRunning(record);
      await this.chownWorkspace(record.containerId);
      this.sessions.set(key, record);
      return record;
    });
  }

  async reapIdle(now = Date.now()): Promise<string[]> {
    const ttlMs = this.options.idleTtlSec * 1000;
    const removed: string[] = [];

    for (const [key, record] of this.sessions) {
      if (record.inFlight > 0) continue;
      if (now - record.lastUsedAt < ttlMs) continue;
      await this.destroySession(key, record);
      removed.push(key);
    }

    return removed;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
  }

  private async destroySession(key: string, record: SandboxSessionRecord) {
    log('reaping sandbox session %s container %s', key, record.containerId);
    this.sessions.delete(key);
    try {
      await this.client.containerRemove(record.containerId, { force: true });
    } catch (error) {
      if (!isDockerNotFound(error)) {
        log('failed to remove container %s: %O', record.containerId, error);
      }
    }
    try {
      await this.client.volumeRemove(record.volumeName, true);
    } catch (error) {
      if (!isDockerNotFound(error)) {
        log('failed to remove volume %s: %O', record.volumeName, error);
      }
    }
  }

  private async ensureRunning(record: SandboxSessionRecord) {
    try {
      const inspect = await this.client.containerInspect(record.containerId);
      record.containerId = inspect.Id;
      if (inspect.State?.Running) return;
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      for (const [key, value] of this.sessions) {
        if (value.containerId === record.containerId) this.sessions.delete(key);
      }
      throw error;
    }

    await this.client.containerStart(record.containerId);
  }

  private async chownWorkspace(containerId: string) {
    try {
      const exec = await this.client.execCreate(containerId, {
        Cmd: ['chown', '1000:1000', SANDBOX_WORKSPACE],
        User: '0:0',
      });
      await this.client.execStart(exec.Id, {
        containerId,
        maxOutputBytes: 1024,
        timeoutMs: 10_000,
      });
    } catch (error) {
      log('chown /mnt/data failed (continuing): %O', error);
    }
  }

  private async ensureImage() {
    const { image, pullPolicy, pullOnDemand } = this.options;
    const present = await this.imagePresent();

    const shouldPull =
      pullPolicy === 'always' || (pullPolicy !== 'never' && pullOnDemand !== false && !present);

    if (present && pullPolicy !== 'always') return;

    if (!shouldPull) {
      throw new LocalSandboxImageError(image);
    }

    try {
      await this.client.imagePull(image);
    } catch (error) {
      throw new LocalSandboxImageError(image, (error as Error).message);
    }
  }

  private async imagePresent() {
    try {
      await this.client.imageInspect(this.options.image);
      return true;
    } catch (error) {
      if (isDockerNotFound(error)) return false;
      throw error;
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      key,
      previous.then(
        () => gate,
        () => gate,
      ),
    );
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
