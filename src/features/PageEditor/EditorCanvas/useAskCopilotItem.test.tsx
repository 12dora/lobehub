import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import commonDefault from '../../../../packages/locales/src/default/common';
import { useAskCopilotItem } from './useAskCopilotItem';

const interpolate = (template: string, options?: Record<string, unknown>) =>
  template.replaceAll(/\{\{(\w+)\}\}/g, (match, name: string) =>
    options && name in options ? String(options[name]) : match,
  );

vi.mock('@lobehub/editor', () => ({ HIDE_TOOLBAR_COMMAND: 'hide-toolbar' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: keyof typeof commonDefault, options?: Record<string, unknown>) =>
      interpolate(commonDefault[key] ?? key, options),
  }),
}));

vi.mock('@/hooks/useDefaultInboxAvatar', () => ({
  useScopedDefaultInboxAvatar: () => 'https://brand.example.com/icon.png',
}));

vi.mock('@/hooks/useDefaultInboxDisplayName', () => ({
  useScopedDefaultInboxDisplayName: () => 'Aurora Assistant',
}));

vi.mock('@/store/file', () => ({
  useFileStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ addChatContextSelection: vi.fn() }),
}));

vi.mock('../RightPanel/OverrideContext', () => ({
  usePageAgentPanelControl: () => ({ toggle: vi.fn() }),
}));

vi.mock('../store', () => ({
  usePageEditorStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ documentId: 'page-1', setRightPanelMode: vi.fn() }),
}));

const editor = { blur: vi.fn(), dispatchCommand: vi.fn(), getSelectionDocument: () => '' };

describe('useAskCopilotItem', () => {
  it('labels the action with the runtime inbox display name', () => {
    const { result } = renderHook(() =>
      useAskCopilotItem(editor as unknown as Parameters<typeof useAskCopilotItem>[0]),
    );

    const item = result.current?.[0] as { children: ReactNode; label: string };

    expect(item.label).toBe('Ask Aurora Assistant');

    render(<>{item.children}</>);

    expect(screen.getByText('Ask Aurora Assistant')).toBeInTheDocument();
  });
});
