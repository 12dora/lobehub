import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SectionGroup from './index';

describe('SectionGroup', () => {
  it('renders title, extra, and children', () => {
    render(
      <SectionGroup extra={<button type="button">More</button>} title="Usage">
        <div>body content</div>
      </SectionGroup>,
    );

    expect(screen.getByText('Usage')).toBeTruthy();
    expect(screen.getByText('body content')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
  });
});
