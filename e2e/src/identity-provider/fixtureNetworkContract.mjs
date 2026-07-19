export const CANONICAL_FIXTURE_HOST = 'authentik-fixture.93-184-216-34.sslip.io';
export const PUBLIC_FIXTURE_ADDRESS = '93.184.216.34';

const headerValue = (headers, name) => {
  if (!headers || typeof headers !== 'object') return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(', ') : value === undefined ? undefined : String(value);
};

export const isPinnedFixtureRequest = (options) => {
  if (!options || typeof options !== 'object') return false;
  const port = options.port === undefined ? 443 : Number(options.port);
  return (
    options.hostname === PUBLIC_FIXTURE_ADDRESS &&
    port === 443 &&
    options.servername === CANONICAL_FIXTURE_HOST &&
    headerValue(options.headers, 'host') === CANONICAL_FIXTURE_HOST
  );
};

export const redirectPinnedHttpsOptions = (options, fixturePort) => {
  if (!isPinnedFixtureRequest(options)) return options;
  if (!Number.isSafeInteger(fixturePort) || fixturePort < 1 || fixturePort > 65_535) return options;
  return {
    ...options,
    family: 4,
    hostname: '127.0.0.1',
    port: fixturePort,
  };
};
