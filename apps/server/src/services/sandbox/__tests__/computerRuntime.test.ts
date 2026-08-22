import { CloudSandboxExecutionRuntime } from '@lobechat/builtin-tool-cloud-sandbox';
import type { ServiceResult } from '@lobechat/tool-runtime';
import { ComputerRuntime } from '@lobechat/tool-runtime';
import { describe, expect, it } from 'vitest';

class TestComputerRuntime extends ComputerRuntime {
  constructor(private readonly serviceResult: ServiceResult) {
    super();
  }

  protected async callService(): Promise<ServiceResult> {
    return this.serviceResult;
  }
}

describe('ComputerRuntime command status mapping', () => {
  it('uses command result success when command transport succeeds with non-zero exit code', async () => {
    const runtime = new TestComputerRuntime({
      result: {
        exitCode: 2,
        stderr: 'failed',
        stdout: 'partial',
        success: false,
      },
      success: true,
    });

    const result = await runtime.runCommand({ command: 'exit 2' });

    expect(result).toMatchObject({
      state: {
        exitCode: 2,
        stderr: 'failed',
        stdout: 'partial',
        success: false,
      },
      success: true,
    });
  });

  it('keeps interrupted execs as a transported result with partial output', async () => {
    const runtime = new TestComputerRuntime({
      result: {
        exitCode: 143,
        interrupted: true,
        stderr: 'command interrupted by user',
        stdout: 'partial-out',
        success: false,
      },
      success: true,
    });

    const result = await runtime.runCommand({ command: 'sleep 60' });

    expect(result).toMatchObject({
      state: {
        exitCode: 143,
        interrupted: true,
        stderr: 'command interrupted by user',
        stdout: 'partial-out',
        success: false,
      },
      success: true,
    });
    expect(result.content).toContain('partial-out');
    expect(result.content).not.toContain('Command execution failed');
  });

  it('uses command output result success when background task transport succeeds', async () => {
    const runtime = new TestComputerRuntime({
      result: {
        stdout: 'failed',
        success: false,
      },
      success: true,
    });

    const result = await runtime.getCommandOutput({ commandId: 'task-1' });

    expect(result).toMatchObject({
      state: {
        stdout: 'failed',
        success: false,
      },
      success: true,
    });
  });
});

describe('CloudSandboxExecutionRuntime interrupted executeCode', () => {
  it('keeps partial output and inner success false when the exec is interrupted', async () => {
    const runtime = new CloudSandboxExecutionRuntime({
      callTool: async () => ({
        result: {
          exitCode: 143,
          interrupted: true,
          output: 'partial-out',
          stderr: 'command interrupted by user',
          success: false,
        },
        success: true,
      }),
      exportAndUploadFile: async () => ({ filename: 'x', success: false }),
    });

    const result = await runtime.executeCode({ code: 'print(1)', language: 'python' });

    expect(result).toMatchObject({
      state: {
        exitCode: 143,
        interrupted: true,
        output: 'partial-out',
        stderr: 'command interrupted by user',
        success: false,
      },
      success: true,
    });
    expect(String(result.content)).toContain('partial-out');
    expect(String(result.content)).not.toContain('Command execution failed');
  });
});
