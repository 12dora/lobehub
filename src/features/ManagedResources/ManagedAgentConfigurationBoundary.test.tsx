/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type * as ZodModule from 'zod';

import { ManagedAgentConfigurationBoundary } from './ManagedAgentConfigurationBoundary';

vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof ZodModule>();
  return { ...actual, z: actual.z ?? actual.default };
});

describe('ManagedAgentConfigurationBoundary', () => {
  it('guards Agent Profile and Channel content with the agents capability', () => {
    const Boundary = ({ children, resource }: { children: ReactNode; resource: 'agents' }) => (
      <div data-resource={resource}>{children}</div>
    );
    render(
      <ManagedAgentConfigurationBoundary boundary={Boundary}>
        <div>configuration</div>
      </ManagedAgentConfigurationBoundary>,
    );

    expect(screen.getByText('configuration').parentElement).toHaveAttribute(
      'data-resource',
      'agents',
    );
  });
});
