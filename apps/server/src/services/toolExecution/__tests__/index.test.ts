// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { ToolExecutionService } from '../index';

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  deviceConfigured: false,
  executeMcpCall: vi.fn(),
}));

vi.mock('@/server/enterprise/services/connectorCatalog/legacyMcpTransport', () => ({
  platformSafeMcpService: { callTool: mocks.callTool },
}));
vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: {
    executeMcpCall: mocks.executeMcpCall,
    get isConfigured() {
      return mocks.deviceConfigured;
    },
  },
}));

describe('ToolExecutionService', () => {
  it('can skip low-level result truncation for AgentRuntime archival', async () => {
    const builtinToolsExecutor = {
      execute: vi.fn().mockResolvedValue({
        content: '0123456789',
        success: true,
      }),
    };
    const service = new ToolExecutionService({
      builtinToolsExecutor: builtinToolsExecutor as any,
      mcpService: {} as any,
    });

    const result = await service.executeTool(
      {
        apiName: 'search',
        arguments: '{}',
        id: 'tool-call-1',
        identifier: 'lobe-web-browsing',
        type: 'builtin',
      },
      {
        skipResultTruncation: true,
        toolManifestMap: {},
        toolResultMaxLength: 5,
      },
    );

    expect(result.content).toBe('0123456789');
  });

  it('keeps existing low-level truncation by default', async () => {
    const builtinToolsExecutor = {
      execute: vi.fn().mockResolvedValue({
        content: '0123456789',
        success: true,
      }),
    };
    const service = new ToolExecutionService({
      builtinToolsExecutor: builtinToolsExecutor as any,
      mcpService: {} as any,
    });

    const result = await service.executeTool(
      {
        apiName: 'search',
        arguments: '{}',
        id: 'tool-call-1',
        identifier: 'lobe-web-browsing',
        type: 'builtin',
      },
      {
        toolManifestMap: {},
        toolResultMaxLength: 5,
      },
    );

    expect(result.content).toContain('01234');
    expect(result.content).toContain('Content truncated');
  });

  it('rejects stdio without an explicit isolated device capability', async () => {
    const service = new ToolExecutionService({
      builtinToolsExecutor: { execute: vi.fn() } as any,
      mcpService: { callTool: vi.fn() } as any,
    });
    const result = await service.executeTool(
      {
        apiName: 'search',
        arguments: '{}',
        id: 'tool-call-stdio',
        identifier: 'local-mcp',
        type: 'mcp',
      },
      {
        toolManifestMap: {
          'local-mcp': {
            mcpParams: { args: [], command: 'dangerous-child', name: 'local', type: 'stdio' },
          } as any,
        },
      },
    );

    expect(result).toMatchObject({
      error: { code: 'MCP_STDIO_DEVICE_REQUIRED' },
      success: false,
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});
