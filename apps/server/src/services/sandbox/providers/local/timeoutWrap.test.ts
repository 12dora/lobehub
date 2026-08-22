import { describe, expect, it } from 'vitest';

import {
  buildForegroundInterruptScript,
  FOREGROUND_PID_GLOB,
  foregroundPidFile,
  KILL_PROCESS_GROUP_HELPERS,
  wrapForegroundExec,
  wrapWithCoreutilsTimeout,
} from './timeoutWrap';

describe('timeoutWrap', () => {
  it('wraps argv with coreutils timeout without extra quoting', () => {
    expect(wrapWithCoreutilsTimeout(['python3', '-c', 'print(1)'], 120_000)).toEqual([
      'timeout',
      '-k',
      '5',
      '120',
      'sh',
      '-c',
      'exec "$0" "$@"',
      'python3',
      '-c',
      'print(1)',
    ]);
  });

  it('wraps a foreground command so the supervising shell records the pid then runs timeout', () => {
    expect(wrapForegroundExec(['python3', '-c', 'print(1)'], 120_000, 'abc')).toEqual([
      'sh',
      '-c',
      'echo $$ > /tmp/lobe-fg-abc.pid; timeout -k 5 120 sh -c \'exec "$0" "$@"\' "$@"; rc=$?; rm -f /tmp/lobe-fg-abc.pid; exit $rc',
      '--',
      'python3',
      '-c',
      'print(1)',
    ]);
  });

  it('ceils sub-second timeouts to at least 1s and sanitizes the marker id', () => {
    const wrapped = wrapForegroundExec(['echo', 'ok'], 500, 'fg/../evil');
    expect(wrapped[2]).toContain('timeout -k 5 1 ');
    expect(wrapped[2]).toContain(foregroundPidFile('fgevil'));
    expect(wrapped.slice(3)).toEqual(['--', 'echo', 'ok']);
  });

  it('builds a kill script that only targets foreground pid files', () => {
    const script = buildForegroundInterruptScript();
    expect(script).toContain(`for f in ${FOREGROUND_PID_GLOB}`);
    expect(script).toContain('kill -0 "$pid"');
    expect(script).toContain('lobe_killpg "$pid" 15');
    expect(script).toContain('lobe_killpg "$pid" 9');
    expect(script).toContain('os.killpg');
    expect(script).not.toContain('lobe-bg-');
    expect(script).toContain('rm -f "$f"; continue');
  });

  it('treats zombie process groups as not running', () => {
    expect(KILL_PROCESS_GROUP_HELPERS).toContain("glob.glob('/proc/[0-9]*/stat')");
    expect(KILL_PROCESS_GROUP_HELPERS).toContain("rest[0] != 'Z'");
    expect(KILL_PROCESS_GROUP_HELPERS).not.toContain('os.killpg(p, 0)');
  });
});
