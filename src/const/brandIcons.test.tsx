import {
  ModelIcon,
  modelMappings,
  OpenAI,
  ProviderCombine,
  providerMappings,
} from '@lobehub/icons';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { registerBrandIcons } from './brandIcons';

/**
 * `@lobehub/icons` has no override hook: these mappings are the ONLY thing that puts an OpenAI
 * mark on `chatgptweb` / `chatgpt` and on the `auto` router model. If the package ever ships
 * its own entries — or changes how it matches them — these assertions are what notices.
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
    expect(models.filter((item) => item.keywords.includes('^auto$'))).toHaveLength(1);
    expect(providers).toHaveLength(2);
    expect(models).toHaveLength(1);
  });

  it('never registers twice into the same registry, so Vite HMR cannot grow it', () => {
    const providers: typeof providerMappings = [];
    const models: typeof modelMappings = [];

    registerBrandIcons(providers, models);
    // HMR re-executes this module against the arrays it already served.
    registerBrandIcons(providers, models);
    registerBrandIcons(providers, models);

    expect(providers).toHaveLength(2);
    expect(models).toHaveLength(1);
  });

  it('leaves the package registries alone when the module is executed again', () => {
    const providerLength = providerMappings.length;
    const modelLength = modelMappings.length;

    registerBrandIcons();

    expect(providerMappings).toHaveLength(providerLength);
    expect(modelMappings).toHaveLength(modelLength);
  });
});
