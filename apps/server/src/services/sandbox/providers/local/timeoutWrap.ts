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
 * Foreground exec wrap: a supervising `sh` records its pid (the docker-exec
 * process-group leader), runs GNU `timeout` without `exec`, then removes the
 * pid file and exits with timeout's status (including 124/137/143).
 *
 * `kill -- -<pid>` hits the whole group (timeout + command). Interrupt ignores
 * pid files whose pid is not alive (`kill -0`) so leftovers are not counted.
 */
export const wrapForegroundExec = (
  cmd: string[],
  timeoutMs: number,
  markerId: string,
): string[] => {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const pidFile = foregroundPidFile(markerId);
  // Supervising shell stays alive so EXIT-equivalent cleanup runs (`rm -f` after
  // timeout). Do not `exec` into timeout — that skipped the trap and leaked pid
  // files. This shell is the docker-exec process-group leader (`echo $$`), so
  // `kill -- -$pid` still reaches timeout and the command. `rc` propagates
  // timeout's 124/137/143.
  const script = `echo $$ > ${pidFile}; timeout -k ${TIMEOUT_KILL_AFTER_SEC} ${seconds} sh -c 'exec "$0" "$@"' "$@"; rc=$?; rm -f ${pidFile}; exit $rc`;
  return ['sh', '-c', script, '--', ...cmd];
};

export const foregroundPidFile = (markerId: string): string =>
  `/tmp/lobe-fg-${sanitizeMarkerId(markerId)}.pid`;

export const FOREGROUND_PID_GLOB = '/tmp/lobe-fg-*.pid';

/**
 * dash's `kill` cannot address a process group (`kill -- -$pid` →
 * "Illegal number: -"). python3 is in the sandbox image and `os.killpg`
 * matches `kill -- -$pid` semantics.
 */
export const KILL_PROCESS_GROUP_HELPERS = [
  'lobe_killpg() {',
  '  python3 - "$1" "$2" <<\'PY\'',
  'import os, sys',
  'p, s = int(sys.argv[1]), int(sys.argv[2])',
  'try:',
  '    os.killpg(p, s)',
  'except OSError:',
  '    try:',
  '        os.kill(p, s)',
  '    except OSError:',
  '        pass',
  'PY',
  '}',
  'lobe_alivepg() {',
  '  python3 - "$1" <<\'PY\'',
  'import glob, sys',
  'p = int(sys.argv[1])',
  'live = False',
  "for path in glob.glob('/proc/[0-9]*/stat'):",
  '    try:',
  '        st = open(path).read()',
  '    except OSError:',
  '        continue',
  "    rp = st.rfind(')')",
  '    if rp < 0:',
  '        continue',
  '    rest = st[rp + 2 :].split()',
  '    if len(rest) < 3:',
  '        continue',
  "    if rest[0] != 'Z' and int(rest[2]) == p:",
  '        live = True',
  '        break',
  'raise SystemExit(0 if live else 1)',
  'PY',
  '}',
].join('\n');

/**
 * In-container interrupt of foreground execs only. Does **not** touch
 * `/tmp/lobe-bg-*.pid` — those jobs are explicitly detached.
 */
export const buildForegroundInterruptScript = (): string =>
  [
    KILL_PROCESS_GROUP_HELPERS,
    'killed=0',
    `for f in ${FOREGROUND_PID_GLOB}; do`,
    '  [ -f "$f" ] || continue',
    '  pid=$(cat "$f" 2>/dev/null) || true',
    '  case "$pid" in \'\'|*[!0-9]*) rm -f "$f"; continue ;; esac',
    '  kill -0 "$pid" 2>/dev/null || { rm -f "$f"; continue; }',
    '  lobe_killpg "$pid" 15',
    '  n=0',
    '  while [ "$n" -lt 20 ]; do',
    '    kill -0 "$pid" 2>/dev/null || break',
    '    sleep 0.1',
    '    n=$((n + 1))',
    '  done',
    '  lobe_killpg "$pid" 9',
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
