import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, importJWK, importSPKI, jwtVerify, type JWK, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Config } from './config';
import { ConfigError, HttpError } from './errors';

/** Who is calling, as established by the server's auth mode. */
export interface Principal {
  /** Token subject (a user id or email); "anonymous" or "shared-token" for the simpler modes. */
  sub: string;
  via: Config['server']['auth']['mode'];
  scopes: string[];
}

export type Authenticator = (authorization: string | undefined) => Promise<Principal>;

/** Signing algorithms accepted from an identity provider. `none` and HMAC are never accepted. */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384', 'EdDSA'];
const CLOCK_TOLERANCE_SECONDS = 30;

/** Path of the OAuth protected-resource metadata document (RFC 9728) that MCP clients read after a 401. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** The metadata document: which authorization server issues tokens for this resource, and with which scope. */
export function resourceMetadata(auth: Config['server']['auth']): Record<string, unknown> | null {
  if (auth.mode !== 'jwt') return null;
  return {
    resource: auth.audience,
    authorization_servers: [auth.issuer],
    scopes_supported: [auth.scope],
    bearer_methods_supported: ['header'],
    resource_name: 'repo-vector code search',
  };
}

/** WWW-Authenticate value for a 401, pointing JWT clients at the metadata document. */
function challenge(auth: Config['server']['auth'], error?: { code: string; description: string }): Record<string, string> {
  const params: string[] = [];
  if (auth.mode === 'jwt') params.push(`resource_metadata="${new URL(RESOURCE_METADATA_PATH, auth.audience!).href}"`, `scope="${auth.scope}"`);
  if (error) params.push(`error="${error.code}"`, `error_description="${error.description.replace(/"/g, "'")}"`);
  return { 'WWW-Authenticate': params.length > 0 ? `Bearer ${params.join(', ')}` : 'Bearer' };
}

const bearerOf = (header: string | undefined): string => (header?.startsWith('Bearer ') ? header.slice(7).trim() : '');

/** Build the authenticator for the configured mode. Key material is loaded once, here. */
export async function createAuthenticator(auth: Config['server']['auth'], repo: string | null): Promise<Authenticator> {
  if (auth.mode === 'none') return async () => ({ sub: 'anonymous', via: 'none', scopes: [] });

  if (auth.mode === 'token') {
    // Compare digests so the comparison is constant-time whatever the lengths.
    const expected = createHash('sha256').update(auth.token!).digest();
    return async (header) => {
      const given = bearerOf(header);
      if (given === '' || !timingSafeEqual(createHash('sha256').update(given).digest(), expected)) {
        throw new HttpError(401, 'Missing or wrong bearer token', challenge(auth));
      }
      return { sub: 'shared-token', via: 'token', scopes: [] };
    };
  }

  const key = await verificationKey(auth);
  return async (header) => {
    const token = bearerOf(header);
    if (token === '') throw new HttpError(401, 'Sign-in required: send an access token as "Authorization: Bearer <token>"', challenge(auth));
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key, { issuer: auth.issuer!, audience: auth.audience!, algorithms: ALGORITHMS, clockTolerance: CLOCK_TOLERANCE_SECONDS, requiredClaims: ['exp', 'sub'] }));
    } catch (err) {
      const description = describeJwtFailure(err);
      throw new HttpError(401, `Access token rejected: ${description}`, challenge(auth, { code: 'invalid_token', description }));
    }
    const scopes = scopesOf(payload);
    if (!scopes.includes(auth.scope)) {
      throw new HttpError(403, `Access token lacks the "${auth.scope}" scope`, challenge(auth, { code: 'insufficient_scope', description: `requires ${auth.scope}` }));
    }
    if (auth.reposClaim && repo) {
      const allowed = listClaim(payload[auth.reposClaim]);
      if (!allowed.some((r) => r.toLowerCase() === repo.toLowerCase())) {
        throw new HttpError(403, `Access token does not grant repository ${repo}`, challenge(auth, { code: 'insufficient_scope', description: `no access to ${repo}` }));
      }
    }
    return { sub: String(payload.sub), via: 'jwt', scopes };
  };
}

/** A JWKS endpoint (keys fetched and cached by jose, rotated automatically) or one static public key. */
async function verificationKey(auth: Config['server']['auth']): Promise<JWTVerifyGetKey | Awaited<ReturnType<typeof importSPKI>>> {
  if (auth.jwksUrl) return createRemoteJWKSet(new URL(auth.jwksUrl), { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000 });
  const raw = auth.publicKey!.trim();
  try {
    if (raw.startsWith('-----BEGIN')) return await importSPKI(raw.replace(/\\n/g, '\n'), auth.publicKeyAlg ?? 'RS256');
    const jwk = JSON.parse(raw) as JWK;
    if (jwk.d !== undefined) throw new ConfigError('REPO_VECTOR_JWT_PUBLIC_KEY holds a private key; give the server only the public half');
    const imported = await importJWK(jwk, jwk.alg ?? auth.publicKeyAlg ?? (jwk.kty === 'OKP' ? 'EdDSA' : 'RS256'));
    if (imported instanceof Uint8Array) throw new ConfigError('REPO_VECTOR_JWT_PUBLIC_KEY is a symmetric key; only asymmetric (RSA, EC, Ed25519) keys are accepted');
    return imported;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`REPO_VECTOR_JWT_PUBLIC_KEY is not a usable public key (PEM or JWK JSON): ${(err as Error).message}`);
  }
}

/** OAuth `scope` is a space-separated string; Entra ID uses `scp`, sometimes as an array. */
function scopesOf(payload: JWTPayload): string[] {
  return [...listClaim(payload.scope), ...listClaim(payload.scp)];
}

function listClaim(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

function describeJwtFailure(err: unknown): string {
  const code = (err as { code?: string }).code ?? '';
  const claim = (err as { claim?: string }).claim;
  if (code === 'ERR_JWT_EXPIRED') return 'it has expired; sign in again';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'aud') return 'it was issued for a different service (audience)';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'iss') return 'it was issued by an untrusted issuer';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'nbf') return 'it is not valid yet';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') return `claim "${claim}" is missing or invalid`;
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || code === 'ERR_JWKS_NO_MATCHING_KEY') return 'the signature does not match a trusted key';
  if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') return 'it is signed with an algorithm this server does not accept';
  if (code === 'ERR_JWS_INVALID' || code === 'ERR_JWT_INVALID') return 'it is not a well-formed JWT';
  if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JOSE_GENERIC') return 'the identity provider keys could not be fetched';
  return 'it could not be verified';
}
