import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLevelSliderComponent } from '../createLevelSlider';

// The repo's test i18n instance carries no `setting` resources, so drive the label
// lookup from an explicit dictionary instead of the harness locale state.
const i18nMocks = vi.hoisted(() => ({ resources: {} as Record<string, string> }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      i18nMocks.resources[key] ?? options?.defaultValue ?? key,
  }),
}));

// Mock the store hooks - they should NOT be called in controlled mode
vi.mock('@/store/agent', () => ({
  useAgentStore: vi.fn(() => {
    throw new Error('useAgentStore should not be called in controlled mode');
  }),
}));

vi.mock('../../../hooks/useAgentId', () => ({
  useAgentId: vi.fn(() => {
    throw new Error('useAgentId should not be called in controlled mode');
  }),
}));

vi.mock('../../../hooks/useUpdateAgentConfig', () => ({
  useUpdateAgentConfig: vi.fn(() => {
    throw new Error('useUpdateAgentConfig should not be called in controlled mode');
  }),
}));

const TEST_LEVELS = ['low', 'medium', 'high'] as const;
type TestLevel = (typeof TEST_LEVELS)[number];

const levelLabelKey = (level: string) => `serviceModel.reasoningEffort.options.${level}`;

describe('createLevelSliderComponent', () => {
  describe('controlled mode (with value prop)', () => {
    it('should NOT call store hooks when value prop is provided', () => {
      const TestSlider = createLevelSliderComponent<TestLevel>({
        configKey: 'reasoningEffort',
        defaultValue: 'medium',
        levels: TEST_LEVELS,
      });

      // This should NOT throw - if it throws, it means store hooks were called
      expect(() => {
        render(<TestSlider value="high" />);
      }).not.toThrow();
    });

    it('should NOT call store hooks when onChange prop is provided', () => {
      const TestSlider = createLevelSliderComponent<TestLevel>({
        configKey: 'reasoningEffort',
        defaultValue: 'medium',
        levels: TEST_LEVELS,
      });

      const mockOnChange = vi.fn();

      // This should NOT throw - if it throws, it means store hooks were called
      expect(() => {
        render(<TestSlider onChange={mockOnChange} />);
      }).not.toThrow();
    });

    it('should render with the controlled value', () => {
      const TestSlider = createLevelSliderComponent<TestLevel>({
        configKey: 'reasoningEffort',
        defaultValue: 'medium',
        levels: TEST_LEVELS,
      });

      render(<TestSlider value="high" />);

      // The slider should show the marks
      expect(screen.getByText('low')).toBeInTheDocument();
      expect(screen.getByText('medium')).toBeInTheDocument();
      expect(screen.getByText('high')).toBeInTheDocument();
    });

    it('should use defaultValue when value is not provided but onChange is', () => {
      const TestSlider = createLevelSliderComponent<TestLevel>({
        configKey: 'reasoningEffort',
        defaultValue: 'medium',
        levels: TEST_LEVELS,
      });

      const mockOnChange = vi.fn();

      // Should not throw and should render
      expect(() => {
        render(<TestSlider onChange={mockOnChange} />);
      }).not.toThrow();
    });
  });

  describe('level labels', () => {
    afterEach(() => {
      i18nMocks.resources = {};
    });

    it('names each level with the shared thinking-effort copy', () => {
      i18nMocks.resources = {
        [levelLabelKey('high')]: '高',
        [levelLabelKey('low')]: '低',
        [levelLabelKey('medium')]: '中',
      };

      const TestSlider = createLevelSliderComponent<TestLevel>({
        configKey: 'reasoningEffort',
        defaultValue: 'medium',
        levels: TEST_LEVELS,
      });

      render(<TestSlider value="high" />);

      expect(screen.getByText('低')).toBeInTheDocument();
      expect(screen.getByText('中')).toBeInTheDocument();
      expect(screen.getByText('高')).toBeInTheDocument();
      expect(screen.queryByText('low')).toBeNull();
    });

    it('falls back to the raw level for values outside the effort vocabulary', () => {
      const TestSlider = createLevelSliderComponent<'1K' | '2K' | '4K'>({
        configKey: 'reasoningEffort',
        defaultValue: '2K',
        levels: ['1K', '2K', '4K'],
      });

      render(<TestSlider value="2K" />);

      expect(screen.getByText('1K')).toBeInTheDocument();
      expect(screen.getByText('4K')).toBeInTheDocument();
    });
  });

  describe('factory configuration', () => {
    it('should create slider with custom marks', () => {
      const customMarks = {
        0: 'OFF',
        1: 'Auto',
        2: 'ON',
      };

      const TestSlider = createLevelSliderComponent<TestLevel>({
        configKey: 'thinking',
        defaultValue: 'medium',
        levels: TEST_LEVELS,
        marks: customMarks,
      });

      render(<TestSlider value="medium" />);

      expect(screen.getByText('OFF')).toBeInTheDocument();
      expect(screen.getByText('Auto')).toBeInTheDocument();
      expect(screen.getByText('ON')).toBeInTheDocument();
    });

    it('should apply custom style', () => {
      const TestSlider = createLevelSliderComponent<TestLevel>({
        configKey: 'reasoningEffort',
        defaultValue: 'medium',
        levels: TEST_LEVELS,
        style: { minWidth: 300 },
      });

      const { container } = render(<TestSlider value="medium" />);

      // The outer Flexbox should have the custom style merged
      const flexbox = container.firstChild as HTMLElement;
      expect(flexbox).toHaveStyle({ minWidth: '300px' });
    });
  });
});
