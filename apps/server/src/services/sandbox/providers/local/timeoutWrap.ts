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

/** HTTP stream watchdog sits after the in-container TERM + SIGKILL grace. */
export const httpWatchdogMs = (timeoutMs: number) =>
  timeoutMs + TIMEOUT_KILL_AFTER_SEC * 1000 + 1000;
