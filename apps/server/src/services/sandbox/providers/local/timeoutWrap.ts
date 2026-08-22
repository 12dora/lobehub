/**
 * GNU coreutils `timeout` lives in the debian sandbox image and runs as uid
 * 1000, so SIGTERM/SIGKILL land in the container PID namespace (not the host
 * PID that ExecInspect.Pid reports). `-k 5` SIGKILLs the process group 5s
 * after the first TERM.
 *
 * `sh -c 'exec "$0" "$@"' -- cmd...` preserves the original argv without
 * extra shell quoting.
 */
export const TIMEOUT_KILL_AFTER_SEC = 5;

export const wrapWithCoreutilsTimeout = (cmd: string[], timeoutMs: number): string[] => {
  if (cmd[0] === 'timeout') return cmd;
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    'timeout',
    '-k',
    String(TIMEOUT_KILL_AFTER_SEC),
    String(seconds),
    'sh',
    '-c',
    'exec "$0" "$@"',
    ...cmd,
  ];
};

/**
 * Foreground exec wrap: record the process-group leader pid, then `exec` into
 * GNU `timeout` (same argv-preserving inner `sh` as {@link wrapWithCoreutilsTimeout}).
 *
 * `echo $$` runs in the wrapping `sh`; `exec timeout` replaces that shell so
 * the pid file holds timeout's pid — the group leader docker exec started.
 * `kill -- -<pid>` then hits the whole group; interrupt falls back to
 * `kill <pid>` when the pid is not a group leader.
 *
 * The EXIT trap is best-effort: `exec` replaces the shell so the trap only
 * fires if `exec` itself fails. Interrupt deletes leftover pid files; a
 * completed exec's stale pid is harmless (`kill` of a dead pid is ignored).
 */
export const wrapForegroundExec = (
  cmd: string[],
  timeoutMs: number,
  markerId: string,
): string[] => {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const pidFile = foregroundPidFile(markerId);
  const script = `echo $$ > ${pidFile}; trap 'rm -f ${pidFile}' EXIT; exec timeout -k ${TIMEOUT_KILL_AFTER_SEC} ${seconds} sh -c 'exec "$0" "$@"' "$@"`;
  return ['sh', '-c', script, '--', ...cmd];
};

export const foregroundPidFile = (markerId: string): string =>
  `/tmp/lobe-fg-${sanitizeMarkerId(markerId)}.pid`;

export const FOREGROUND_PID_GLOB = '/tmp/lobe-fg-*.pid';

/**
 * In-container interrupt of foreground execs only. Does **not** touch
 * `/tmp/lobe-bg-*.pid` — those jobs are explicitly detached.
 */
export const buildForegroundInterruptScript = (): string =>
  [
    'killed=0',
    `for f in ${FOREGROUND_PID_GLOB}; do`,
    '  [ -f "$f" ] || continue',
    '  pid=$(cat "$f" 2>/dev/null) || true',
    '  case "$pid" in \'\'|*[!0-9]*) continue ;; esac',
    '  kill -TERM -- -$pid 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    '  n=0',
    '  while [ "$n" -lt 20 ]; do',
    '    kill -0 "$pid" 2>/dev/null || break',
    '    sleep 0.1',
    '    n=$((n + 1))',
    '  done',
    '  kill -KILL -- -$pid 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
    '  rm -f "$f"',
    '  killed=$((killed + 1))',
    'done',
    'printf \'%s\\n\' "$killed"',
  ].join('\n');

const sanitizeMarkerId = (markerId: string): string => {
  const safe = markerId.replaceAll(/[^\w-]/g, '');
  return safe || 'x';
};

/** HTTP stream watchdog sits after the in-container TERM + SIGKILL grace. */
export const httpWatchdogMs = (timeoutMs: number) =>
  timeoutMs + TIMEOUT_KILL_AFTER_SEC * 1000 + 1000;
