/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../../../../locales/en-US/setting.json';
import zh from '../../../../../../../locales/zh-CN/setting.json';
import { ConnectorToolErrorResponse } from './ErrorResponse';

const translate = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ title }: { title?: ReactNode }) => <div role="alert">{title}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Highlighter: ({ children }: { children?: ReactNode }) => <pre>{children}</pre>,
}));

describe('ConnectorToolErrorResponse', () => {
  beforeEach(() => {
    translate.mockReset();
  });

  it.each([
    ['en-US', en, 'This Connector is not published'],
    ['zh-CN', zh, '此 Connector 尚未发布'],
  ])('renders the managed runtime code as localized %s tool-card copy', (_, locale, copy) => {
    translate.mockImplementation((key: keyof typeof locale) => locale[key]);

    render(
      <ConnectorToolErrorResponse
        error={{ code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED', message: '' }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(copy);
    expect(screen.getByRole('alert')).not.toHaveTextContent('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  });
});
