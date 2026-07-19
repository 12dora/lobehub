import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const AUTHENTIK_FIXTURE_HOST = 'authentik-fixture.93-184-216-34.sslip.io';
export const AUTHENTIK_FIXTURE_ISSUER =
  'https://authentik-fixture.93-184-216-34.sslip.io/application/o/aihub/';
export const AUTHENTIK_FIXTURE_CLIENT_ID = 'aihub-e2e-client';
export const AUTHENTIK_FIXTURE_SUBJECT = 'authentik-e2e-subject';

const KEY_ID = 'aihub-e2e-rs256-v1';
const execute = promisify(execFile);

interface PendingAuthorization {
  challenge: string;
  clientId: string;
  nonce?: string;
  redirectUri: string;
  state: string;
}

interface AuthorizationCode extends PendingAuthorization {
  consumed: boolean;
}

export interface AuthentikFixtureLog {
  authorizeRequests: number;
  clientSecretBasicExchanges: number;
  clientSecretPostExchanges: number;
  consentApprovals: number;
  failedRequests: number;
  tokenExchanges: number;
  userinfoRequests: number;
}

export interface AuthentikFixtureOptions {
  clientSecret: string;
  expectedRedirectUri: string;
  requireNonce?: boolean;
}

export interface AuthentikFixture {
  caCertificatePath: string;
  close: () => Promise<void>;
  issuer: string;
  log: Readonly<AuthentikFixtureLog>;
  port: number;
  tlsOrigin: string;
}

const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

const readBody = async (request: NodeJS.ReadableStream): Promise<URLSearchParams> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
};

const sendJson = (response: ServerResponse, status: number, value: Record<string, unknown>) => {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
};

const sendOauthError = (response: ServerResponse, code: string, description: string) =>
  sendJson(response, 400, { error: code, error_description: description });

const safeEqual = (left: string, right: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(left, 'utf8').digest(),
    createHash('sha256').update(right, 'utf8').digest(),
  );

const generateTlsMaterial = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aihub-authentik-fixture-'));
  await chmod(directory, 0o700);
  const caKey = path.join(directory, 'ca.key');
  const caCertificate = path.join(directory, 'ca.crt');
  const serverKey = path.join(directory, 'server.key');
  const serverCsr = path.join(directory, 'server.csr');
  const serverCertificate = path.join(directory, 'server.crt');
  const extensionFile = path.join(directory, 'server.ext');

  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=AIHub Authentik E2E CA',
    '-keyout',
    caKey,
    '-out',
    caCertificate,
  ]);
  await execute('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${AUTHENTIK_FIXTURE_HOST}`,
    '-keyout',
    serverKey,
    '-out',
    serverCsr,
  ]);
  await writeFile(
    extensionFile,
    `subjectAltName=DNS:${AUTHENTIK_FIXTURE_HOST}\nextendedKeyUsage=serverAuth\n`,
    { mode: 0o600 },
  );
  await execute('openssl', [
    'x509',
    '-req',
    '-days',
    '1',
    '-in',
    serverCsr,
    '-CA',
    caCertificate,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    serverCertificate,
    '-extfile',
    extensionFile,
  ]);

  return {
    caCertificate,
    certificate: await readFile(serverCertificate),
    directory,
    key: await readFile(serverKey),
  };
};

const listen = async (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('fixture port missing'));
      resolve(address.port);
    });
  });

export const startAuthentikFixture = async (
  options: AuthentikFixtureOptions,
): Promise<AuthentikFixture> => {
  const tls = await generateTlsMaterial();
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const pending = new Map<string, PendingAuthorization>();
  const codes = new Map<string, AuthorizationCode>();
  const accessTokens = new Set<string>();
  const log: AuthentikFixtureLog = {
    authorizeRequests: 0,
    clientSecretBasicExchanges: 0,
    clientSecretPostExchanges: 0,
    consentApprovals: 0,
    failedRequests: 0,
    tokenExchanges: 0,
    userinfoRequests: 0,
  };

  const fail = (response: ServerResponse, code: string, description: string) => {
    log.failedRequests += 1;
    sendOauthError(response, code, description);
  };

  const server = createServer(
    { cert: tls.certificate, key: tls.key },
    async (request, response) => {
      const url = new URL(request.url ?? '/', AUTHENTIK_FIXTURE_ISSUER);
      const path = url.pathname;

      if (
        request.method === 'GET' &&
        path === '/application/o/aihub/.well-known/openid-configuration'
      ) {
        return sendJson(response, 200, {
          authorization_endpoint: `${AUTHENTIK_FIXTURE_ISSUER}authorize`,
          authorization_response_iss_parameter_supported: true,
          claims_supported: [
            'sub',
            'name',
            'preferred_username',
            'email',
            'picture',
            'https://fintlabs.cloud/claims/title',
            'https://fintlabs.cloud/claims/dingtalk_user_id',
          ],
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['RS256'],
          issuer: AUTHENTIK_FIXTURE_ISSUER,
          jwks_uri: `${AUTHENTIK_FIXTURE_ISSUER}jwks`,
          response_types_supported: ['code'],
          scopes_supported: ['openid', 'profile', 'email', 'dingtalk'],
          subject_types_supported: ['public'],
          token_endpoint: `${AUTHENTIK_FIXTURE_ISSUER}token`,
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          userinfo_endpoint: `${AUTHENTIK_FIXTURE_ISSUER}userinfo`,
        });
      }

      if (request.method === 'GET' && path === '/application/o/aihub/jwks') {
        return sendJson(response, 200, {
          keys: [{ ...publicJwk, alg: 'RS256', kid: KEY_ID, use: 'sig' }],
        });
      }

      if (request.method === 'GET' && path === '/application/o/aihub/authorize') {
        log.authorizeRequests += 1;
        const clientId = url.searchParams.get('client_id') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? '';
        const nonce = url.searchParams.get('nonce') ?? undefined;
        if (
          clientId !== AUTHENTIK_FIXTURE_CLIENT_ID ||
          redirectUri !== options.expectedRedirectUri ||
          !state ||
          url.searchParams.get('response_type') !== 'code' ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !challenge ||
          (options.requireNonce && !nonce)
        ) {
          return fail(response, 'invalid_request', 'authorization request rejected');
        }
        const consentId = randomBytes(18).toString('base64url');
        pending.set(consentId, { challenge, clientId, nonce, redirectUri, state });
        response.writeHead(200, {
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'content-type': 'text/html; charset=utf-8',
        });
        return response.end(`<!doctype html><html><head><title>Authentik E2E Consent</title></head>
        <body><main><h1>Authorize AIHub E2E</h1><p>Share your trusted work identity.</p>
        <form method="post" action="${AUTHENTIK_FIXTURE_ISSUER}consent">
        <input type="hidden" name="consent_id" value="${consentId}">
        <button type="submit">Continue</button></form></main></body></html>`);
      }

      if (request.method === 'POST' && path === '/application/o/aihub/consent') {
        const body = await readBody(request);
        const consentId = body.get('consent_id') ?? '';
        const authorization = pending.get(consentId);
        pending.delete(consentId);
        if (!authorization) return fail(response, 'invalid_request', 'consent expired');
        log.consentApprovals += 1;
        const code = randomBytes(24).toString('base64url');
        codes.set(code, { ...authorization, consumed: false });
        const redirect = new URL(authorization.redirectUri);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('iss', AUTHENTIK_FIXTURE_ISSUER);
        redirect.searchParams.set('state', authorization.state);
        response.writeHead(302, { location: redirect.toString() });
        return response.end();
      }

      if (request.method === 'POST' && path === '/application/o/aihub/token') {
        log.tokenExchanges += 1;
        const body = await readBody(request);
        const authorization = request.headers.authorization ?? '';
        const hasBasicCredentials = authorization.startsWith('Basic ');
        const hasPostClientId = body.has('client_id');
        const hasPostClientSecret = body.has('client_secret');
        const usesBasic = hasBasicCredentials && !hasPostClientId && !hasPostClientSecret;
        const usesPost = !authorization && hasPostClientId && hasPostClientSecret;
        const encoded = usesBasic ? authorization.slice(6) : '';
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        const clientId = usesPost
          ? (body.get('client_id') ?? '')
          : separator >= 0
            ? decoded.slice(0, separator)
            : '';
        const clientSecret = usesPost
          ? (body.get('client_secret') ?? '')
          : separator >= 0
            ? decoded.slice(separator + 1)
            : '';
        const codeValue = body.get('code') ?? '';
        const code = codes.get(codeValue);
        const verifier = body.get('code_verifier') ?? '';
        if (
          !code ||
          code.consumed ||
          (!usesBasic && !usesPost) ||
          clientId !== code.clientId ||
          !safeEqual(clientSecret, options.clientSecret) ||
          body.get('redirect_uri') !== code.redirectUri ||
          body.get('grant_type') !== 'authorization_code' ||
          !verifier ||
          hash(verifier) !== code.challenge
        ) {
          return fail(response, 'invalid_grant', 'token request rejected');
        }
        if (usesBasic) log.clientSecretBasicExchanges += 1;
        if (usesPost) log.clientSecretPostExchanges += 1;
        code.consumed = true;
        const now = Math.floor(Date.now() / 1000);
        const accessToken = randomBytes(32).toString('base64url');
        accessTokens.add(accessToken);
        const idToken = await new SignJWT({
          email: 'dora.ding@example.test',
          name: 'Dora Ding',
          nonce: code.nonce,
          preferred_username: 'dora.ding',
        })
          .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
          .setIssuer(AUTHENTIK_FIXTURE_ISSUER)
          .setAudience(AUTHENTIK_FIXTURE_CLIENT_ID)
          .setSubject(AUTHENTIK_FIXTURE_SUBJECT)
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
        return sendJson(response, 200, {
          access_token: accessToken,
          expires_in: 300,
          id_token: idToken,
          scope: 'openid profile email dingtalk',
          token_type: 'Bearer',
        });
      }

      if (request.method === 'GET' && path === '/application/o/aihub/userinfo') {
        log.userinfoRequests += 1;
        const authorization = request.headers.authorization ?? '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!accessTokens.has(token)) return fail(response, 'invalid_token', 'bearer rejected');
        return sendJson(response, 200, {
          'dingtalk_title': 'Engineering Director',
          'dingtalk_user_id': 'dt-e2e-001',
          'email': 'dora.ding@example.test',
          'email_verified': true,
          'https://fintlabs.cloud/claims/dingtalk_user_id': 'dt-e2e-001',
          'https://fintlabs.cloud/claims/title': 'Engineering Director',
          'name': 'Dora Ding',
          'picture': 'https://cdn.example.test/dora.png',
          'preferred_username': 'dora.ding',
          'sub': AUTHENTIK_FIXTURE_SUBJECT,
        });
      }

      log.failedRequests += 1;
      response.writeHead(404).end();
    },
  );

  const port = await listen(server);
  return {
    caCertificatePath: tls.caCertificate,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(tls.directory, { force: true, recursive: true });
    },
    issuer: AUTHENTIK_FIXTURE_ISSUER,
    log,
    port,
    tlsOrigin: `https://127.0.0.1:${port}`,
  };
};
