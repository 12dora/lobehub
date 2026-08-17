/**
 * A catalog state that blocks Save. Unlike `issues` (staleness, rendered next to the field it
 * belongs to), a blocker can originate from a field the host hides — Skills and Connectors live in
 * a collapsed group — so the host MUST render it where the Save button is.
 */
export interface DependencyBlocker {
  /** i18n key describing what is blocking Save. */
  message: string;
  /** Present when the underlying catalog exposes a retry. */
  retry?: () => Promise<unknown>;
}

export interface DependencyValidity {
  /** Save-blocking catalog loading/error states, including ones from hidden fields. */
  blockers: DependencyBlocker[];
  issues: string[];
  ready: boolean;
}
