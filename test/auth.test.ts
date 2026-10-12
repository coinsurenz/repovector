import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { SignJWT, exportJWK, exportSPKI, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { createAuthenticator, resourceMetadata } from '../src/auth';
import { loadConfig, type Config } from '../src/config';
import { HttpError } from '../src/errors';

const ISSUER = 'https://login.example.test';
const AUDIENCE = 'https://code-search.example.test';

function jwtAuth(over: Partial<Config['server']['auth']>): Config['server']['auth'] {
  return { mode: 'jwt', token: null, issuer: ISSUER, audience: AUDIENCE, jwksUrl: null, publicKey: null, publicKeyAlg: null, scope: 'code:read', reposClaim: null, ...over };
}

async function sign(key: CryptoKey, alg: string, claims: Record<string, unknown> = {}, opts: { iss?: string; aud?: string; sub?: string; exp?: string | number; kid?: string } = {}): Promise<string> {
  const jwt = new SignJWT({ scope: 'code:read', ...claims })
    .setProtectedHeader({ alg, kid: opts.kid })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '10m');
  if (opts.sub !== '') jwt.setSubject(opts.sub ?? 'ada@example.test');
  return jwt.sign(key);
}

/** Resolves with the HttpError the authenticator threw, so tests can check status, message and headers. */
async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the token to be refused');
}

describe('JWT authentication (static Ed25519 public key)', () => {
  let priv: CryptoKey;
  let publicJwk: JWK;
  let authenticate: Awaited<ReturnType<typeof createAuthenticator>>;

  before(async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    priv = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), alg: 'EdDSA' };
    authenticate = await createAuthenticator(jwtAuth({ publicKey: JSON.stringify(publicJwk), reposClaim: 'repos' }), 'coinsurenz/job-poller');
  });

  test('a valid token yields the signed-in subject and scopes', async () => {
    const token = await sign(priv, 'EdDSA', { repos: ['coinsurenz/job-poller'] });
    const who = await authenticate(`Bearer ${token}`);
    assert.deepEqual(who, { sub: 'ada@example.test', via: 'jwt', scopes: ['code:read'] });
  });

  test('no token: 401 that points the client at the metadata document', async () => {
    const err = await refusal(authenticate(undefined));
    assert.equal(err.status, 401);
    assert.match(err.headers['WWW-Authenticate']!, /^Bearer resource_metadata="https:\/\/code-search\.example\.test\/\.well-known\/oauth-protected-resource", scope="code:read"$/);
  });

  test('each broken property is refused with its own reason', async () => {
    const cases: Array<[string, Promise<string>, number, RegExp]> = [
      ['expired', sign(priv, 'EdDSA', { repos: ['coinsurenz/job-poller'] }, { exp: Math.floor(Date.now() / 1000) - 120 }), 401, /expired/],
      ['other audience', sign(priv, 'EdDSA', { repos: ['coinsurenz/job-poller'] }, { aud: 'https://payments-api.example.test' }), 401, /different service/],
      ['other issuer', sign(priv, 'EdDSA', { repos: ['coinsurenz/job-poller'] }, { iss: 'https://evil.example.test' }), 401, /untrusted issuer/],
      ['no subject', sign(priv, 'EdDSA', { repos: ['coinsurenz/job-poller'] }, { sub: '' }), 401, /"sub"/],
      ['missing scope', sign(priv, 'EdDSA', { scope: 'payments:write', repos: ['coinsurenz/job-poller'] }), 403, /lacks the "code:read" scope/],
      ['other repository', sign(priv, 'EdDSA', { repos: ['coinsurenz/other'] }), 403, /does not grant repository coinsurenz\/job-poller/],
      ['no repos claim', sign(priv, 'EdDSA'), 403, /does not grant repository/],
    ];
    for (const [name, token, status, reason] of cases) {
      const err = await refusal(authenticate(`Bearer ${await token}`));
      assert.equal(err.status, status, name);
      assert.match(err.message, reason, name);
      assert.match(err.headers['WWW-Authenticate']!, status === 401 ? /error="invalid_token"/ : /error="insufficient_scope"/, name);
    }
  });

  test('a token signed by another key, or with "alg: none", is refused', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const forged = await sign(other.privateKey, 'EdDSA', { repos: ['coinsurenz/job-poller'] });
    assert.match((await refusal(authenticate(`Bearer ${forged}`))).message, /signature does not match/);
    const [, payload] = forged.split('.');
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${payload}.`;
    assert.equal((await refusal(authenticate(`Bearer ${unsigned}`))).status, 401);
    assert.equal((await refusal(authenticate('Bearer not-a-jwt'))).status, 401);
    assert.equal((await refusal(authenticate(`Basic ${forged}`))).status, 401, 'only the Bearer scheme is read');
  });

  test('Entra-style scp arrays and space-separated scope strings both count', async () => {
    const auth = await createAuthenticator(jwtAuth({ publicKey: JSON.stringify(publicJwk) }), 'coinsurenz/job-poller');
    assert.deepEqual((await auth(`Bearer ${await sign(priv, 'EdDSA', { scope: undefined, scp: ['openid', 'code:read'] })}`)).scopes, ['openid', 'code:read']);
    assert.deepEqual((await auth(`Bearer ${await sign(priv, 'EdDSA', { scope: 'openid code:read' })}`)).scopes, ['openid', 'code:read']);
  });

  test('a private or symmetric key is rejected as server configuration', async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    await assert.rejects(createAuthenticator(jwtAuth({ publicKey: JSON.stringify(await exportJWK(pair.privateKey)) }), null), /holds a private key/);
    await assert.rejects(createAuthenticator(jwtAuth({ publicKey: JSON.stringify({ kty: 'oct', k: 'c2VjcmV0', alg: 'HS256' }) }), null), /not a usable public key|symmetric/);
    await assert.rejects(createAuthenticator(jwtAuth({ publicKey: 'garbage' }), null), /not a usable public key/);
  });
});

describe('JWT authentication (JWKS endpoint, RS256, PEM)', () => {
  let priv: CryptoKey;
  let jwks: Server;
  let jwksUrl: string;

  before(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    priv = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1', use: 'sig' };
    jwks = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })));
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
    jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`;
  });
  after(() => {
    jwks.close();
  });

  test('keys are fetched from the identity provider and matched by kid', async () => {
    const auth = await createAuthenticator(jwtAuth({ jwksUrl }), null);
    assert.equal((await auth(`Bearer ${await sign(priv, 'RS256', {}, { kid: 'k1' })}`)).sub, 'ada@example.test');
    assert.equal((await refusal(auth(`Bearer ${await sign(priv, 'RS256', {}, { kid: 'unknown' })}`))).status, 401);
  });

  test('a PEM public key works too', async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const auth = await createAuthenticator(jwtAuth({ publicKey: await exportSPKI(pair.publicKey) }), null);
    assert.equal((await auth(`Bearer ${await sign(pair.privateKey, 'RS256')}`)).via, 'jwt');
  });
});

describe('shared token and no-auth modes', () => {
  test('token mode compares in constant time and challenges without metadata', async () => {
    const auth = await createAuthenticator({ ...jwtAuth({}), mode: 'token', token: 's3cret' }, null);
    assert.equal((await auth('Bearer s3cret')).via, 'token');
    const err = await refusal(auth('Bearer nope'));
    assert.equal(err.status, 401);
    assert.equal(err.headers['WWW-Authenticate'], 'Bearer');
  });

  test('metadata exists only in jwt mode', () => {
    assert.equal(resourceMetadata({ ...jwtAuth({}), mode: 'token' }), null);
    assert.deepEqual(resourceMetadata(jwtAuth({})), {
      resource: AUDIENCE, authorization_servers: [ISSUER], scopes_supported: ['code:read'], bearer_methods_supported: ['header'], resource_name: 'repo-vector code search',
    });
  });
});

describe('auth configuration', () => {
  const base = { REPO_VECTOR_STORE: 'pinecone', PINECONE_API_KEY: 'x' };

  test('mode defaults: token when a token is set, otherwise none', () => {
    assert.equal(loadConfig(base).server.auth.mode, 'none');
    assert.equal(loadConfig({ ...base, REPO_VECTOR_SERVER_TOKEN: 't' }).server.auth.mode, 'token');
  });

  test('jwt mode lists every missing setting at once', () => {
    assert.throws(() => loadConfig({ ...base, REPO_VECTOR_AUTH: 'jwt' }), (err: Error) => {
      assert.match(err.message, /REPO_VECTOR_JWT_ISSUER is required/);
      assert.match(err.message, /REPO_VECTOR_JWT_AUDIENCE is required/);
      assert.match(err.message, /exactly one of REPO_VECTOR_JWT_JWKS_URL or REPO_VECTOR_JWT_PUBLIC_KEY/);
      return true;
    });
    assert.throws(() => loadConfig({ ...base, REPO_VECTOR_AUTH: 'token' }), /REPO_VECTOR_SERVER_TOKEN is required/);
  });

  test('a complete jwt configuration loads', () => {
    const cfg = loadConfig({ ...base, REPO_VECTOR_AUTH: 'jwt', REPO_VECTOR_JWT_ISSUER: ISSUER, REPO_VECTOR_JWT_AUDIENCE: AUDIENCE, REPO_VECTOR_JWT_JWKS_URL: `${ISSUER}/jwks`, REPO_VECTOR_JWT_REPOS_CLAIM: 'repos' });
    assert.equal(cfg.server.auth.issuer, ISSUER);
    assert.equal(cfg.server.auth.scope, 'code:read');
    assert.equal(cfg.server.auth.reposClaim, 'repos');
  });
});
