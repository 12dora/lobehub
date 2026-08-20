import { createStaticStyles } from 'antd-style';

/** Home overlay fade duration when entering/leaving the home route. */
export const HOME_FADE_MS = 180;

export const styles = createStaticStyles(({ css, cssVar }) => ({
  // Absolutely positioned container, fills parent
  absoluteContainer: css`
    position: absolute;
    inset: 0;
  `,

  // Content area - dark mode
  contentDark: css`
    overflow: hidden;
    background: linear-gradient(
      to bottom,
      ${cssVar.colorBgContainer},
      var(--content-bg-secondary, ${cssVar.colorBgContainer})
    );
  `,

  // Content area - light mode
  contentLight: css`
    overflow: hidden;
    background: var(--content-bg-secondary, ${cssVar.colorBgContainer});
  `,

  // Off-home state. `<Activity mode="hidden">` preserves state but does not hide
  // the DOM, and this container overlays the outlet — so it must stop painting
  // and stop taking pointer events. Fading opacity (instead of snapping to
  // `display: none`) is what turns "home vanished, splash appeared" into a
  // crossfade with the incoming route. `visibility` flips only after the fade so
  // the node leaves the a11y / hit-test tree without cutting the animation short.
  hidden: css`
    pointer-events: none;
    visibility: hidden;
    opacity: 0;
    transition:
      opacity ${HOME_FADE_MS}ms ${cssVar.motionEaseOut},
      visibility 0s linear ${HOME_FADE_MS}ms;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,

  // On-home state.
  visible: css`
    visibility: visible;
    opacity: 1;
    transition: opacity ${HOME_FADE_MS}ms ${cssVar.motionEaseOut};

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
}));
