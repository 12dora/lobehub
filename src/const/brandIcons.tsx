import { Cursor, Grok, IconCombine, modelMappings, OpenAI, providerMappings } from '@lobehub/icons';
import type { DivProps } from '@lobehub/ui';
import type { ComponentProps } from 'react';
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

/**
 * The component a mapping may carry. `@lobehub/icons` does not export the type, but it does
 * export the array — and deriving from it is what makes the `.Avatar` requirement a COMPILE
 * error rather than a blank icon: `ProviderIcon` dereferences `Icon.Avatar` unconditionally
 * once `Icon` is truthy, so a bare icon function would render `undefined` instead of falling
 * back to the placeholder.
 *
 * Intersected with what `IconCombine` takes, because a wordmark hands the same component to
 * both: the registry types its own slot as `FC<any>`, which is too loose for `IconCombine`
 * (it wants the forwardRef icon), so neither half alone accepts both uses.
 */
type ProviderIconComponent = (typeof providerMappings)[number]['Icon'] &
  NonNullable<ComponentProps<typeof IconCombine>['Icon']>;

/** OpenAI's own wordmark proportions, so our labels line up with `OpenAI.Combine`. */
const WORDMARK_SPACE_MULTIPLE = 0.1;
const WORDMARK_TEXT_MULTIPLE = 0.75;

interface BrandCombineProps extends DivProps {
  size?: number;
  /** `mono` | `color`, handed down by ProviderCombine. Both marks below are single mono ones. */
  type?: 'color' | 'mono';
}

/**
 * Wordmark for a provider whose mark alone does not identify it: the mark plus a text label,
 * laid out by the package's own `IconCombine` so it matches every other provider wordmark.
 *
 * Two reasons an id needs one, and both are the same failure — a mark that belongs to more than
 * one provider id. The ChatGPT family has no mark of its own and borrows OpenAI's; `grok` shares
 * the Grok mark AND `Grok.Combine` with upstream's `supergrok`, so without a label of its own the
 * two provider cards render byte-identical lockups.
 *
 * The label is a brand string and stays in English on purpose — it is a logo, not copy. The
 * translatable provider NAME lives in the `providers` i18n namespace (see `useProviderName`).
 */
const createBrandCombine = (label: string, Mark: ProviderIconComponent) => {
  // `type` is deliberately dropped: both marks are single mono ones that inherit `currentColor`,
  // and forwarding it would land a stray `type` attribute on the wrapper element.
  const BrandCombine = memo<BrandCombineProps>(({ size = 24, type: _type, ...rest }) => (
    <IconCombine
      Icon={Mark}
      aria-label={label}
      extra={label}
      extraStyle={{ fontWeight: 600 }}
      showText={false}
      size={size}
      spaceMultiple={WORDMARK_SPACE_MULTIPLE}
      textMultiple={WORDMARK_TEXT_MULTIPLE}
      {...rest}
    />
  ));
  BrandCombine.displayName = `BrandCombine(${label})`;
  return BrandCombine;
};

/**
 * Provider ids are matched by case-insensitive EQUALITY, so each id needs its own entry.
 *
 * `Icon` is the mark, `label` the wordmark text:
 * - no `Icon` — the ChatGPT family, which has no mark of its own and borrows OpenAI's.
 * - no `label` — the mark ships in the package, only the id keyword was missing, and the
 *   component's own `.Combine` lockup already names exactly this provider (`cursor`).
 *   `ProviderCombine` falls back to it on its own, so registering one would REPLACE the real
 *   brand lockup with ours.
 * - both — the mark ships in the package but is SHARED with another provider id, so its own
 *   lockup identifies neither: `grok` and upstream's `supergrok` both resolve `Grok.Combine`,
 *   and this is the only thing that tells the two cards apart in an 84-card grid. `supergrok`
 *   is displayed as plain "Grok", which is exactly what `Grok.Combine` reads, so only `grok`
 *   ("Grok Build") needs an entry here.
 *
 * Neither `Grok` nor `Cursor` ships a `.Color` variant, and none is needed — `ProviderIcon`'s
 * `color` / `combine-color` branches already fall back to the mono mark when `.Color` is absent.
 */
type ProviderBrandIcon =
  | { Icon?: undefined; keyword: string; label: string }
  | { Icon: ProviderIconComponent; keyword: string; label?: undefined }
  | { Icon: ProviderIconComponent; keyword: string; label: string };

const PROVIDER_BRAND_ICONS: readonly ProviderBrandIcon[] = [
  { keyword: 'chatgptweb', label: 'ChatGPT Web' },
  { keyword: 'chatgpt', label: 'ChatGPT' },
  { Icon: Grok, keyword: 'grok', label: 'Grok Build' },
  { Icon: Cursor, keyword: 'cursor' },
];

/**
 * Model ids are matched by an UNANCHORED `RegExp`, so keywords are patterns.
 *
 * - `^auto$` keeps ChatGPT Web's `auto` router model from swallowing every id that merely
 *   contains "auto".
 * - `^composer-` / `^cursor-grok-` are the two Cursor-branded families: upstream matches Grok
 *   on `^grok-` | `/grok-`, so `cursor-grok-4.6-high` matches nothing and the models carrying
 *   the new provider's own identity were the only rows left on the grey placeholder.
 */
const MODEL_BRAND_ICONS = [
  { Icon: OpenAI, keyword: '^auto$' },
  { Icon: Cursor, keyword: '^composer-' },
  { Icon: Grok, keyword: '^cursor-grok-' },
] as const;

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
    for (const { Icon, keyword, label } of PROVIDER_BRAND_ICONS) {
      // No mark of its own ⇒ OpenAI's, which is only ever paired with a label.
      const Mark = Icon ?? OpenAI;
      providerRegistry.unshift(
        label
          ? { Combine: createBrandCombine(label, Mark), Icon: Mark, keywords: [keyword] }
          : { Icon: Mark, keywords: [keyword] },
      );
    }
  }

  if (claimRegistry(modelRegistry)) {
    for (const { Icon, keyword } of MODEL_BRAND_ICONS) {
      modelRegistry.unshift({ Icon, keywords: [keyword] });
    }
  }
};

registerBrandIcons();
