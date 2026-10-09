import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createClient, type RepoVectorClient } from './client';
import { errorMessage } from './errors';
import { TOOL_VERSION } from './index/run';
import { formatHits } from './report';

const FIRST_HOP = 'Semantic search is a first hop: use the paths and line ranges it returns, then open and read those files (and grep) for the exhaustive answer.';

/** Build the MCP server around a client; separate from stdio wiring so tests can call the tools in-process. */
export function createMcpServer(client: RepoVectorClient): McpServer {
  const server = new McpServer({ name: 'repo-vector', version: TOOL_VERSION });

  server.registerTool(
    'search_code',
    {
      description: `Search this repository's code by meaning ("where are webhook signatures verified"). Returns ranked chunks with path, symbol and line range. ${FIRST_HOP}`,
      inputSchema: {
        query: z.string().min(1).describe('What you are looking for, in plain words'),
        topK: z.number().int().min(1).max(50).optional().describe('How many results (default 10)'),
        language: z.string().optional().describe('Only this language, e.g. typescript, python, go'),
        pathPrefix: z.string().optional().describe('Only files under this path, e.g. apps/api/src'),
        branch: z.string().optional().describe('Another indexed branch, e.g. dev'),
      },
    },
    async (args) => respond(() => client.search(args)),
  );

  server.registerTool(
    'search_history',
    {
      description: `Search this repository's commit history by meaning ("when did refunds start retrying"). Returns commits with sha, date, author and touched paths. ${FIRST_HOP}`,
      inputSchema: {
        query: z.string().min(1).describe('What changed, in plain words'),
        topK: z.number().int().min(1).max(50).optional(),
        since: z.string().optional().describe('ISO date, e.g. 2026-01-01'),
        until: z.string().optional().describe('ISO date'),
        author: z.string().optional().describe('Exact author name'),
        branch: z.string().optional(),
      },
    },
    async (args) => respond(() => client.searchHistory(args)),
  );

  server.registerTool(
    'index_status',
    { description: 'Which commit the index was last built from, when, with which embedding model, and which branches are indexed.', inputSchema: {} },
    async () => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await client.status(), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }
    },
  );
  return server;
}

async function respond(run: () => ReturnType<RepoVectorClient['search']>) {
  try {
    const res = await run();
    const hits = res.hits.map((h) => ({ path: h.source || undefined, startLine: h.startLine, endLine: h.endLine, symbol: h.symbol, score: Number(h.score.toFixed(4)), sha: h.metadata.sha, text: h.text }));
    return { content: [{ type: 'text' as const, text: `${formatHits(res, 12)}\n\n---\n${JSON.stringify({ namespace: res.namespace, hits }, null, 2)}` }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: errorMessage(err) }], isError: true };
  }
}

/** `repo-vector mcp`: stdio transport. Logs go to stderr; stdout carries only the protocol. */
export async function runMcp(): Promise<void> {
  const client = await createClient();
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
}
