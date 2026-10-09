# Changelog

## 0.1.0 (unreleased)

First version, built from `PLAN.md`.

- GitHub Action (`node24`) that indexes the checked-out repository into Pinecone or Postgres/pgvector on push, incrementally after the first run.
- Embedding with Pinecone hosted models, OpenRouter, or OpenAI and compatible endpoints.
- Syntax-aware chunks for 17 languages via tree-sitter; sliding window for everything else.
- Commit-history index, one record per commit, searchable with date and author filters.
- `repo-vector` CLI (`index`, `search`, `history`, `status`, `serve`, `mcp`), HTTP API with bearer auth, MCP server, Docker image and compose stack.
