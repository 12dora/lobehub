import { createHash } from 'node:crypto';

import debug from 'debug';

import {
  CONTAINER_NAME_PREFIX,
  DEFAULT_DISK_MB,
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
import type { DockerContainerSummary, DockerEngineClient } from './dockerEngineClient';
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

export class LocalSandboxDiskError extends Error {
  constructor(message = 'Sandbox disk quota exceeded') {
    super(message);
    this.name = 'LocalSandboxDiskError';
  }
}

export interface LocalSandboxSupervisorOptions {
  /**
   * Workspace tmpfs size in MiB. This is a hard quota (size=Nm) and counts
   * toward host RAM, not disk; data lifetime equals the session.
   */
  diskMb: number;
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
  provision?: Promise<void>;
  volumeName: string;
}

/**
 * In-process supervisor for local Docker sandboxes.
 *
 * Single-replica assumption: TTL reaping and maxContainers are enforced for
 * THIS process against daemon state it has adopted. Cross-replica leasing
 * (two AIHub replicas sharing one Docker daemon) is out of scope — deploy a
 * single replica against a given daemon, or accept that each replica will
 * independently create/reap labeled containers.
 */
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

const LABEL_FILTER = { label: [`${SANDBOX_LABEL}=${SANDBOX_LABEL_VALUE}`] };

export class LocalSandboxSupervisor {
  readonly sessions = new Map<string, SandboxSessionRecord>();

  private readonly client: DockerEngineClient;
  private readonly options: LocalSandboxSupervisorOptions;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly ready: Promise<void>;
  private reaper?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(client: DockerEngineClient, options: LocalSandboxSupervisorOptions) {
    this.client = client;
    this.options = {
      ...options,
      diskMb: options.diskMb || DEFAULT_DISK_MB,
      idleTtlSec: options.idleTtlSec || DEFAULT_IDLE_TTL_SEC,
      image: options.image || DEFAULT_SANDBOX_IMAGE,
      maxContainers: options.maxContainers || DEFAULT_MAX_CONTAINERS,
      memoryBytes: options.memoryBytes || DEFAULT_MEMORY_BYTES,
      nanoCpus: options.nanoCpus || DEFAULT_NANO_CPUS,
      pidsLimit: options.pidsLimit || DEFAULT_PIDS_LIMIT,
    };

    this.ready = this.reconcile().catch((error) => {
      log('reconcile failed: %O', error);
    });

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
    await this.ready;
    const key = sessionKey(session);

    if (!this.sessions.has(key) && this.sessions.size >= this.options.maxContainers) {
      await this.reapIdle();
    }

    const record = await this.withLock(key, async () => this.leaseLocked(session));

    try {
      if (!record.containerId) {
        record.provision ??= this.provision(record, session);
        await record.provision;
      }
      await this.ensureRunning(record);
      return await fn(record);
    } finally {
      await this.withLock(key, async () => {
        const current = this.sessions.get(key);
        if (current && current.containerName === record.containerName) {
          current.inFlight = Math.max(0, current.inFlight - 1);
          current.lastUsedAt = Date.now();
        }
      });
    }
  }

  /**
   * Drop the session container/volume (e.g. after an HTTP watchdog timeout
   * where in-container `timeout` failed to finish). Next withSession creates
   * a fresh sandbox.
   */
  async invalidate(session: LocalSandboxSession): Promise<void> {
    await this.ready;
    const key = sessionKey(session);
    await this.withLock(key, async () => {
      const record = this.sessions.get(key);
      if (!record) return;
      await this.destroySession(key, record);
    });
  }

  async reapIdle(now = Date.now()): Promise<string[]> {
    await this.ready;
    const ttlMs = this.options.idleTtlSec * 1000;
    const removed: string[] = [];

    for (const key of this.sessions.keys()) {
      const didRemove = await this.withLock(key, async () => {
        const record = this.sessions.get(key);
        if (!record) return false;
        if (record.inFlight > 0) return false;
        if (now - record.lastUsedAt < ttlMs) return false;
        await this.destroySession(key, record);
        return true;
      });
      if (didRemove) removed.push(key);
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
    await this.ready.catch(() => undefined);
  }

  private async leaseLocked(session: LocalSandboxSession): Promise<SandboxSessionRecord> {
    const key = sessionKey(session);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.inFlight += 1;
      existing.lastUsedAt = Date.now();
      return existing;
    }

    return this.withLock('__create__', async () => {
      const raced = this.sessions.get(key);
      if (raced) {
        raced.inFlight += 1;
        raced.lastUsedAt = Date.now();
        return raced;
      }

      if (this.sessions.size >= this.options.maxContainers) {
        throw new LocalSandboxCapacityError(this.options.maxContainers);
      }

      const containerName = dockerSafeName(CONTAINER_NAME_PREFIX, session.userId, session.topicId);
      const volumeName = dockerSafeName(VOLUME_NAME_PREFIX, session.userId, session.topicId);
      const record: SandboxSessionRecord = {
        containerId: '',
        containerName,
        inFlight: 1,
        lastUsedAt: Date.now(),
        volumeName,
      };
      this.sessions.set(key, record);
      return record;
    });
  }

  private async provision(record: SandboxSessionRecord, session: LocalSandboxSession) {
    await this.ensureImage();

    const labels = {
      [SANDBOX_LABEL]: SANDBOX_LABEL_VALUE,
      'aihub.sandbox.topicId': session.topicId,
      'aihub.sandbox.userId': session.userId,
      'aihub.sandbox.volume': record.volumeName,
    };

    // Fail closed: no unbounded named volume fallback if tmpfs quota cannot be set.
    try {
      await this.client.volumeCreate(record.volumeName, {
        driver: 'local',
        driverOpts: {
          device: 'tmpfs',
          o: `size=${this.options.diskMb}m,uid=1000,gid=1000`,
          type: 'tmpfs',
        },
        labels,
      });
    } catch (error) {
      if (!(error instanceof DockerEngineError) || error.status !== 409) {
        throw error;
      }
    }

    try {
      const created = await this.client.containerCreate(record.containerName, {
        Cmd: ['sh', '-c', 'exec sleep 2147483647'],
        Env: ['HOME=/mnt/data', 'TMPDIR=/tmp'],
        HostConfig: {
          CapDrop: ['ALL'],
          Memory: this.options.memoryBytes,
          Mounts: [
            {
              Source: record.volumeName,
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
      record.containerId = created.Id;
    } catch (error) {
      if (error instanceof DockerEngineError && error.status === 409) {
        const inspect = await this.client.containerInspect(record.containerName);
        record.containerId = inspect.Id;
      } else {
        throw error;
      }
    }
  }

  /**
   * Adopt labeled containers/volumes already on the daemon so a process restart
   * does not forget running sandboxes (they count toward maxContainers and TTL).
   */
  private async reconcile(): Promise<void> {
    const containers = await this.client.containerList({ all: true, filters: LABEL_FILTER });
    const seenVolumes = new Set<string>();

    for (const container of containers) {
      const adopted = this.adoptContainer(container);
      if (adopted) seenVolumes.add(adopted.volumeName);
    }

    const volumes = await this.client.volumeList({ filters: LABEL_FILTER }).catch(() => []);
    for (const volume of volumes) {
      if (seenVolumes.has(volume.Name)) continue;
      // Orphan volume (no matching container) — drop it.
      try {
        await this.client.volumeRemove(volume.Name, true);
      } catch (error) {
        if (!isDockerNotFound(error)) {
          log('failed to remove orphan volume %s: %O', volume.Name, error);
        }
      }
    }

    await this.reapIdleUnlocked();
  }

  private adoptContainer(container: DockerContainerSummary): SandboxSessionRecord | undefined {
    const labels = container.Labels ?? {};
    const userId = labels['aihub.sandbox.userId'];
    const topicId = labels['aihub.sandbox.topicId'];
    if (!userId || !topicId) return undefined;

    const key = sessionKey({ topicId, userId });
    if (this.sessions.has(key)) return this.sessions.get(key);

    const volumeName =
      labels['aihub.sandbox.volume'] || dockerSafeName(VOLUME_NAME_PREFIX, userId, topicId);
    const record: SandboxSessionRecord = {
      containerId: container.Id,
      containerName: (container.Names?.[0] ?? '').replace(/^\//, '') || container.Id,
      inFlight: 0,
      lastUsedAt: lastUsedFromSummary(container),
      volumeName,
    };
    this.sessions.set(key, record);
    return record;
  }

  /**
   * Reap without awaiting `ready` (used at the end of reconcile itself).
   */
  private async reapIdleUnlocked(now = Date.now()): Promise<void> {
    const ttlMs = this.options.idleTtlSec * 1000;
    for (const key of this.sessions.keys()) {
      await this.withLock(key, async () => {
        const record = this.sessions.get(key);
        if (!record) return;
        if (record.inFlight > 0) return;
        if (now - record.lastUsedAt < ttlMs) return;
        await this.destroySession(key, record);
      });
    }
  }

  private async destroySession(key: string, record: SandboxSessionRecord) {
    log('reaping sandbox session %s container %s', key, record.containerId);
    this.sessions.delete(key);
    if (record.containerId) {
      try {
        await this.client.containerRemove(record.containerId, { force: true });
      } catch (error) {
        if (!isDockerNotFound(error)) {
          log('failed to remove container %s: %O', record.containerId, error);
        }
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
    if (!record.containerId) return;
    try {
      const inspect = await this.client.containerInspect(record.containerId);
      record.containerId = inspect.Id;
      if (inspect.State?.StartedAt) {
        const started = Date.parse(inspect.State.StartedAt);
        if (Number.isFinite(started) && started > record.lastUsedAt && record.inFlight === 0) {
          record.lastUsedAt = started;
        }
      }
      if (inspect.State?.Running) return;
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      throw error;
    }

    await this.client.containerStart(record.containerId);
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

const lastUsedFromSummary = (container: DockerContainerSummary) => {
  if (typeof container.Created === 'number' && Number.isFinite(container.Created)) {
    return container.Created < 1e12 ? container.Created * 1000 : container.Created;
  }
  return Date.now();
};
