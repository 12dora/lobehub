// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  extractRfc6052Ipv4,
  isMetadataHostname,
  isMetadataIp,
  isPrivateIp,
  isPubliclyRoutableIp,
} from './index';

describe('policy helpers', () => {
  it('classifies private and loopback addresses', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.5.1')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('identifies cloud metadata IPs and hostnames', () => {
    expect(isMetadataIp('169.254.169.254')).toBe(true);
    expect(isMetadataIp('169.254.170.2')).toBe(true);
    expect(isMetadataIp('fd00:ec2::254')).toBe(true);
    expect(isMetadataIp('10.0.0.1')).toBe(false);
    expect(isMetadataHostname('metadata.google.internal')).toBe(true);
    expect(isMetadataHostname('METADATA.GOOGLE.INTERNAL')).toBe(true);
    expect(isMetadataHostname('api.example.com')).toBe(false);
  });

  it('classifies only globally routable addresses for public-only callers', () => {
    expect(isPubliclyRoutableIp('8.8.8.8')).toBe(true);
    expect(isPubliclyRoutableIp('2606:4700:4700::1111')).toBe(true);
    expect(isPubliclyRoutableIp('64:ff9b::808:808')).toBe(true);
    expect(isPubliclyRoutableIp('64:ff9b::a00:1')).toBe(false);
    for (const address of [
      '100.64.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '203.0.113.1',
      '224.0.0.1',
      '2001:db8::1',
      '2002:0808:0808::1',
      '3fff::1',
    ]) {
      expect(isPubliclyRoutableIp(address)).toBe(false);
    }
  });

  it('treats IPv4-mapped IPv6 encodings of IMDS as metadata', () => {
    expect(isMetadataIp('::ffff:169.254.169.254')).toBe(true);
    expect(isMetadataIp('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isMetadataIp('0:0:0:0:0:ffff:169.254.170.2')).toBe(true);
    expect(isMetadataIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('decodes RFC 6052 NAT64/SIIT layouts before metadata classification', () => {
    expect(isMetadataIp('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isMetadataIp('64:ff9b:1:a9fe:a9:fe00::')).toBe(true);
    expect(isMetadataIp('64:ff9b::808:808')).toBe(false);
  });

  it.each([
    ['2001:db9::/32', '2001:db9:a00:1::'],
    ['2001:db9:100::/40', '2001:db9:10a:0:1::'],
    ['2001:db9:1::/48', '2001:db9:1:a00:0:100::'],
    ['2001:db9:1:200::/56', '2001:db9:1:20a:0:1::'],
    ['2001:db9:1:2::/64', '2001:db9:1:2:a:0:100:0'],
    ['2001:db9:1:2:3:4::/96', '2001:db9:1:2:3:4:a00:1'],
  ])('rejects private IPv4 embedded by configured RFC 6052 prefix %s', (prefix, address) => {
    expect(extractRfc6052Ipv4(address, prefix)).toBe('10.0.0.1');
    expect(isPubliclyRoutableIp(address, [prefix])).toBe(false);
  });

  it.each(['100.64.0.1', '169.254.1.1', '169.254.169.254'])(
    'rejects non-public mapped IPv4 class %s',
    (ipv4) => {
      expect(isPubliclyRoutableIp(`::ffff:${ipv4}`)).toBe(false);
    },
  );
});
