import { createStaticStyles } from 'antd-style';

/**
 * Accessibility-only presentation rules.
 *
 * `srOnly` keeps content in the accessibility tree while removing it from the page: the
 * standard remedy for copy that is otherwise reachable by hover alone (a tooltip). It is NOT
 * `display: none` / `visibility: hidden` — both drop the node from the accessibility tree too,
 * which is the opposite of the point.
 *
 * Shared because the rule is a fixed recipe with no room for variation, and three call sites
 * had already copy-pasted it verbatim; a drifting copy would silently stop hiding, or stop
 * being announced.
 */
export const a11yStyles = createStaticStyles(({ css }) => ({
  srOnly: css`
    position: absolute;

    overflow: hidden;

    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border-width: 0;

    white-space: nowrap;

    clip: rect(0, 0, 0, 0);
  `,
}));
