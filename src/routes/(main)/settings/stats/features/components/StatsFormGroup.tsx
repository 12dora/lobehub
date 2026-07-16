'use client';

/**
 * Compatibility adapter — implementation lives in shared `@/components/SectionGroup`.
 * Settings callers keep this path; Admin and new code import SectionGroup directly.
 */
export type { SectionGroupProps as StatsFormGroupProps } from '@/components/SectionGroup';
export { default } from '@/components/SectionGroup';
