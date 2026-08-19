import { createStaticStyles, cssVar } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  /** The one scrolling region: only the form fields move, never the footer. */
  body: css`
    overflow-y: auto;
    flex: 1 1 auto;

    min-height: 0;
    padding-block: 16px;
    padding-inline: 16px;
  `,
  error: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorError};
  `,
  /** Label above control — the house pattern for admin modals. */
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  `,
  footer: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
  `,
  footerActions: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
  `,
  /** Pinned below the scroll region: status first, then the actions. Never scrolls out of reach. */
  footerRegion: css`
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  /**
   * base-ui's borderless group header ships 16px between the title and its rule and nothing after
   * it, which reads as a title floating away from its own section. The rhythm here is
   * title → 8px → rule → 16px → first field, for collapsible and plain groups alike.
   */
  group: css`
    & > :first-child {
      padding-block-end: 8px;
    }
  `,
  groupBody: css`
    padding-block-start: 16px;
  `,
  hint: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  /**
   * Avatar, name and identifier are one identity, read left to right. The identifier wraps under
   * them and takes the full width once the row can no longer hold all three.
   */
  identityAvatar: css`
    flex: 0 0 auto;
  `,
  identityKey: css`
    flex: 1 1 240px;
    min-width: 0;
  `,
  /**
   * The name box and the swatch strip are ONE column at every width — the strip is a child of the
   * name's own column, so it can never be reflowed away from the box it colours.
   */
  identityName: css`
    display: flex;
    flex: 1 1 240px;
    flex-direction: column;
    gap: 12px;

    min-width: 0;
  `,
  identityRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 16px;
    align-items: flex-start;
  `,
  identitySwatches: css`
    min-width: 0;
  `,
  paramsGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  `,
  root: css`
    overflow: hidden;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;

    min-height: 0;
  `,
  sections: css`
    display: flex;
    flex-direction: column;
    gap: 24px;
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  status: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding-block: 12px 0;
    padding-inline: 16px;
  `,
}));

export const NAME_ID = 'admin-agent-editor-name';
export const DESCRIPTION_ID = 'admin-agent-editor-description';
export const KEY_ID = 'admin-agent-editor-key';
export const SYSTEM_ROLE_ID = 'admin-agent-editor-system-role';
export const OPENING_MESSAGE_ID = 'admin-agent-editor-opening-message';
export const OPENING_QUESTIONS_ID = 'admin-agent-editor-opening-questions';
export const TAGS_ID = 'admin-agent-editor-tags';

/** Already named by the "still needed" line beside Save — never say the same thing twice. */
export const MODEL_BLOCKER = 'agentCatalog.editor.blocked.model';

/** Model parameters are optional: an empty box means "follow the model default". */
interface ParamRow {
  key: 'temperature' | 'topP' | 'presencePenalty' | 'frequencyPenalty' | 'maxTokens';
  max: number;
  min: number;
  step: number;
}

export const PARAM_ROWS: ParamRow[] = [
  { key: 'temperature', max: 2, min: 0, step: 0.1 },
  { key: 'topP', max: 1, min: 0, step: 0.01 },
  { key: 'presencePenalty', max: 2, min: -2, step: 0.1 },
  { key: 'frequencyPenalty', max: 2, min: -2, step: 0.1 },
  { key: 'maxTokens', max: 10_000_000, min: 1, step: 1 },
];
