# Changelog

## 0.2.0 (unreleased)

- MCP over HTTP at `/mcp` on the existing server (stateless Streamable HTTP), so Claude and other agents connect by URL.
- `REPO_VECTOR_AUTH=jwt`: per-user access tokens from any OIDC/OAuth identity provider, checked for signature (JWKS or a static public key), issuer, audience, expiry, scope and optionally allowed repositories. Serves `/.well-known/oauth-protected-resource` and sends `WWW-Authenticate` challenges so MCP clients can find the sign-in.
- The search side never migrates, so it runs on a `SELECT`-only database role.
- Audit line per authorised call (who and which operation; never the query).
- `scripts/mock-login.mjs`: a stand-in identity provider for testing the flow.
- New dependency: `jose` (JWT verification; no dependencies of its own).

## 0.1.1 (unreleased)

- Fix: on Node 24 (the action's runtime) indexing could be killed for running out of memory with no error printed. V8's optimising WebAssembly compiler briefly took about 2 GB while tree-sitter parsed even a small repository. The action and CLI now re-run themselves once with `--liftoff-only`, which keeps peak memory near 120 MB.

## 0.1.0 (unreleased)

First version, built from `PLAN.md`.

- GitHub Action (`node24`) that indexes the checked-out repository into Pinecone or Postgres/pgvector on push, incrementally after the first run.
- Embedding with Pinecone hosted models, OpenRouter, or OpenAI and compatible endpoints.
- Syntax-aware chunks for 17 languages via tree-sitter; sliding window for everything else.
- Commit-history index, one record per commit, searchable with date and author filters.
- `repo-vector` CLI (`index`, `search`, `history`, `status`, `serve`, `mcp`), HTTP API with bearer auth, MCP server, Docker image and compose stack.
