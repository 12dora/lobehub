import { IconCombine, modelMappings, OpenAI, providerMappings } from '@lobehub/icons';
import type { DivProps } from '@lobehub/ui';
import { memo } from 'react';

/**
 * Brand-icon registrations for providers/models that `@lobehub/icons` does not know about.
 *
 * `providerMappings` / `modelMappings` are plain exported arrays that `ProviderIcon`,
 * `ProviderCombine` and `ModelIcon` scan at render time, and the package offers no override
 * hook — so a side-effect module that prepends our entries is the whole mechanism. Entries are
 * `unshift`ed so they win over any keyword the package may add later.
 *
 * Import this ONCE, as early as possible (the SPA entries in `src/spa/entry.*.tsx` import it
 * right after `initialize`; the auth entry renders no icons and skips it to keep that bundle
 * small): a mapping registered after a `ProviderIcon` has already rendered would leave that
 * instance on the default placeholder.
 *
 * Pure React/JS — no DOM access — so it is safe in every entry.
 */

/** OpenAI's own wordmark proportions, so our labels line up with `OpenAI.Combine`. */
const OPENAI_SPACE_MULTIPLE = 0.1;
const OPENAI_TEXT_MULTIPLE = 0.75;

interface BrandCombineProps extends DivProps {
  size?: number;
  /** `mono` | `color`, handed down by ProviderCombine. OpenAI ships a single mono mark. */
  type?: 'color' | 'mono';
}

/**
 * Wordmark for the ChatGPT-backed providers: the OpenAI mark plus a text label, laid out by the
 * package's own `IconCombine` so it matches every other provider wordmark.
 *
 * The label is a brand string and stays in English on purpose — it is a logo, not copy. The
 * translatable provider NAME lives in the `providers` i18n namespace (see `useProviderName`).
 */
const createBrandCombine = (label: string) => {
  // `type` is deliberately dropped: OpenAI ships a single mono mark that inherits `currentColor`,
  // and forwarding it would land a stray `type` attribute on the wrapper element.
  const BrandCombine = memo<BrandCombineProps>(({ size = 24, type: _type, ...rest }) => (
    <IconCombine
      Icon={OpenAI}
      aria-label={label}
      extra={label}
      extraStyle={{ fontWeight: 600 }}
      showText={false}
      size={size}
      spaceMultiple={OPENAI_SPACE_MULTIPLE}
      textMultiple={OPENAI_TEXT_MULTIPLE}
      {...rest}
    />
  ));
  BrandCombine.displayName = `BrandCombine(${label})`;
  return BrandCombine;
};

/**
 * Provider ids are matched by case-insensitive EQUALITY, so each id needs its own entry — which
 * is also what lets the two of them carry different wordmark labels.
 */
const PROVIDER_BRAND_ICONS = [
  { keyword: 'chatgptweb', label: 'ChatGPT Web' },
  { keyword: 'chatgpt', label: 'ChatGPT' },
] as const;

/**
 * Model ids are matched by an UNANCHORED `RegExp`, so keywords are patterns. `^auto$` keeps
 * ChatGPT Web's `auto` router model from swallowing every id that merely contains "auto".
 */
const MODEL_BRAND_ICONS = [{ Icon: OpenAI, keyword: '^auto$' }] as const;

/**
 * Idempotency is per REGISTRY ARRAY — not a module-local flag, and not one global flag either.
 *
 * Vite HMR re-executes this module with a fresh module scope while the mapping arrays live for
 * the lifetime of the tab (a local flag would let them grow on every hot update), but a fresh
 * module graph — a second entry bundle, or `vi.resetModules()` in a test — hands over brand-new
 * arrays that have received nothing yet. A single global flag cannot tell those two apart: it
 * skips exactly the arrays that still need the entries and leaves them empty.
 *
 * The mark therefore lives on the array being served. `Symbol.for` so two copies of this module
 * agree on the key; a symbol property is invisible to `for…in`, `Object.keys` and JSON, so it
 * cannot leak into anything that walks a mapping array.
 */
const REGISTERED = Symbol.for('lobe.brandIcons.registered');

/** Claims a registry for this module; `false` means it was already served. */
const claimRegistry = (registry: object): boolean => {
  const claimed = registry as { [REGISTERED]?: true };
  if (claimed[REGISTERED]) return false;
  claimed[REGISTERED] = true;
  return true;
};

/**
 * Prepend our entries to a provider/model registry, at most once per array.
 *
 * Exported (and parameterised) so the guard itself is testable: the arrays a test hands in are
 * the only way to tell "already registered here" from "never registered anywhere".
 */
export const registerBrandIcons = (
  providerRegistry: typeof providerMappings = providerMappings,
  modelRegistry: typeof modelMappings = modelMappings,
) => {
  if (claimRegistry(providerRegistry)) {
    for (const { keyword, label } of PROVIDER_BRAND_ICONS) {
      providerRegistry.unshift({
        Combine: createBrandCombine(label),
        Icon: OpenAI,
        keywords: [keyword],
      });
    }
  }

  if (claimRegistry(modelRegistry)) {
    for (const { Icon, keyword } of MODEL_BRAND_ICONS) {
      modelRegistry.unshift({ Icon, keywords: [keyword] });
    }
  }
};

registerBrandIcons();
