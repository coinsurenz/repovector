import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { RESOURCE_METADATA_PATH, createAuthenticator, resourceMetadata, type Authenticator, type Principal } from './auth';
import { createClient, type RepoVectorClient } from './client';
import { loadConfig, type Config } from './config';
import { ConfigError, HttpError, errorMessage } from './errors';
import { createLogger, type Logger } from './log';
import { createMcpServer } from './mcp';

const MAX_BODY_BYTES = 64 * 1024;

const filterValue = z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown()), z.array(z.unknown())]);
const SearchBody = z.object({
  query: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).optional(),
  branch: z.string().max(200).optional(),
  language: z.string().max(50).optional(),
  ext: z.string().max(20).optional(),
  fileName: z.string().max(300).optional(),
  symbolKind: z.string().max(100).optional(),
  pathPrefix: z.string().max(500).optional(),
  filter: z.record(filterValue).optional(),
  rerank: z.boolean().optional(),
}).strict();
const HistoryBody = z.object({
  query: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).optional(),
  branch: z.string().max(200).optional(),
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
  author: z.string().max(200).optional(),
}).strict();

export interface HandlerOptions {
  /** A client, or a way to get one; the server keeps answering /health while the index does not exist yet. */
  client: RepoVectorClient | (() => Promise<RepoVectorClient>);
  config: Pick<Config, 'store' | 'server'>;
  /** Checks the Authorization header on every route except /health and the metadata document. */
  authenticate: Authenticator;
  log: Logger;
}

/** Returned by a route that wrote the response itself (the MCP transport does). */
const HANDLED = Symbol('handled');

const RECONNECT_MS = 5000;

/** Cache the first client that opens; on failure remember why and try again at most every RECONNECT_MS. */
function lazyClient(source: HandlerOptions['client']): { get: () => Promise<RepoVectorClient>; peek: () => { client: RepoVectorClient | null; error: string | null } } {
  if (typeof source !== 'function') return { get: async () => source, peek: () => ({ client: source, error: null }) };
  let client: RepoVectorClient | null = null;
  let error: string | null = null;
  let lastAttempt = 0;
  let pending: Promise<RepoVectorClient> | null = null;
  const get = async (): Promise<RepoVectorClient> => {
    if (client) return client;
    if (error && Date.now() - lastAttempt < RECONNECT_MS) throw new HttpError(503, error);
    pending ??= source()
      .then((c) => {
        client = c;
        error = null;
        return c;
      })
      .catch((err: unknown) => {
        error = errorMessage(err);
        throw new HttpError(503, error);
      })
      .finally(() => {
        lastAttempt = Date.now();
        pending = null;
      });
    return pending;
  };
  return { get, peek: () => ({ client, error }) };
}

/** The request handler, separate from listening so tests can drive it on an ephemeral port. */
export type Handler = ((req: IncomingMessage, res: ServerResponse) => void) & {
  /** Open the client now (instead of on the first request); resolves with the reason when it cannot yet. */
  warm: () => Promise<{ client: RepoVectorClient | null; error: string | null }>;
  close: () => Promise<void>;
};

export function createHandler({ client, config, authenticate, log }: HandlerOptions): Handler {
  const clients = lazyClient(client);
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.on('finish', () => log.info(`${req.method} ${url.pathname} ${res.statusCode} ${Math.round(performance.now() - started)}ms`));
    if (config.server.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.server.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    route(req, res, url, clients.get, config, authenticate, log)
      .then((body) => {
        if (body !== HANDLED) send(res, 200, body);
      })
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : err instanceof ConfigError ? 400 : 500;
        // Expected states (503 not ready yet, 4xx) are in the access log line; only real faults get an error line.
        if (!(err instanceof HttpError) && status >= 500) log.error(`${req.method} ${url.pathname}: ${errorMessage(err)}`);
        if (err instanceof HttpError && (status === 401 || status === 403)) log.warn(`${req.method} ${url.pathname} refused: ${errorMessage(err)}`);
        const headers = err instanceof HttpError ? err.headers : {};
        send(res, status, { error: status >= 500 && !(err instanceof HttpError) ? 'Internal error; see the server log' : errorMessage(err) }, headers);
      });
  };
  return Object.assign(handler, {
    warm: async () => {
      await clients.get().catch(() => null);
      return clients.peek();
    },
    close: async () => {
      await clients.peek().client?.close();
    },
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  getClient: () => Promise<RepoVectorClient>,
  config: HandlerOptions['config'],
  authenticate: Authenticator,
  log: Logger,
): Promise<unknown> {
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') return {};
  if (url.pathname === '/health' && method === 'GET') {
    // 503 with the reason until the index exists (for example before the action's first run).
    const client = await getClient();
    return { ok: true, store: config.store, index: client.identity.index, namespace: client.identity.namespace };
  }
  if (url.pathname === RESOURCE_METADATA_PATH || url.pathname.startsWith(`${RESOURCE_METADATA_PATH}/`)) {
    const metadata = resourceMetadata(config.server.auth);
    if (!metadata || method !== 'GET') throw new HttpError(404, `No route ${url.pathname}`);
    return metadata;
  }
  const known = ['/status', '/search', '/history/search', '/mcp'];
  if (!known.includes(url.pathname)) throw new HttpError(404, `No route ${url.pathname}`);
  const principal = await authenticate(req.headers.authorization);
  const client = await getClient();
  if (url.pathname === '/mcp') return mcp(req, res, method, client, principal, log);
  audit(log, principal, url.pathname);
  if (url.pathname === '/status') {
    if (method !== 'GET') throw new HttpError(405, 'Use GET');
    return client.status();
  }
  if (method !== 'POST') throw new HttpError(405, 'Use POST');
  const body = await readJson(req);
  if (url.pathname === '/search') return client.search(parse(SearchBody, body));
  return client.searchHistory(parse(HistoryBody, body));
}

/**
 * MCP over Streamable HTTP, stateless: every POST gets a fresh server and
 * transport, so no session state lives here and any replica can answer.
 */
async function mcp(req: IncomingMessage, res: ServerResponse, method: string, client: RepoVectorClient, principal: Principal, log: Logger): Promise<typeof HANDLED> {
  if (method !== 'POST') throw new HttpError(405, 'This MCP endpoint is stateless: use POST', { Allow: 'POST' });
  const body = await readJson(req);
  for (const message of Array.isArray(body) ? body : [body]) {
    const m = message as { method?: string; params?: { name?: string } };
    if (m?.method === 'tools/call') audit(log, principal, `mcp ${m.params?.name ?? '?'}`);
  }
  const server = createMcpServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
  return HANDLED;
}

/** One line per authorised call: who, and which operation. Queries are never logged. */
function audit(log: Logger, principal: Principal, operation: string): void {
  if (principal.via === 'none') return;
  log.info(`audit sub=${JSON.stringify(principal.sub)} via=${principal.via} op=${operation}`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Send Content-Type: application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `Body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(json);
}

const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === '::1' || host === 'localhost';

/** `repo-vector serve`: refuse to listen beyond loopback without a token, then serve until stopped. */
export async function serve(env = process.env): Promise<Server> {
  const log = createLogger(env);
  const config = loadConfig(env);
  if (config.server.auth.mode === 'none' && !isLoopback(config.server.host)) {
    throw new ConfigError(`Refusing to listen on ${config.server.host} without authentication; set REPO_VECTOR_SERVER_TOKEN or REPO_VECTOR_AUTH=jwt, or REPO_VECTOR_SERVER_HOST=127.0.0.1`);
  }
  const authenticate = await createAuthenticator(config.server.auth, config.repo);
  // A container has no checkout: identity comes from REPO_VECTOR_REPO / _BRANCH / _NAMESPACE.
  const handler = createHandler({ client: () => createClient({ env, root: null, readOnly: true }), config, authenticate, log });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(config.server.port, config.server.host, resolve));
  log.info(`repo-vector API on http://${config.server.host}:${config.server.port} (${config.store}; auth ${config.server.auth.mode}; MCP at /mcp)`);
  const { client, error } = await handler.warm();
  if (client) log.info(`Serving index ${client.identity.index}, namespace ${client.identity.namespace}`);
  else log.warn(`Not ready yet: ${error}. /health answers 503 until it is; retrying on request.`);
  const stop = () => {
    server.close();
    void handler.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}
