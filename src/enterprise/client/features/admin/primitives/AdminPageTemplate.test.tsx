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

/**
 * The header element carries its own bottom margin on top of the body's 16px gap, so an empty
 * one is a visible blank band. Embedded tab sub-pages (settings policy / managed resources)
 * hide the title and supply no description, notice or actions — they must get no header box.
 */
describe('AdminPageTemplate header', () => {
  const renderBody = (ui: React.ReactElement) => {
    const { container } = render(ui);
    return container.firstElementChild as HTMLElement;
  };

  const roles = (body: HTMLElement) =>
    [...body.children].map((node) => {
      if (node.tagName === 'HR') return 'divider';
      if (node.querySelector('[data-testid="toolbar"]')) return 'toolbar';
      if (node.matches('[data-testid="children"]')) return 'children';
      return 'header';
    });

  it('renders no header box for an embedded sub-page with nothing to show', () => {
    const body = renderBody(
      <AdminPageTemplate hideTitle title="Title" toolbar={<div data-testid="toolbar" />}>
        <div data-testid="children" />
      </AdminPageTemplate>,
    );

    expect(roles(body)).toEqual(['toolbar', 'children']);
  });

  it('keeps the header for an embedded sub-page that still has a notice or actions', () => {
    const withNotice = renderBody(
      <AdminPageTemplate hideTitle notice={<span>read only</span>} title="Title">
        <div data-testid="children" />
      </AdminPageTemplate>,
    );
    expect(roles(withNotice)).toEqual(['header', 'children']);

    const withActions = renderBody(
      <AdminPageTemplate hideTitle actions={<button type="button">Save</button>} title="Title">
        <div data-testid="children" />
      </AdminPageTemplate>,
    );
    expect(roles(withActions)).toEqual(['header', 'children']);
  });

  it('always renders the header while the page title is shown', () => {
    const body = renderBody(
      <AdminPageTemplate title="Title">
        <div data-testid="children" />
      </AdminPageTemplate>,
    );

    expect(roles(body)).toEqual(['header', 'divider', 'children']);
    expect(body.querySelector('h1')?.textContent).toBe('Title');
  });
});
