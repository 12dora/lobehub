import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number;
  stderr: string;
  stdout: string;
}

export const runProcess = (argv: string[], cwd: string): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (!command) {
      reject(new Error('Gate command is empty'));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code: code ?? 2,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
