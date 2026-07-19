import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

export interface RestartLifecycleEvent {
  exitCode?: number | null;
  generation: number;
  pid: number;
  signal?: NodeJS.Signals | null;
  startTime: string;
  type: 'exit' | 'start';
}

export interface RestartingWebServerOptions {
  command?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  healthUrl: string;
  killTimeoutMs?: number;
  port: number;
  startupTimeoutMs?: number;
}

const wait = async (milliseconds: number) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const isGracefulSigterm = (exitCode: number | null, signal: NodeJS.Signals | null): boolean =>
  signal === 'SIGTERM' || (signal === null && exitCode === 128 + 15);

const terminateProcessGroup = (child: ChildProcess) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

export class RestartingWebServer {
  private child: ChildProcess | undefined;
  private generation = 0;
  private readonly lifecycle: RestartLifecycleEvent[] = [];
  private readonly options: RestartingWebServerOptions;
  private readyWaiter: Promise<void> | undefined;
  private rejectFatal!: (error: Error) => void;
  private stopping = false;

  readonly fatal: Promise<never>;

  constructor(options: RestartingWebServerOptions) {
    this.options = options;
    this.fatal = new Promise<never>((_resolve, reject) => {
      this.rejectFatal = reject;
    });
    void this.fatal.catch(() => undefined);
  }

  get events(): readonly RestartLifecycleEvent[] {
    return this.lifecycle;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private spawnChild = () => {
    this.generation += 1;
    const command = this.options.command ?? [
      process.execPath,
      path.resolve(this.options.cwd, 'node_modules/next/dist/bin/next'),
      'start',
      '-p',
      String(this.options.port),
    ];
    const [executable, ...args] = command;
    const child = spawn(executable, args, {
      cwd: this.options.cwd,
      detached: true,
      env: this.options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.pid) throw new Error('supervised child PID unavailable');
    this.child = child;
    const event: RestartLifecycleEvent = {
      generation: this.generation,
      pid: child.pid,
      startTime: new Date().toISOString(),
      type: 'start',
    };
    this.lifecycle.push(event);
    console.info('[identity-provider-e2e] supervised child start', event);
    child.stdout?.on('data', (chunk) => process.stdout.write(`[next:${this.generation}] ${chunk}`));
    child.stderr?.on('data', (chunk) => process.stderr.write(`[next:${this.generation}] ${chunk}`));
    child.once('error', (error) => this.rejectFatal(error));
    child.once('exit', (exitCode, signal) => {
      const exitEvent: RestartLifecycleEvent = {
        exitCode,
        generation: event.generation,
        pid: event.pid,
        signal,
        startTime: event.startTime,
        type: 'exit',
      };
      this.lifecycle.push(exitEvent);
      console.info('[identity-provider-e2e] supervised child exit', exitEvent);
      if (this.child === child) this.child = undefined;
      if (this.stopping) return;
      if (!isGracefulSigterm(exitCode, signal)) {
        this.rejectFatal(
          new Error(
            `supervised child exited unexpectedly (code=${exitCode ?? 'null'}, signal=${signal ?? 'null'})`,
          ),
        );
        return;
      }
      this.spawnChild();
      this.readyWaiter = this.waitUntilReady();
    });
  };

  private waitUntilReady = async () => {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (!this.child) await Promise.race([wait(100), this.fatal]);
      try {
        const response = await fetch(this.options.healthUrl, { redirect: 'manual' });
        if (response.status > 0 && response.status < 500) return;
      } catch {
        // Child is still booting.
      }
      await Promise.race([wait(250), this.fatal]);
    }
    throw new Error(`supervised child failed health check: ${this.options.healthUrl}`);
  };

  start = async (): Promise<void> => {
    if (this.child || this.stopping) throw new Error('supervisor already started or stopped');
    this.spawnChild();
    this.readyWaiter = this.waitUntilReady();
    await this.readyWaiter;
  };

  waitForGeneration = async (generation: number): Promise<void> => {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (this.generation >= generation) {
        await this.readyWaiter;
        return;
      }
      await Promise.race([wait(100), this.fatal]);
    }
    throw new Error(`supervisor did not reach generation ${generation}`);
  };

  stop = async (): Promise<void> => {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    terminateProcessGroup(child);
    const exitedBeforeKill = await Promise.race([
      exited.then(() => true),
      wait(this.options.killTimeoutMs ?? 10_000).then(() => false),
    ]);
    if (!exitedBeforeKill && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await exited;
    }
  };
}
