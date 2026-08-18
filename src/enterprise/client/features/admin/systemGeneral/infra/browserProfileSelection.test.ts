import { describe, expect, it } from 'vitest';

import type { AdminBrowserProfileOptions } from '@/enterprise/client/services/adminSystem';

import {
  browserProfileSelectionKey,
  isBrowserProfileSelectionDirty,
  repairBrowserProfileSelection,
  visibleBrowserProfileOptions,
} from './browserProfileSelection';

const MAC = 'system-macos-15-arm';
const WINDOWS = 'system-windows-11';

const options = (): AdminBrowserProfileOptions => ({
  chrome: [
    {
      fullVersion: '150.0.7871.95',
      id: 'chrome-150',
      impersonateProfile: 'chrome150',
      label: 'Chrome 150',
      major: 150,
    },
    {
      fullVersion: '146.0.7680.74',
      id: 'chrome-146',
      impersonateProfile: 'chrome146',
      label: 'Chrome 146',
      major: 146,
    },
  ],
  compute: [
    {
      arch: 'arm',
      cores: 12,
      id: 'compute-mac-arm-12-24',
      label: '12 cores · 24 GiB',
      memoryGiB: 24,
      platform: 'macOS',
    },
    {
      arch: 'arm',
      cores: 10,
      id: 'compute-mac-arm-10-16',
      label: '10 cores · 16 GiB',
      memoryGiB: 16,
      platform: 'macOS',
    },
    {
      arch: 'x86',
      cores: 16,
      id: 'compute-win-16-32',
      label: '16 cores · 32 GiB',
      memoryGiB: 32,
      platform: 'Windows',
    },
  ],
  locales: [
    {
      acceptLanguage: 'en-US,en;q=0.9',
      id: 'locale-en-us-new-york',
      label: 'en-US · America/New_York',
      timezone: 'America/New_York',
    },
    {
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      id: 'locale-zh-cn-shanghai',
      label: 'zh-CN · Asia/Shanghai',
      timezone: 'Asia/Shanghai',
    },
  ],
  screens: [
    {
      dpr: 2,
      height: 982,
      id: 'screen-mac-1512-982-2',
      label: '1512 × 982 @ 2×',
      platform: 'macOS',
      width: 1512,
    },
    {
      dpr: 1,
      height: 1080,
      id: 'screen-win-1920-1080-1',
      label: '1920 × 1080 @ 1×',
      platform: 'Windows',
      width: 1920,
    },
  ],
  systems: [
    {
      arch: 'arm',
      id: MAC,
      label: 'macOS 15 · Apple Silicon',
      navigatorPlatform: 'MacIntel',
      platform: 'macOS',
      platformVersion: '15.6.1',
    },
    {
      arch: 'x86',
      id: WINDOWS,
      label: 'Windows 11',
      navigatorPlatform: 'Win32',
      platform: 'Windows',
      platformVersion: '15.0.0',
    },
  ],
  webgl: [
    {
      arch: 'arm',
      id: 'webgl-apple-m3',
      label: 'Apple M3',
      platform: 'macOS',
      renderer: 'ANGLE (Apple, Apple M3, OpenGL 4.1)',
      vendor: 'Apple Inc.',
    },
    {
      arch: 'x86',
      id: 'webgl-nvidia-3060',
      label: 'NVIDIA GeForce RTX 3060',
      platform: 'Windows',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
      vendor: 'Google Inc. (NVIDIA)',
    },
  ],
});

const onMac = {
  chromeId: 'chrome-150',
  computeId: 'compute-mac-arm-12-24',
  localeId: 'locale-en-us-new-york',
  screenId: 'screen-mac-1512-982-2',
  systemId: MAC,
  webglId: 'webgl-apple-m3',
};

describe('visibleBrowserProfileOptions', () => {
  it('only offers hardware that exists on the chosen machine', () => {
    const visible = visibleBrowserProfileOptions(options(), WINDOWS);

    // An Apple GPU and an Apple-silicon-only memory size cannot be bought with a Windows box.
    expect(visible.webgl.map((entry) => entry.id)).toEqual(['webgl-nvidia-3060']);
    expect(visible.compute.map((entry) => entry.id)).toEqual(['compute-win-16-32']);
    expect(visible.screens.map((entry) => entry.id)).toEqual(['screen-win-1920-1080-1']);
    // Chrome and the locale are independent of the machine.
    expect(visible.chrome).toHaveLength(2);
    expect(visible.locales).toHaveLength(2);
  });

  it('offers no hardware at all while the machine is unresolved', () => {
    const visible = visibleBrowserProfileOptions(options(), null);

    expect(visible.compute).toEqual([]);
    expect(visible.screens).toEqual([]);
    expect(visible.webgl).toEqual([]);
  });
});

describe('repairBrowserProfileSelection', () => {
  it('leaves a choice that is still offered alone', () => {
    expect(repairBrowserProfileSelection(options(), onMac)).toEqual(onMac);
  });

  it('repoints the hardware a change of machine invalidated', () => {
    const repaired = repairBrowserProfileSelection(options(), {
      ...onMac,
      systemId: WINDOWS,
    });

    expect(repaired).toEqual({
      chromeId: 'chrome-150',
      computeId: 'compute-win-16-32',
      localeId: 'locale-en-us-new-york',
      screenId: 'screen-win-1920-1080-1',
      systemId: WINDOWS,
      webglId: 'webgl-nvidia-3060',
    });
  });

  it('settles a profile the pools no longer describe onto something savable', () => {
    const repaired = repairBrowserProfileSelection(options(), {
      chromeId: null,
      computeId: null,
      localeId: null,
      screenId: null,
      systemId: null,
      webglId: null,
    });

    expect(repaired).toEqual(onMac);
  });

  it('has nothing to offer without options', () => {
    expect(repairBrowserProfileSelection(undefined, onMac)).toBeUndefined();
  });
});

describe('isBrowserProfileSelectionDirty', () => {
  it('is quiet until the choice actually differs from what is stored', () => {
    expect(isBrowserProfileSelectionDirty(onMac, onMac)).toBe(false);
    expect(isBrowserProfileSelectionDirty(onMac, { ...onMac, chromeId: 'chrome-146' })).toBe(true);
    // A stored value the pools cannot name is a change waiting to be written, not a match.
    expect(isBrowserProfileSelectionDirty({ ...onMac, webglId: null }, onMac)).toBe(true);
    expect(isBrowserProfileSelectionDirty(onMac, undefined)).toBe(false);
  });
});

describe('browserProfileSelectionKey', () => {
  it('changes only when the stored choice does', () => {
    expect(browserProfileSelectionKey(onMac)).toBe(browserProfileSelectionKey({ ...onMac }));
    expect(browserProfileSelectionKey(onMac)).not.toBe(
      browserProfileSelectionKey({ ...onMac, screenId: 'screen-win-1920-1080-1' }),
    );
  });
});
