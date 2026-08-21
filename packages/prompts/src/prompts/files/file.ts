import type { ChatFileItem } from '@lobechat/types';

const FILES_DOCSTRING = 'here are user upload files you can refer to';

const SANDBOX_FILES_DOCSTRING =
  'here are user upload files you can refer to. Files with a sandboxPath attribute are available in the sandbox and can be read with sandbox tools (e.g. readFile).';

const filePrompt = (item: ChatFileItem, addUrl: boolean) => {
  const content = item.content || '';
  // Sandbox-synced files advertise the in-sandbox path so the model can read
  // them with tools. Never include the internal http URL alongside it.
  if (item.sandboxPath) {
    return `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}" sandboxPath="${item.sandboxPath}">${content}</file>`;
  }
  return addUrl
    ? `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}" url="${item.url}">${content}</file>`
    : `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}">${content}</file>`;
};

export const filePrompts = (fileList: ChatFileItem[], addUrl: boolean) => {
  if (fileList.length === 0) return '';

  const hasSandboxPath = fileList.some((item) => Boolean(item.sandboxPath));
  const docstring = hasSandboxPath ? SANDBOX_FILES_DOCSTRING : FILES_DOCSTRING;

  const prompt = `<files>
<files_docstring>${docstring}</files_docstring>
${fileList.map((item) => filePrompt(item, addUrl)).join('\n')}
</files>`;

  return prompt.trim();
};
