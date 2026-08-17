// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AdminPageTemplate from './AdminPageTemplate';

/**
 * The page header owns the single horizontal rule of an admin page:
 * `title (+actions) + description (+notice)` → divider → banner → toolbar → content.
 */
describe('AdminPageTemplate divider', () => {
  const renderTemplate = (ui: React.ReactElement) => {
    const { container } = render(ui);
    // Flexbox body is the single root element rendered by the template.
    const body = container.firstElementChild as HTMLElement;
    return { body, container };
  };

  it('closes the header with the rule, above banner / toolbar / children', () => {
    const { body } = renderTemplate(
      <AdminPageTemplate
        banner={<div data-testid="banner" />}
        description="desc"
        title="Title"
        toolbar={<div data-testid="toolbar" />}
      >
        <div data-testid="children" />
      </AdminPageTemplate>,
    );

    const has = (node: Element, id: string) =>
      node.matches(`[data-testid="${id}"]`) || Boolean(node.querySelector(`[data-testid="${id}"]`));

    const order = [...body.children].map((node) => {
      if (node.tagName === 'HR') return 'divider';
      if (has(node, 'banner')) return 'banner';
      if (has(node, 'toolbar')) return 'toolbar';
      if (has(node, 'children')) return 'children';
      return 'header';
    });

    expect(order).toEqual(['header', 'divider', 'banner', 'toolbar', 'children']);
  });

  it('renders exactly one rule and no border on the toolbar wrapper', () => {
    const { body } = renderTemplate(
      <AdminPageTemplate description="desc" title="Title" toolbar={<div data-testid="toolbar" />}>
        <div />
      </AdminPageTemplate>,
    );

    expect(body.querySelectorAll('hr')).toHaveLength(1);
  });

  it('draws no second rule for an embedded sub-page (the outer page header already has one)', () => {
    const { body } = renderTemplate(
      <AdminPageTemplate hideTitle description="desc" title="Title">
        <div />
      </AdminPageTemplate>,
    );

    expect(body.querySelector('h1')).toBeNull();
    expect(body.querySelectorAll('hr')).toHaveLength(0);
  });

  it('drops the rule when there is no header at all', () => {
    const { body } = renderTemplate(
      <AdminPageTemplate hideTitle title="Title">
        <div />
      </AdminPageTemplate>,
    );

    expect(body.querySelectorAll('hr')).toHaveLength(0);
  });

  it('honours the explicit divider escape hatch in both directions', () => {
    const off = renderTemplate(
      <AdminPageTemplate description="desc" divider={false} title="Title">
        <div />
      </AdminPageTemplate>,
    );
    expect(off.body.querySelectorAll('hr')).toHaveLength(0);

    const on = renderTemplate(
      <AdminPageTemplate divider hideTitle title="Title">
        <div />
      </AdminPageTemplate>,
    );
    expect(on.body.querySelectorAll('hr')).toHaveLength(1);
  });
});
