import {
  Cursor,
  Grok,
  ModelIcon,
  modelMappings,
  OpenAI,
  ProviderCombine,
  ProviderIcon,
  providerMappings,
} from '@lobehub/icons';
import { render, screen } from '@testing-library/react';
import { LOBE_DEFAULT_MODEL_LIST } from 'model-bank';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { describe, expect, it } from 'vitest';

import { registerBrandIcons } from './brandIcons';

/**
 * `@lobehub/icons` has no override hook: these mappings are the ONLY thing that puts an OpenAI
 * mark on `chatgptweb` / `chatgpt`, the Grok/Cursor marks on `grok` / `cursor`, and an icon on
 * the `auto` router model. If the package ever ships its own entries — or changes how it
 * matches them — these assertions are what notices.
 */
describe('brandIcons registration', () => {
  it('maps both ChatGPT provider ids to the OpenAI icon', () => {
    for (const provider of ['chatgptweb', 'chatgpt']) {
      const mapping = providerMappings.find((item) => item.keywords.includes(provider));

      expect(mapping?.Icon).toBe(OpenAI);
      // Wordmark surfaces (ProviderCombine) need the labelled variant, not the bare mark.
      expect(mapping?.Combine).toBeDefined();
    }
  });

  it('gives each ChatGPT provider its own wordmark, since ids match by equality', () => {
    const web = providerMappings.find((item) => item.keywords.includes('chatgptweb'));
    const codex = providerMappings.find((item) => item.keywords.includes('chatgpt'));

    expect(web?.Combine).not.toBe(codex?.Combine);
  });

  it('renders each wordmark with its own label', () => {
    const { unmount } = render(<ProviderCombine provider={'chatgptweb'} size={24} />);
    expect(screen.getByText('ChatGPT Web')).toBeTruthy();
    unmount();

    render(<ProviderCombine provider={'chatgpt'} size={24} />);
    expect(screen.getByText('ChatGPT')).toBeTruthy();
  });

  it('maps the package-shipped marks that are only missing their provider keyword', () => {
    // `grok` and `cursor` have real marks in the package; upstream simply never registered the
    // provider ids, so every surface fell back to the grey placeholder.
    expect(providerMappings.find((item) => item.keywords.includes('grok'))?.Icon).toBe(Grok);
    expect(providerMappings.find((item) => item.keywords.includes('cursor'))?.Icon).toBe(Cursor);
  });

  it('keeps the package lockup for cursor, whose mark identifies exactly one provider', () => {
    // No `Combine` of our own: ProviderCombine then falls through to the component's own
    // lockup, which IS the brand wordmark. Registering one would replace it with ours.
    const mapping = providerMappings.find((item) => item.keywords.includes('cursor'));

    expect(mapping?.Combine).toBeUndefined();
    expect(mapping?.Icon.Combine).toBeDefined();
  });

  it('labels grok, whose mark and lockup are shared with upstream supergrok', () => {
    // Upstream maps `supergrok → Grok` with no Combine, so BOTH ids fall through to
    // `Grok.Combine` and the two provider cards render byte-identical wordmarks. The label is
    // the only thing that tells them apart in the grid.
    const grok = providerMappings.find((item) => item.keywords.includes('grok'));
    const supergrok = providerMappings.find((item) => item.keywords.includes('supergrok'));

    expect(grok?.Icon).toBe(Grok);
    expect(grok?.Combine).toBeDefined();
    // Whatever upstream does, the two must not resolve the same wordmark component.
    expect(grok?.Combine).not.toBe(supergrok?.Combine);
  });

  it('renders the grok wordmark with the Grok mark rather than the OpenAI one', () => {
    const { container } = render(<ProviderCombine provider={'grok'} size={24} />);

    expect(screen.getByText('Grok Build')).toBeTruthy();
    // `title` is the per-component brand string @lobehub/icons puts on its own <svg>.
    expect(container.querySelector('title')?.textContent).toBe(Grok.title);
  });

  it('renders a real avatar for grok/cursor rather than the default placeholder', () => {
    // ProviderIcon dereferences `Icon.Avatar` unconditionally, so this also proves both
    // registered components expose one.
    const { container: placeholder } = render(
      <ProviderIcon provider={'no-such-provider'} size={16} type={'avatar'} />,
    );

    for (const provider of ['grok', 'cursor']) {
      const { container } = render(<ProviderIcon provider={provider} size={16} type={'avatar'} />);

      expect(container.innerHTML).not.toBe('');
      expect(container.innerHTML).not.toBe(placeholder.innerHTML);
    }
  });

  it('falls back to the mono mark for `color`, which neither component ships', () => {
    // Guards the crash the `.Color` branch would cause if it were dereferenced blindly.
    for (const provider of ['grok', 'cursor']) {
      const { container } = render(<ProviderIcon provider={provider} size={16} type={'color'} />);

      expect(container.querySelector('svg')).toBeTruthy();
    }
  });

  it('leaves no builtin provider on the grey placeholder', () => {
    // The product requirement, as an assertion: `ProviderIcon` matches by case-insensitive
    // EQUALITY, so a provider card whose id is not a keyword renders the default placeholder.
    // A new builtin provider therefore has to arrive with an icon — either upstream's or an
    // entry in `PROVIDER_BRAND_ICONS` above.
    const keywords = new Set(
      providerMappings.flatMap((item) => item.keywords.map((keyword) => keyword.toLowerCase())),
    );

    const withoutIcon = DEFAULT_MODEL_PROVIDER_LIST.map((card) => card.id).filter(
      (id) => !keywords.has(id.toLowerCase()),
    );

    expect(withoutIcon).toEqual([]);
  });

  it('matches the `auto` router model exactly and nothing that merely contains it', () => {
    const mapping = modelMappings.find((item) => item.keywords.includes('^auto$'));

    expect(mapping?.Icon).toBe(OpenAI);

    // Mirrors ModelIcon's own matcher: `new RegExp(keyword, 'i').test(model.toLowerCase())`.
    const matches = (model: string) => new RegExp(mapping!.keywords[0], 'i').test(model);

    expect(matches('auto')).toBe(true);
    expect(matches('automatic')).toBe(false);
    expect(matches('gpt-auto')).toBe(false);
  });

  it('gives the `auto` model a real icon instead of the default placeholder', () => {
    const { container: auto } = render(<ModelIcon model={'auto'} size={16} type={'mono'} />);
    const { container: unknown } = render(
      <ModelIcon model={'no-such-model'} size={16} type={'mono'} />,
    );

    expect(auto.innerHTML).not.toBe('');
    expect(auto.innerHTML).not.toBe(unknown.innerHTML);
  });

  it('anchors the Cursor model patterns to the id prefix', () => {
    // Mirrors ModelIcon's own matcher: `new RegExp(keyword, 'i').test(model.toLowerCase())`.
    const matches = (keyword: string, model: string) => new RegExp(keyword, 'i').test(model);

    expect(matches('^composer-', 'composer-2.5')).toBe(true);
    expect(matches('^composer-', 'my-composer-1')).toBe(false);
    expect(matches('^cursor-grok-', 'cursor-grok-4.6-high')).toBe(true);
    // Upstream owns the bare xAI ids (`^grok-`); ours must not reach across to them.
    expect(matches('^cursor-grok-', 'grok-4.6')).toBe(false);
  });

  it('leaves no builtin model of the providers this batch added on the grey placeholder', () => {
    // The provider sweep above is not enough: a provider card can carry its brand while its own
    // models fall back to the generic avatar, which is exactly what happened to `composer-*`
    // and `cursor-grok-*`. Model ids are matched by an UNANCHORED RegExp, so this mirrors
    // `ModelIcon`'s matcher instead of comparing strings.
    const hasIcon = (model: string) =>
      modelMappings.some((item) =>
        item.keywords.some((keyword) => new RegExp(keyword, 'i').test(model.toLowerCase())),
      );

    const withoutIcon = LOBE_DEFAULT_MODEL_LIST.filter(
      (model) => ['cursor', 'grok'].includes(model.providerId) && !hasIcon(model.id),
    ).map((model) => `${model.providerId}/${model.id}`);

    expect(withoutIcon).toEqual([]);
  });

  it('serves a registry it has never seen, exactly once per keyword', () => {
    // A fresh module graph (a second entry bundle, `vi.resetModules()`) hands over BRAND-NEW
    // mapping arrays. A global "already registered" flag skipped them and left them empty
    // while still reporting success — so the guard has to be per array, and this is the case
    // that proves it.
    const providers: typeof providerMappings = [];
    const models: typeof modelMappings = [];

    registerBrandIcons(providers, models);

    for (const keyword of ['chatgptweb', 'chatgpt']) {
      const matches = providers.filter((item) => item.keywords.includes(keyword));
      expect(matches).toHaveLength(1);
      expect(matches[0].Icon).toBe(OpenAI);
      expect(matches[0].Combine).toBeDefined();
    }
    for (const [keyword, Icon] of [
      ['grok', Grok],
      ['cursor', Cursor],
    ] as const) {
      const matches = providers.filter((item) => item.keywords.includes(keyword));
      expect(matches).toHaveLength(1);
      expect(matches[0].Icon).toBe(Icon);
    }
    for (const keyword of ['^auto$', '^composer-', '^cursor-grok-']) {
      expect(models.filter((item) => item.keywords.includes(keyword))).toHaveLength(1);
    }
    expect(providers).toHaveLength(4);
    expect(models).toHaveLength(3);
  });

  it('never registers twice into the same registry, so Vite HMR cannot grow it', () => {
    const providers: typeof providerMappings = [];
    const models: typeof modelMappings = [];

    registerBrandIcons(providers, models);
    // HMR re-executes this module against the arrays it already served.
    registerBrandIcons(providers, models);
    registerBrandIcons(providers, models);

    expect(providers).toHaveLength(4);
    expect(models).toHaveLength(3);
  });

  it('leaves the package registries alone when the module is executed again', () => {
    const providerLength = providerMappings.length;
    const modelLength = modelMappings.length;

    registerBrandIcons();

    expect(providerMappings).toHaveLength(providerLength);
    expect(modelMappings).toHaveLength(modelLength);
  });
});
