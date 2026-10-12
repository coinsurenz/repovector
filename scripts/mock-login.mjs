#!/usr/bin/env node
// Stand-in for a company login server (an admin portal, Okta, Entra ID...), for testing
// REPO_VECTOR_AUTH=jwt without one. It holds an Ed25519 signing key and issues the same
// kind of short-lived, audience-bound access token a real identity provider would, so the
// server's real verification path (signature, issuer, audience, scope, expiry, repos) runs.
//
//   node scripts/mock-login.mjs init                      # make a key; prints the server settings
//   node scripts/mock-login.mjs token --sub you@example.com --aud https://code-search.example.com
//   node scripts/mock-login.mjs public-key                # print the public key again
//
// The private key stays in .mock-login/ (git-ignored). Never use this in production.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';

const DIR = path.resolve(process.env.MOCK_LOGIN_DIR ?? '.mock-login');
const KEY_FILE = path.join(DIR, 'key.json');
const DEFAULT_ISSUER = 'https://mock-login.invalid';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    sub: { type: 'string' },
    aud: { type: 'string' },
    iss: { type: 'string' },
    scope: { type: 'string', default: 'code:read' },
    repos: { type: 'string' },
    ttl: { type: 'string', default: '8h' },
    force: { type: 'boolean', default: false },
  },
});

const fail = (message) => {
  process.stderr.write(`mock-login: ${message}\n`);
  process.exit(1);
};

const load = () => {
  if (!existsSync(KEY_FILE)) fail(`no key yet; run "node scripts/mock-login.mjs init" first`);
  return JSON.parse(readFileSync(KEY_FILE, 'utf8'));
};

const command = positionals[0];
if (command === 'init') {
  if (existsSync(KEY_FILE) && !values.force) fail(`${KEY_FILE} already exists; pass --force to replace it (tokens signed with the old key stop working)`);
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const kid = `mock-${Date.now().toString(36)}`;
  const publicJwk = { ...(await exportJWK(publicKey)), alg: 'EdDSA', kid, use: 'sig' };
  const privateJwk = { ...(await exportJWK(privateKey)), alg: 'EdDSA', kid };
  const issuer = values.iss ?? DEFAULT_ISSUER;
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEY_FILE, JSON.stringify({ issuer, publicJwk, privateJwk }, null, 2), { mode: 0o600 });
  process.stdout.write(`Key written to ${KEY_FILE} (keep it private).\n\nServer settings:\n${serverSettings(issuer, publicJwk)}\n`);
} else if (command === 'public-key') {
  const { issuer, publicJwk } = load();
  process.stdout.write(`${serverSettings(issuer, publicJwk)}\n`);
} else if (command === 'token') {
  const { issuer, privateJwk } = load();
  if (!values.sub) fail('--sub is required (who is signing in, e.g. an email)');
  if (!values.aud) fail('--aud is required (the search service URL, the same as REPO_VECTOR_JWT_AUDIENCE)');
  const claims = { scope: values.scope };
  if (values.repos) claims.repos = values.repos.split(',').map((r) => r.trim()).filter(Boolean);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: privateJwk.kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(values.aud)
    .setSubject(values.sub)
    .setIssuedAt()
    .setExpirationTime(values.ttl)
    .setJti(crypto.randomUUID())
    .sign(await importJWK(privateJwk, 'EdDSA'));
  process.stdout.write(`${token}\n`);
} else {
  fail('usage: mock-login.mjs init [--iss URL] [--force] | token --sub WHO --aud URL [--scope code:read] [--repos owner/name,...] [--ttl 8h] | public-key');
}

function serverSettings(issuer, publicJwk) {
  return [
    'REPO_VECTOR_AUTH=jwt',
    `REPO_VECTOR_JWT_ISSUER=${issuer}`,
    'REPO_VECTOR_JWT_AUDIENCE=<this service URL, e.g. https://code-search.example.com>',
    `REPO_VECTOR_JWT_PUBLIC_KEY=${JSON.stringify(publicJwk)}`,
    'REPO_VECTOR_JWT_REPOS_CLAIM=repos   # optional: only tokens listing the repo may search it',
  ].join('\n');
}
