import { describe, expect, it } from 'vitest';

import {
  buildForegroundInterruptScript,
  FOREGROUND_PID_GLOB,
  foregroundPidFile,
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

  it('wraps a foreground command so the pid file and timeout share the group leader', () => {
    expect(wrapForegroundExec(['python3', '-c', 'print(1)'], 120_000, 'abc')).toEqual([
      'sh',
      '-c',
      'echo $$ > /tmp/lobe-fg-abc.pid; trap \'rm -f /tmp/lobe-fg-abc.pid\' EXIT; exec timeout -k 5 120 sh -c \'exec "$0" "$@"\' "$@"',
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
    expect(script).toContain('kill -TERM -- -$pid');
    expect(script).toContain('kill -TERM "$pid"');
    expect(script).toContain('kill -KILL -- -$pid');
    expect(script).not.toContain('lobe-bg-');
  });
});
