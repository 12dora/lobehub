import type { SandboxCallToolResult } from '@lobechat/builtin-tool-cloud-sandbox';
import { isRecord } from '@lobechat/utils';
import debug from 'debug';
import { sha256 } from 'js-sha256';

import type {
  LocalSandboxProviderOptions,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderFileExportRequest,
  SandboxProviderFileExportResult,
  SandboxSessionContext,
} from '../../types';
import {
  DEFAULT_DISK_MB,
  DEFAULT_IDLE_TTL_SEC,
  DEFAULT_MAX_CONTAINERS,
  DEFAULT_MAX_EXPORT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_NANO_CPUS,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_TIMEOUT_MS,
  EXEC_TIMEOUT_EXIT_CODE,
  SANDBOX_TMP,
  SANDBOX_USER,
  SANDBOX_WORKSPACE,
  SKILL_ARCHIVE_CACHE_DIR,
  TRUNCATION_MARKER,
  WRITE_FILE_CHUNK_BYTES,
} from './constants';
import {
  DockerEngineClient,
  isDockerUnreachable,
  wrapDockerUnreachable,
} from './dockerEngineClient';
import { buildFileOpCommand } from './fileOps';
import { resolveSandboxPath } from './paths';
import type { LocalSandboxSession } from './sessionContext';
import { getLocalSandboxSession } from './sessionContext';
import {
  getLocalSandboxSupervisor,
  LocalSandboxCapacityError,
  LocalSandboxDiskError,
  LocalSandboxImageError,
  type LocalSandboxSupervisor,
  type SandboxSessionRecord,
} from './supervisor';
import { asWebReadable, createTarFileExtractStream } from './tarArchive';
import { httpWatchdogMs, wrapWithCoreutilsTimeout } from './timeoutWrap';

const log = debug('lobe-server:sandbox:local');

type EngineOptions = LocalSandboxProviderOptions &
  Partial<SandboxSessionContext> & {
    reaperIntervalMs?: number;
  };

const INTERPRETERS: Record<string, { bin: string; flag: string }> = {
  bash: { bin: 'sh', flag: '-c' },
  javascript: { bin: 'node', flag: '-e' },
  js: { bin: 'node', flag: '-e' },
  node: { bin: 'node', flag: '-e' },
  python: { bin: 'python3', flag: '-c' },
  python3: { bin: 'python3', flag: '-c' },
  sh: { bin: 'sh', flag: '-c' },
  shell: { bin: 'sh', flag: '-c' },
  typescript: { bin: 'tsx', flag: '' },
};

export class LocalSandboxProvider implements SandboxProvider {
  readonly capabilities = {
    backgroundCommands: true,
    exportFile: true,
    files: true,
    languages: ['python', 'javascript', 'typescript'],
    persistentSession: true,
    shell: true,
    skillScripts: true,
  } as const satisfies SandboxProviderCapabilities;

  readonly kind = 'local';

  private readonly boundSession?: LocalSandboxSession;
  private readonly client: DockerEngineClient;
  private readonly engine: {
    diskMb: number;
    idleTtlSec: number;
    image: string;
    maxContainers: number;
    maxExportBytes: number;
    maxOutputBytes: number;
    memoryBytes: number;
    nanoCpus: number;
    network: 'bridge' | 'none';
    pidsLimit: number;
    pullOnDemand: boolean;
    pullPolicy: LocalSandboxProviderOptions['pullPolicy'];
    timeoutMs: number;
  };
  private readonly supervisor: LocalSandboxSupervisor;

  constructor(options: EngineOptions) {
    this.engine = {
      diskMb: options.diskMb ?? DEFAULT_DISK_MB,
      idleTtlSec: options.idleTtlSec ?? DEFAULT_IDLE_TTL_SEC,
      image: options.image ?? DEFAULT_SANDBOX_IMAGE,
      maxContainers: options.maxContainers ?? DEFAULT_MAX_CONTAINERS,
      maxExportBytes: options.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      memoryBytes: options.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      nanoCpus: options.nanoCpus ?? DEFAULT_NANO_CPUS,
      network: options.network ?? 'bridge',
      pidsLimit: options.pidsLimit ?? DEFAULT_PIDS_LIMIT,
      pullOnDemand: options.pullOnDemand ?? options.pullPolicy !== 'never',
      pullPolicy: options.pullPolicy ?? 'if-missing',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.client = new DockerEngineClient({ host: options.host, socketPath: options.socketPath });
    this.supervisor = getLocalSandboxSupervisor(this.client, {
      diskMb: this.engine.diskMb,
      idleTtlSec: this.engine.idleTtlSec,
      image: this.engine.image,
      maxContainers: this.engine.maxContainers,
      memoryBytes: this.engine.memoryBytes,
      nanoCpus: this.engine.nanoCpus,
      network: this.engine.network,
      pidsLimit: this.engine.pidsLimit,
      pullOnDemand: this.engine.pullOnDemand,
      pullPolicy: this.engine.pullPolicy,
      reaperIntervalMs: options.reaperIntervalMs,
    });
    if (options.userId && options.topicId) {
      this.boundSession = { topicId: options.topicId, userId: options.userId };
    }
  }

  async callTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<SandboxCallToolResult> {
    try {
      switch (toolName) {
        case 'runCommand': {
          return await this.runCommand(params);
        }
        case 'getCommandOutput': {
          return await this.getCommandOutput(params);
        }
        case 'killCommand': {
          return await this.killCommand(params);
        }
        case 'executeCode': {
          return await this.executeCode(params);
        }
        case 'execScript': {
          return await this.execScript(params);
        }
        case 'listLocalFiles':
        case 'listFiles': {
          return await this.runJsonScript('list', {
            directoryPath: resolveSandboxPath(String(params.directoryPath || '.')),
          });
        }
        case 'readLocalFile':
        case 'readFile': {
          return await this.runJsonScript('read', {
            endLine: params.endLine,
            path: resolveSandboxPath(String(params.path || '')),
            startLine: params.startLine,
          });
        }
        case 'writeLocalFile':
        case 'writeFile': {
          return await this.writeLocalFile(params);
        }
        case 'editLocalFile':
        case 'editFile': {
          return await this.runJsonScript('edit', {
            all: params.all,
            path: resolveSandboxPath(String(params.path || '')),
            replace: params.replace,
            search: params.search,
          });
        }
        case 'searchLocalFiles':
        case 'searchFiles': {
          return await this.runJsonScript('search', {
            ...params,
            directory: resolveSandboxPath(String(params.directory || '.')),
          });
        }
        case 'moveLocalFiles':
        case 'moveFiles': {
          return await this.moveFiles(params);
        }
        case 'grepContent': {
          return await this.runJsonScript('grep', {
            directory: resolveSandboxPath(String(params.directory || '.')),
            filePattern: params.filePattern,
            pattern: params.pattern,
            recursive: params.recursive,
          });
        }
        case 'globLocalFiles':
        case 'globFiles': {
          return await this.runJsonScript('glob', {
            directory: resolveSandboxPath(String(params.directory || '.')),
            pattern: params.pattern,
          });
        }
        case 'deleteLocalFile':
        case 'deleteFile': {
          return await this.runJsonScript('delete', {
            path: resolveSandboxPath(String(params.path || '')),
          });
        }
        default: {
          return this.errorResult(`Unsupported local sandbox tool: ${toolName}`);
        }
      }
    } catch (error) {
      return this.mapError(error);
    }
  }

  async exportFileToUploadUrl({
    path,
    uploadHeaders,
    uploadUrl,
  }: SandboxProviderFileExportRequest): Promise<SandboxProviderFileExportResult> {
    try {
      const jailed = resolveSandboxPath(path);
      const session = this.requireSession();
      return await this.supervisor.withSession(session, async (record) => {
        const stat = await this.execInContainer(
          record,
          session,
          ['python3', '-c', buildFileOpCommand('stat', { path: jailed })],
          this.engine.timeoutMs,
        );
        if (stat.exitCode !== 0) {
          throw new Error(stat.stderr || stat.stdout || 'Failed to stat export file');
        }
        const parsed = JSON.parse(stat.stdout || '{}') as {
          size?: number;
          success?: boolean;
          error?: string;
        };
        if (parsed.success === false) {
          throw new Error(String(parsed.error || 'Failed to stat export file'));
        }
        const size = Number(parsed.size);
        if (!Number.isFinite(size) || size < 0) {
          throw new Error('Failed to stat export file');
        }
        if (size > this.engine.maxExportBytes) {
          throw new LocalSandboxDiskError(
            `Export exceeds SANDBOX_LOCAL_MAX_EXPORT_BYTES (${this.engine.maxExportBytes}): ${size} bytes`,
          );
        }

        if (size === 0) {
          const empty = await fetch(uploadUrl, {
            body: Buffer.alloc(0),
            headers: { ...uploadHeaders, 'Content-Length': '0' },
            method: 'PUT',
          });
          if (!empty.ok) {
            return {
              error: { message: `Failed to upload exported file: HTTP ${empty.status}` },
              success: false,
            };
          }
          return {
            mimeType: guessMimeType(jailed),
            result: { mime_type: guessMimeType(jailed), size_bytes: 0 },
            size: 0,
            success: true,
          };
        }

        const tarStream = await this.client.getArchiveStream(record.containerId, jailed);
        const fileStream = tarStream.pipe(
          createTarFileExtractStream({ basename: jailed.split('/').pop(), expectedSize: size }),
        );
        const response = await fetch(uploadUrl, {
          body: asWebReadable(fileStream),
          duplex: 'half',
          headers: {
            ...uploadHeaders,
            'Content-Length': String(size),
          },
          method: 'PUT',
        } as RequestInit);

        if (!response.ok) {
          return {
            error: { message: `Failed to upload exported file: HTTP ${response.status}` },
            success: false,
          };
        }

        return {
          mimeType: guessMimeType(jailed),
          result: { mime_type: guessMimeType(jailed), size_bytes: size },
          size,
          success: true,
        };
      });
    } catch (error) {
      log('local sandbox export failed: %O', error);
      const mapped = this.mapError(error);
      return {
        error: mapped.error,
        success: false,
      };
    }
  }

  private async executeCode(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
    const code = String(params.code || '');
    const language = String(params.language || 'python');
    const interpreter = INTERPRETERS[language];

    if (!interpreter) {
      return this.errorResult(`Unsupported code language for local sandbox: ${language}`);
    }

    const available = await this.interpreterAvailable(interpreter.bin);
    if (!available) {
      return this.errorResult(`interpreter ${interpreter.bin} not available in sandbox image`);
    }

    const timeoutMs = this.timeout(params);
    let cmd: string[];

    if (language === 'typescript') {
      const filePath = `${SANDBOX_TMP}/lobe-code-${Date.now()}.ts`;
      const write = await this.execCapture(
        ['sh', '-c', `printf '%s' "$1" > "$2"`, 'lobe-write', code, filePath],
        timeoutMs,
      );
      if (write.exitCode !== 0) {
        return this.errorResult(
          write.stderr || write.stdout || 'Failed to write TypeScript source',
        );
      }
      cmd = [interpreter.bin, filePath];
    } else {
      cmd = [interpreter.bin, interpreter.flag, code];
    }

    const result = await this.execCapture(cmd, timeoutMs);
    return {
      result: {
        error: result.exitCode === 0 ? undefined : result.stderr,
        exitCode: result.exitCode,
        output: result.stdout,
        stderr: result.stderr,
      },
      success: true,
    };
  }

  private async runCommand(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
    const command = String(params.command || '');
    if (!command.trim()) return this.errorResult('command is required');

    if (params.background === true) {
      return this.startBackgroundCommand(command, this.timeout(params));
    }

    const result = await this.execCapture(
      ['sh', '-lc', command],
      this.timeout(params),
      SANDBOX_WORKSPACE,
    );
    return {
      result: {
        commandId: result.execId,
        exitCode: result.exitCode,
        output: result.stdout,
        stderr: result.stderr,
        stdout: result.stdout,
        success: result.exitCode === 0,
      },
      success: true,
    };
  }

  private async startBackgroundCommand(
    command: string,
    timeoutMs: number,
  ): Promise<SandboxCallToolResult> {
    const id = `bg-${Date.now().toString(36)}`;
    const stdoutFile = `${SANDBOX_TMP}/lobe-bg-${id}.stdout`;
    const stderrFile = `${SANDBOX_TMP}/lobe-bg-${id}.stderr`;
    const pidFile = `${SANDBOX_TMP}/lobe-bg-${id}.pid`;
    const wrapped = `( ${command} ) >${this.shellQuote(stdoutFile)} 2>${this.shellQuote(stderrFile)} & echo $! >${this.shellQuote(pidFile)}`;
    const result = await this.execCapture(['sh', '-lc', wrapped], timeoutMs, SANDBOX_WORKSPACE);

    if (result.exitCode !== 0) {
      return this.errorResult(
        result.stderr || result.stdout || 'Failed to start background command',
      );
    }

    return {
      result: {
        commandId: id,
        shell_id: id,
      },
      success: true,
    };
  }

  private async getCommandOutput(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
    const commandId = String(params.commandId || '');
    if (!commandId) return this.errorResult('commandId is required');

    const stdoutFile = `${SANDBOX_TMP}/lobe-bg-${commandId}.stdout`;
    const stderrFile = `${SANDBOX_TMP}/lobe-bg-${commandId}.stderr`;
    const pidFile = `${SANDBOX_TMP}/lobe-bg-${commandId}.pid`;
    const script = `pid=$(cat ${this.shellQuote(pidFile)} 2>/dev/null || true); stdout=$(cat ${this.shellQuote(stdoutFile)} 2>/dev/null || true); stderr=$(cat ${this.shellQuote(stderrFile)} 2>/dev/null || true); running=0; if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then running=1; fi; printf '%s' "$running"; printf '\\n--stdout--\\n'; printf '%s' "$stdout"; printf '\\n--stderr--\\n'; printf '%s' "$stderr"`;
    const result = await this.execCapture(['sh', '-lc', script], this.timeout(params));
    const parts = result.stdout.split('\n--stdout--\n');
    const running = parts[0]?.trim() === '1';
    const rest = parts[1] ?? '';
    const [stdout = '', stderr = ''] = rest.split('\n--stderr--\n');

    return {
      result: {
        error: result.exitCode === 0 ? undefined : result.stderr,
        newOutput: stdout,
        output: stdout,
        running,
        stderr,
        success: result.exitCode === 0,
      },
      success: result.exitCode === 0,
    };
  }

  private async killCommand(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
    const commandId = String(params.commandId || '');
    if (!commandId) return this.errorResult('commandId is required');

    const pidFile = `${SANDBOX_TMP}/lobe-bg-${commandId}.pid`;
    const result = await this.execCapture(
      [
        'sh',
        '-lc',
        `pid=$(cat ${this.shellQuote(pidFile)} 2>/dev/null || true); if [ -n "$pid" ]; then kill -9 "$pid" 2>/dev/null || true; fi`,
      ],
      this.timeout(params),
    );

    return {
      result: { success: result.exitCode === 0 },
      success: result.exitCode === 0,
    };
  }

  private async execScript(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
    const command = String(params.command || '');
    if (!command.trim()) return this.errorResult('command is required');

    const skillZipUrls = this.resolveExecScriptZipUrls(params);
    const timeoutMs = this.timeout(params);

    if (Object.keys(skillZipUrls).length === 0) {
      return this.runCommand({ command, timeout: timeoutMs });
    }

    const defaultSkillName = this.resolveExecScriptSkillName(params, skillZipUrls);
    const workspaceDir = this.skillWorkspaceDir(skillZipUrls);
    const setupCommand = this.buildSkillSetupCommand({ skillZipUrls, workspaceDir });
    const setup = await this.execCapture(['sh', '-lc', setupCommand], timeoutMs);

    if (setup.exitCode !== 0) {
      return {
        error: { message: setup.stderr || setup.stdout || 'Failed to prepare skill resources' },
        result: {
          exitCode: setup.exitCode,
          output: setup.stdout,
          stderr: setup.stderr,
        },
        success: false,
      };
    }

    const runDir = defaultSkillName
      ? `${workspaceDir}/${this.safeSkillDirName(defaultSkillName)}`
      : workspaceDir;
    const result = await this.execCapture(
      ['sh', '-lc', `cd ${this.shellQuote(runDir)} && ${command}`],
      timeoutMs,
    );

    return {
      result: {
        commandId: result.execId,
        exitCode: result.exitCode,
        output: result.stdout,
        stderr: result.stderr,
        stdout: result.stdout,
        success: result.exitCode === 0,
      },
      success: true,
    };
  }

  private async writeLocalFile(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
    const path = String(params.path || '');
    if (!path) return this.errorResult('path is required');

    const jailed = resolveSandboxPath(path);
    const timeoutMs = this.timeout(params);
    const init = await this.runJsonScript(
      'prepare_write',
      { createDirectories: params.createDirectories === true, path: jailed },
      timeoutMs,
    );
    if (!init.success) return init;

    const bytes = Buffer.from(String(params.content || ''));
    let bytesWritten = 0;

    for (let offset = 0; offset < bytes.length; offset += WRITE_FILE_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + WRITE_FILE_CHUNK_BYTES).toString('base64');
      const append = await this.runJsonScript('append_chunk', { chunk, path: jailed }, timeoutMs);
      if (!append.success) return append;
      bytesWritten += Number(append.result?.bytesWritten || 0);
    }

    return {
      result: { bytesWritten, success: true },
      success: true,
    };
  }

  private async moveFiles(params: Record<string, unknown>): Promise<SandboxCallToolResult> {
    const operations = Array.isArray(params.operations) ? params.operations : [];
    const jailed = operations.map((operation) => {
      const record = isRecord(operation) ? operation : {};
      return {
        destination: resolveSandboxPath(String(record.destination || '')),
        source: resolveSandboxPath(String(record.source || '')),
      };
    });
    return this.runJsonScript('move', { operations: jailed });
  }

  private async runJsonScript(
    op: string,
    params: Record<string, unknown>,
    timeoutMs = this.engine.timeoutMs,
  ): Promise<SandboxCallToolResult> {
    const result = await this.execCapture(
      ['python3', '-c', buildFileOpCommand(op, params)],
      timeoutMs,
    );

    if (result.exitCode !== 0) {
      return {
        error: { message: result.stderr || result.stdout || 'Local sandbox script failed' },
        result: null,
        success: false,
      };
    }

    try {
      const parsed = JSON.parse(result.stdout || '{}') as Record<string, unknown>;
      if (parsed.success === false) {
        return {
          error: { message: String(parsed.error || 'Local sandbox script failed') },
          result: parsed,
          success: false,
        };
      }
      return { result: parsed, success: true };
    } catch (error) {
      return {
        error: {
          message: `Failed to parse local sandbox script output: ${(error as Error).message}`,
        },
        result: { output: result.stdout, stderr: result.stderr },
        success: false,
      };
    }
  }

  private async interpreterAvailable(bin: string): Promise<boolean> {
    const result = await this.execCapture(
      ['sh', '-c', `command -v ${this.shellQuote(bin)}`],
      15_000,
    );
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  private async execCapture(cmd: string[], timeoutMs: number, workingDir = SANDBOX_WORKSPACE) {
    const session = this.requireSession();
    return this.supervisor.withSession(session, async (record) => {
      return this.execInContainer(record, session, cmd, timeoutMs, workingDir);
    });
  }

  private async execInContainer(
    record: SandboxSessionRecord,
    session: LocalSandboxSession,
    cmd: string[],
    timeoutMs: number,
    workingDir = SANDBOX_WORKSPACE,
  ) {
    const wrapped = wrapWithCoreutilsTimeout(cmd, timeoutMs);
    const created = await this.client.execCreate(record.containerId, {
      AttachStderr: true,
      AttachStdout: true,
      Cmd: wrapped,
      Tty: false,
      User: SANDBOX_USER,
      WorkingDir: workingDir,
    });
    const started = await this.client.execStart(created.Id, {
      maxOutputBytes: this.engine.maxOutputBytes,
      timeoutMs: httpWatchdogMs(timeoutMs),
    });
    const inspect = await this.client.execInspect(created.Id).catch(() => ({
      ExitCode: started.timedOut ? EXEC_TIMEOUT_EXIT_CODE : 1,
      Running: false,
    }));

    const stdout = capOutput(
      started.stdout.toString('utf8'),
      this.engine.maxOutputBytes,
      started.truncated,
    );
    let stderr = capOutput(started.stderr.toString('utf8'), this.engine.maxOutputBytes, false);
    let exitCode = inspect.ExitCode ?? (started.timedOut ? EXEC_TIMEOUT_EXIT_CODE : 1);

    if (started.timedOut) {
      exitCode = EXEC_TIMEOUT_EXIT_CODE;
      stderr = joinStderr(stderr, `command timed out after ${timeoutMs}ms`);
      await this.supervisor.invalidate(session);
    } else if (exitCode === EXEC_TIMEOUT_EXIT_CODE) {
      stderr = joinStderr(stderr, `command timed out after ${timeoutMs}ms`);
    }

    return { execId: created.Id, exitCode, stderr, stdout };
  }

  private requireSession(): LocalSandboxSession {
    const fromStore = getLocalSandboxSession();
    if (fromStore?.userId && fromStore.topicId) return fromStore;
    if (this.boundSession) return this.boundSession;
    throw new Error('sandbox session context is required (userId, topicId)');
  }

  private timeout(params: Record<string, unknown>) {
    const max = this.engine.timeoutMs;
    const value = params.timeout ?? params.timeout_ms;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.min(value, max);
    }
    return max;
  }

  private mapError(error: unknown): SandboxCallToolResult {
    if (
      error instanceof LocalSandboxCapacityError ||
      error instanceof LocalSandboxImageError ||
      error instanceof LocalSandboxDiskError
    ) {
      return this.errorResult(error.message, error.name);
    }
    if (isDiskQuota(error)) {
      return this.errorResult('Sandbox disk quota exceeded', 'LocalSandboxDiskError');
    }
    if (isPathEscape(error)) {
      return this.errorResult((error as Error).message);
    }
    if (isDockerUnreachable(error)) {
      return this.errorResult(wrapDockerUnreachable(error).message);
    }
    log('local sandbox tool failed: %O', error);
    return this.errorResult((error as Error).message, (error as Error).name);
  }

  private errorResult(message: string, name?: string): SandboxCallToolResult {
    return {
      error: { message, name },
      result: null,
      success: false,
    };
  }

  private resolveExecScriptZipUrls(params: Record<string, unknown>) {
    const zipUrl = typeof params.zipUrl === 'string' ? params.zipUrl : undefined;
    if (zipUrl) return { [this.resolveLegacyExecScriptSkillName(params)]: zipUrl };
    if (!isRecord(params.skillZipUrls)) return {};

    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(params.skillZipUrls)) {
      if (typeof value === 'string' && value) result[name] = value;
    }
    return result;
  }

  private resolveLegacyExecScriptSkillName(params: Record<string, unknown>) {
    const configName = isRecord(params.config) ? params.config.name : undefined;
    if (typeof configName === 'string' && configName) return configName;
    if (Array.isArray(params.activatedSkills)) {
      for (const skill of [...params.activatedSkills].reverse()) {
        if (!isRecord(skill)) continue;
        const name = typeof skill.name === 'string' ? skill.name : undefined;
        if (name) return name;
      }
    }
    return 'default';
  }

  private resolveExecScriptSkillName(
    params: Record<string, unknown>,
    skillZipUrls: Record<string, string>,
  ) {
    const configName = isRecord(params.config) ? params.config.name : undefined;
    if (typeof configName === 'string' && skillZipUrls[configName]) return configName;
    if (Array.isArray(params.activatedSkills)) {
      for (const skill of [...params.activatedSkills].reverse()) {
        if (!isRecord(skill)) continue;
        const name = typeof skill.name === 'string' ? skill.name : undefined;
        if (name && skillZipUrls[name]) return name;
      }
    }
    const [firstName] = Object.keys(skillZipUrls);
    return firstName;
  }

  private skillWorkspaceDir(skillZipUrls: Record<string, string>) {
    const entries = Object.entries(skillZipUrls).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const cacheKey = sha256(JSON.stringify(entries)).slice(0, 32);
    return `${SKILL_ARCHIVE_CACHE_DIR}/${cacheKey || 'default'}`;
  }

  private buildSkillSetupCommand({
    skillZipUrls,
    workspaceDir,
  }: {
    skillZipUrls: Record<string, string>;
    workspaceDir: string;
  }) {
    const quotedWorkspaceDir = this.shellQuote(workspaceDir);
    const setupCommands = Object.entries(skillZipUrls).map(([name, zipUrl]) => {
      const skillDir = `${workspaceDir}/${this.safeSkillDirName(name)}`;
      const markerPath = `${skillDir}/.prepared`;
      const archivePath = `${skillDir}/skill.zip`;
      return `if [ ! -f ${this.shellQuote(markerPath)} ]; then rm -rf ${this.shellQuote(skillDir)} && mkdir -p ${this.shellQuote(skillDir)} && curl -fsSL ${this.shellQuote(zipUrl)} -o ${this.shellQuote(archivePath)} && unzip -q ${this.shellQuote(archivePath)} -d ${this.shellQuote(skillDir)} && printf prepared > ${this.shellQuote(markerPath)}; fi`;
    });
    return [
      `mkdir -p ${this.shellQuote(SKILL_ARCHIVE_CACHE_DIR)}`,
      `mkdir -p ${quotedWorkspaceDir}`,
      ...setupCommands,
    ].join(' && ');
  }

  private safeSkillDirName(name: string) {
    return name.replaceAll(/[^\w.-]/g, '-');
  }

  private shellQuote(value: string) {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
  }
}

const capOutput = (value: string, limit: number, alreadyTruncated: boolean) => {
  if (!alreadyTruncated && Buffer.byteLength(value, 'utf8') <= limit) return value;
  const sliced = Buffer.from(value).subarray(0, limit).toString('utf8');
  return sliced + TRUNCATION_MARKER.replace('{limit}', String(limit));
};

const joinStderr = (stderr: string, extra: string) => (stderr ? `${stderr}\n${extra}` : extra);

const isPathEscape = (error: unknown) =>
  error instanceof Error && error.message.includes('path escapes sandbox workspace');

const isDiskQuota = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  return /ENOSPC|no space left|disk quota/i.test(error.message);
};

const guessMimeType = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'csv': {
      return 'text/csv';
    }
    case 'html': {
      return 'text/html';
    }
    case 'json': {
      return 'application/json';
    }
    case 'md': {
      return 'text/markdown';
    }
    case 'png': {
      return 'image/png';
    }
    case 'txt': {
      return 'text/plain';
    }
    default: {
      return 'application/octet-stream';
    }
  }
};
