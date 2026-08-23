import type { DeviceListItem, DeviceScope } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  getPlatformTitle,
  isCapabilityVersionTooLow,
  isDeviceStepNextDisabled,
  selectSelectableDevices,
} from './utils';

const device = (
  deviceId: string,
  online: boolean,
  scope: DeviceScope = 'personal',
): DeviceListItem => ({
  channels: [],
  defaultCwd: null,
  deviceId,
  enroller: null,
  friendlyName: null,
  hostname: deviceId,
  identitySource: null,
  lastSeen: '2026-01-01T00:00:00.000Z',
  online,
  platform: null,
  registered: true,
  scope,
  workingDirs: [],
});

describe('getPlatformTitle', () => {
  it('resolves the display title of a remote platform', () => {
    expect(getPlatformTitle('openclaw')).toBe('OpenClaw');
    expect(getPlatformTitle('hermes')).toBe('Hermes');
  });
});

describe('selectSelectableDevices', () => {
  it('keeps only online devices', () => {
    const result = selectSelectableDevices([device('a', true), device('b', false)], false);

    expect(result.map((d) => d.deviceId)).toEqual(['a']);
  });

  it('drops personal devices when the agent inherits a workspace scope', () => {
    const devices = [device('a', true), device('b', true, 'workspace')];

    expect(selectSelectableDevices(devices, true).map((d) => d.deviceId)).toEqual(['b']);
  });

  it('treats a missing device list as empty', () => {
    expect(selectSelectableDevices(undefined, false)).toEqual([]);
  });
});

describe('isCapabilityVersionTooLow', () => {
  it('recognises the gateway phrase for an outdated CLI', () => {
    expect(
      isCapabilityVersionTooLow({
        available: false,
        reason: 'openclaw is not available on this device',
      }),
    ).toBe(true);
  });

  it('is false for any other failure reason or a missing result', () => {
    expect(isCapabilityVersionTooLow({ available: false, reason: 'unreachable' })).toBe(false);
    expect(isCapabilityVersionTooLow({ available: false })).toBe(false);
    expect(isCapabilityVersionTooLow(undefined)).toBe(false);
  });
});

describe('isDeviceStepNextDisabled', () => {
  it('blocks until a device is picked and its probe has settled', () => {
    expect(
      isDeviceStepNextDisabled({
        capabilityResult: undefined,
        checkingCapability: false,
        deviceId: undefined,
      }),
    ).toBe(true);
    expect(
      isDeviceStepNextDisabled({
        capabilityResult: undefined,
        checkingCapability: true,
        deviceId: 'a',
      }),
    ).toBe(true);
  });

  it('blocks a device whose probe came back unavailable', () => {
    expect(
      isDeviceStepNextDisabled({
        capabilityResult: { available: false },
        checkingCapability: false,
        deviceId: 'a',
      }),
    ).toBe(true);
  });

  it('allows an unprobed or available device', () => {
    expect(
      isDeviceStepNextDisabled({
        capabilityResult: undefined,
        checkingCapability: false,
        deviceId: 'a',
      }),
    ).toBe(false);
    expect(
      isDeviceStepNextDisabled({
        capabilityResult: { available: true },
        checkingCapability: false,
        deviceId: 'a',
      }),
    ).toBe(false);
  });
});
