import type { RequestOptions } from 'node:https';

export const CANONICAL_FIXTURE_HOST: string;
export const PUBLIC_FIXTURE_ADDRESS: string;
export const isPinnedFixtureRequest: (options: RequestOptions) => boolean;
export const redirectPinnedHttpsOptions: (
  options: RequestOptions,
  fixturePort: number,
) => RequestOptions;
