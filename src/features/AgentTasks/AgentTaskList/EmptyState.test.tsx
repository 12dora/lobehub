/**
 * @vitest-environment happy-dom
 */
import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EmptyState from './EmptyState';

const refreshMock = vi.hoisted(() => vi.fn());
const templatesStateMock = vi.hoisted(() => ({ state: {} }) as { state: Record<string, unknown> });

/** The app mounts MotionProvider globally; base-ui primitives require it. */
const renderEmptyState = () =>
  render(
    <MotionProvider motion={motion}>
      <EmptyState />
    </MotionProvider>,
  );

vi.mock('./CreateTaskInlineEntry', () => ({
  default: () => <div data-testid="create-task-entry" />,
}));

vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/features/RecommendTaskTemplates/TaskTemplateCard', () => ({
  TaskTemplateCard: () => <div data-testid="task-template-card" />,
}));

vi.mock('@/features/RecommendTaskTemplates/TaskTemplateCardSkeleton', () => ({
  TaskTemplateCardSkeleton: () => <div data-testid="task-template-skeleton" />,
}));

vi.mock('@/features/RecommendTaskTemplates/useDailyBriefRecommendationsUI', () => ({
  useDailyBriefRecommendationsUI: () => templatesStateMock.state,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('AgentTasks EmptyState', () => {
  beforeEach(() => {
    refreshMock.mockReset();
    templatesStateMock.state = {
      mode: 'cards',
      onRefresh: refreshMock,
      templates: [{ id: 'tmpl-1' }],
    };
  });

  it('exposes the template refresh action as a real button', () => {
    renderEmptyState();

    const button = screen.getByRole('button', { name: 'taskTemplate.action.refresh.button' });

    fireEvent.click(button);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('hides the refresh action when templates are still loading', () => {
    templatesStateMock.state = { mode: 'skeleton', skeletonCount: 2 };

    renderEmptyState();

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getAllByTestId('task-template-skeleton')).toHaveLength(2);
  });
});
