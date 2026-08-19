import type { ChatCompletionTool, OpenAIChatMessage } from '../../types/chat';
import type { MessageToolCall } from '../../types/toolsCalling';

/** Keep in sync with the stream scanner in `core/streams/cursor.ts`. */
export const CURSOR_TOOL_CALLS_OPEN = '<aihub:tool_calls>';
export const CURSOR_TOOL_CALLS_CLOSE = '</aihub:tool_calls>';

const TOOL_RESULT_OPEN = '<aihub:tool_result';
const TOOL_RESULT_CLOSE = '</aihub:tool_result>';

export const hasCursorTools = (
  tools: ChatCompletionTool[] | undefined,
): tools is ChatCompletionTool[] => Array.isArray(tools) && tools.length > 0;

/** Advertise and parse the prompt-protocol only when tools exist and are allowed. */
export const isCursorToolsActive = (
  tools: ChatCompletionTool[] | undefined,
  toolChoice?: string,
): tools is ChatCompletionTool[] => hasCursorTools(tools) && toolChoice !== 'none';

const parseArguments = (raw: string | undefined): unknown => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

export const serializeCursorToolCalls = (calls: MessageToolCall[]): string => {
  const items = calls.map((call) => ({
    name: call.function?.name || 'tool',
    arguments: parseArguments(call.function?.arguments),
  }));
  return `${CURSOR_TOOL_CALLS_OPEN}\n${JSON.stringify(items)}\n${CURSOR_TOOL_CALLS_CLOSE}`;
};

export const serializeCursorToolResult = (message: OpenAIChatMessage, text: string): string => {
  const attrs: string[] = [];
  if (message.name) attrs.push(`name="${message.name}"`);
  if (message.tool_call_id) attrs.push(`id="${message.tool_call_id}"`);
  const open =
    attrs.length > 0 ? `${TOOL_RESULT_OPEN} ${attrs.join(' ')}>` : `${TOOL_RESULT_OPEN}>`;
  return `${open}${text}${TOOL_RESULT_CLOSE}`;
};

export const buildCursorToolProtocol = (
  tools: ChatCompletionTool[],
  toolChoice?: string,
): string => {
  const catalog = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    parameters: tool.function.parameters ?? { type: 'object', properties: {} },
  }));

  const lines = [
    'You can call tools. Tools (JSON):',
    JSON.stringify(catalog),
    'To call one or more tools, output ONLY this block as the LAST thing in your reply, with nothing after it:',
    CURSOR_TOOL_CALLS_OPEN,
    '[{"name":"<tool name>","arguments":{}}]',
    CURSOR_TOOL_CALLS_CLOSE,
    '"arguments" must be a JSON object matching that tool\'s parameters schema. To answer the user normally, never emit the marker.',
  ];

  if (toolChoice && toolChoice !== 'auto') {
    if (toolChoice === 'required') {
      lines.push('You MUST call at least one tool.');
    } else {
      lines.push(`You MUST call the tool named "${toolChoice}".`);
    }
  }

  return lines.join('\n');
};
