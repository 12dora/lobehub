import { describe, expect, it } from 'vitest';

import {
  mailDestinationTuple,
  mailTuplesEqual,
  objectStorageDestinationTuple,
  objectStorageTuplesEqual,
  synthesizeAwsEndpoint,
} from './destinationTuple';

describe('objectStorageDestinationTuple', () => {
  it('treats trailing slashes and host case as the same endpoint', () => {
    const a = objectStorageDestinationTuple({
      bucket: 'files',
      endpoint: 'https://S3.Example.com/',
      region: 'US-EAST-1',
    });
    const b = objectStorageDestinationTuple({
      bucket: 'files',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
    });
    expect(objectStorageTuplesEqual(a, b)).toBe(true);
  });

  it('synthesizes the AWS endpoint when only region is set', () => {
    const tuple = objectStorageDestinationTuple({ bucket: 'files', region: 'eu-west-1' });
    expect(tuple.endpoint).toBe(synthesizeAwsEndpoint('eu-west-1'));
  });

  it('treats a bucket change as a different tuple', () => {
    expect(
      objectStorageTuplesEqual(
        objectStorageDestinationTuple({ bucket: 'a', endpoint: 'https://s3.example.com' }),
        objectStorageDestinationTuple({ bucket: 'b', endpoint: 'https://s3.example.com' }),
      ),
    ).toBe(false);
  });
});

describe('mailDestinationTuple', () => {
  it('compares SMTP host/port/secure/user', () => {
    const base = mailDestinationTuple({
      provider: 'smtp',
      smtp: { host: 'SMTP.example.com', port: 587, secure: false, user: 'ops' },
    });
    expect(
      mailTuplesEqual(
        base,
        mailDestinationTuple({
          provider: 'smtp',
          smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'ops' },
        }),
      ),
    ).toBe(true);
    expect(
      mailTuplesEqual(
        base,
        mailDestinationTuple({
          provider: 'smtp',
          smtp: { host: 'smtp.example.com', port: 465, secure: false, user: 'ops' },
        }),
      ),
    ).toBe(false);
  });

  it('treats resend as provider-only', () => {
    expect(
      mailTuplesEqual(
        mailDestinationTuple({ provider: 'resend' }),
        mailDestinationTuple({ provider: 'resend', smtp: { host: 'ignored', port: 1 } }),
      ),
    ).toBe(true);
    expect(
      mailTuplesEqual(
        mailDestinationTuple({ provider: 'resend' }),
        mailDestinationTuple({ provider: 'smtp', smtp: { host: 'smtp.example.com', port: 587 } }),
      ),
    ).toBe(false);
  });
});
