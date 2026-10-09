# repo-vector

A GitHub Action that keeps a vector index of your repository current after every push, in Pinecone or in any Postgres with pgvector. A small CLI, an HTTP API and an MCP server let people and agents search it by meaning: "where are webhook signatures verified", "when did refunds start retrying".

It works like a deploy step. The workflow checks out the branch, the action reads its settings from `env:`, embeds the checkout into the vector database you named, and reports success or failure. After the first run it only re-embeds the files a push changed.

## Add it to a repository

1. Add a secret: `PINECONE_API_KEY` (or `DATABASE_URL` for Postgres, plus `OPENROUTER_API_KEY` or `OPENAI_API_KEY`).
2. Add `.github/workflows/repo-vector.yml`:

```yaml
name: repo-vector
on:
  push:
    branches: [main, dev]
concurrency:
  group: repo-vector-${{ github.ref }}
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  index:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: <owner>/repo-vector@v1
        env:
          REPO_VECTOR_STORE: pinecone
          PINECONE_API_KEY: ${{ secrets.PINECONE_API_KEY }}
          REPO_VECTOR_CREATE_INDEX: "true"
          REPO_VECTOR_EMBEDDING_PROVIDER: pinecone
          REPO_VECTOR_EMBEDDING_MODEL: llama-text-embed-v2
```

That is all. The index is named after the repository, and each branch gets its own namespace (`<owner>-<repo>--<branch>`), with commit history beside it in `<namespace>-history`.

`fetch-depth: 0` matters: incremental runs diff against the last indexed commit, and the history index reads `git log`. A merged pull request is a push, so `on: push` covers merges and direct pushes alike.

### Postgres instead of Pinecone

```yaml
        env:
          REPO_VECTOR_STORE: postgres
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          REPO_VECTOR_EMBEDDING_PROVIDER: openrouter
          REPO_VECTOR_EMBEDDING_MODEL: openai/text-embedding-3-small
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Any Postgres with the `vector` extension works: your own, Supabase, Neon, RDS, or the bundled `docker-compose.yml`. The table is created on the first run. Postgres cannot embed text, so pair it with `openrouter` or `openai`.

### Reaching the database from CI

The action runs on the runner, so `DATABASE_URL` must be reachable from there. A GitHub-hosted runner (`ubuntu-latest`) is a VM in GitHub's cloud with no route into your network, and its IP ranges are too many and too changeable to allowlist. Pick one:

- **Managed Postgres** (Supabase, Neon, RDS) with a public TLS endpoint: store its URL, with `?sslmode=require`, as the secret and keep `ubuntu-latest`.
- **A self-hosted runner** on the machine running the compose stack, so the database never leaves that host (steps below).
- **A tunnel step** before the action (for example a VPN or Tailscale action) so a hosted runner joins your private network for the job.

Do not publish the compose database on the internet: the `pgvector/pgvector` image has no TLS, so `sslmode=require` fails against it and the password would cross the network in the clear.

#### Self-hosted runner beside the compose stack

1. **Start the stack** on the host: `cp .env.example .env`, fill it in, `docker compose up -d`. Postgres listens on `127.0.0.1:5432` only (`POSTGRES_BIND`).
2. **Register a runner.** In the repository, open Settings › Actions › Runners › New self-hosted runner, choose Linux (or the host's OS), and run the download and `./config.sh --url ... --token ...` commands it shows on the same host. When asked for labels, add `repo-vector`.
3. **Run it as a service** so it survives reboots: `sudo ./svc.sh install && sudo ./svc.sh start`. The runner only makes outbound HTTPS connections to GitHub; no inbound port is opened.
4. **Install git** on the host. Nothing else is needed: the runner ships its own Node, and keeps itself up to date (the action needs a runner recent enough for `node24`).
5. **Add the secret** `DATABASE_URL` = `postgres://repo_vector:<POSTGRES_PASSWORD>@127.0.0.1:5432/vectors`, plus the provider key.
6. **Point the workflow at it:**

```yaml
jobs:
  index:
    runs-on: [self-hosted, repo-vector]
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: <owner>/repo-vector@v1
        env:
          REPO_VECTOR_STORE: postgres
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          REPO_VECTOR_EMBEDDING_PROVIDER: openrouter
          REPO_VECTOR_EMBEDDING_MODEL: openai/text-embedding-3-small
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Use self-hosted runners with private repositories only. On a public repository, a pull request from a fork can run workflow code on your machine.

### Embedding providers

| Store | `pinecone` (hosted) | `openrouter` | `openai` |
|---|---|---|---|
| Pinecone | yes | yes | yes |
| Postgres | no | yes | yes |

- **pinecone**: the index embeds the text itself (`llama-text-embed-v2`, `multilingual-e5-large`). One secret.
- **openrouter**: any model on <https://openrouter.ai/models?output_modalities=embeddings>. Requests go only to providers that do not retain inputs unless you set `REPO_VECTOR_OPENROUTER_DATA_COLLECTION=allow`.
- **openai**: OpenAI's embeddings API, or any OpenAI-compatible endpoint via `OPENAI_BASE_URL`.

The action checks that the index fits the model before writing anything (a hosted index for `pinecone`, a vectors-only index of the model's dimension otherwise) and stops with the reason if not.

## Search it

The query side needs only the store credentials (plus the provider key for `openrouter` or `openai`); the model is read from what the action recorded.

```bash
npm install -g repo-vector
export REPO_VECTOR_STORE=pinecone PINECONE_API_KEY=...
cd your-repo                      # repository and branch are read from the checkout
repo-vector search "where are webhook signatures verified" --language typescript
repo-vector history "when did refunds start retrying" --since 2026-01-01
repo-vector status
```

`--branch dev` searches another branch's namespace, `--path apps/api` narrows by folder, `--json` prints the raw response, `--rerank` uses Pinecone's hosted reranker.

### MCP (Claude Code and other agents)

```bash
claude mcp add repo-vector -e REPO_VECTOR_STORE=pinecone -e PINECONE_API_KEY=... -e REPO_VECTOR_REPO=owner/name -e REPO_VECTOR_BRANCH=main -- npx -y repo-vector mcp
```

Tools: `search_code`, `search_history`, `index_status`. Treat the results as a first hop: open the files they point at, and grep for the exhaustive answer.

### HTTP API (Docker)

```bash
cp .env.example .env        # POSTGRES_PASSWORD, REPO_VECTOR_SERVER_TOKEN, REPO_VECTOR_REPO, provider key
docker compose up -d        # pgvector on 127.0.0.1:5432, the API on 8080
curl -s localhost:8080/search -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"where are webhook signatures verified","topK":5}'
```

| Route | Auth | Body |
|---|---|---|
| `GET /health` | none | |
| `GET /status` | bearer | |
| `POST /search` | bearer | `{ query, topK?, branch?, language?, ext?, fileName?, symbolKind?, pathPrefix?, filter?, rerank? }` |
| `POST /history/search` | bearer | `{ query, topK?, branch?, since?, until?, author? }` |

The server will not listen beyond 127.0.0.1 without `REPO_VECTOR_SERVER_TOKEN`. For Pinecone, run the image with `REPO_VECTOR_STORE=pinecone` and `PINECONE_API_KEY` instead of the compose database.


## What gets indexed

Every file `git ls-files` lists, except: build output, dependencies, lockfiles, minified and generated files (`DEFAULT_EXCLUDES` in `src/git/files.ts`), anything credential-shaped (`.env*`, keys, `credentials`, `secrets.*`; this list cannot be switched off), files over `REPO_VECTOR_MAX_FILE_KB`, binaries, and non-text extensions. Add your own excludes with `REPO_VECTOR_EXCLUDE="**/*.snap,docs/archive/**"`.

Code in 17 languages (TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Dart, C#, C, C++, Ruby, PHP, Swift, Scala, Lua) is split with tree-sitter: one chunk per function, class or method, small neighbours packed together, and each chunk starts with a `path › class › symbol` line so the embedding knows where it lives. Everything else uses a sliding window.

Each record carries `source` (relative path), `language`, `symbol`, `symbol_kind`, `start_line`, `end_line`, `commit` and `branch`, so hits point straight at the code.

### When it re-indexes everything

The first run, and whenever the chunker version, the excludes or size settings, or the embedding model change; when the last indexed commit is no longer in the branch's history (force push, rebase); when a push touches more than `REPO_VECTOR_MAX_DIFF_RATIO` of the files; or when `REPO_VECTOR_FULL_REINDEX=true`. A full run writes everything, then deletes what it did not write, so the index is never empty part-way through.

A failed run exits 1 and leaves the recorded commit where it was, so the next push repeats the work. Record ids are deterministic, so repeating is safe.

### Try it first

```bash
repo-vector index --dry-run      # mode, files, records and estimated tokens; writes nothing
```

## Configuration

Everything is an environment variable; `.env.example` lists them all with defaults. The ones you are most likely to set:

| Variable | Default |
|---|---|
| `REPO_VECTOR_STORE` | required: `pinecone` or `postgres` |
| `REPO_VECTOR_INDEX` | the repository name |
| `REPO_VECTOR_CREATE_INDEX` | `false` (Pinecone only; Postgres tables are always created) |
| `REPO_VECTOR_EMBEDDING_PROVIDER`, `_MODEL` | required for indexing |
| `REPO_VECTOR_EXCLUDE` | none |
| `REPO_VECTOR_HISTORY` | `true` |
| `REPO_VECTOR_EMBED_TOKENS_PER_MINUTE` | 250000 for Pinecone hosted (the Starter limit), unpaced otherwise |
| `REPO_VECTOR_REPO`, `REPO_VECTOR_BRANCH` | from `GITHUB_*` in CI, from the checkout locally; set them where there is no checkout |

Outputs: `mode`, `sha`, `namespace`, `files_indexed`, `files_removed`, `records_upserted`, `records_deleted`, `commits_indexed`. The job summary shows the same as a table.

## Security

- The index holds your source in plain text. Treat the store credentials like read access to the repository: a dedicated Pinecone project per organisation, and a region chosen on purpose (for example `eu-west-1`).
- Secrets come only from `env:`. The action masks them before printing anything and never logs them.
- The workflow needs `contents: read` and nothing else.
- Commit authors are stored by name, never by email.

## Costs

For a 2,500-file monorepo (about 2.9 million tokens): a full index takes 3 to 5 minutes and costs about $0.50 with `llama-text-embed-v2` or $0.06 with `text-embedding-3-small`. A typical merge touches a few files: seconds, a fraction of a cent.

## Development

```bash
npm ci
npm test                               # unit and fixture tests
TEST_DATABASE_URL=postgres://... npm test   # adds the live Postgres and bundled end-to-end suites
npm run typecheck
npm run build                          # dist/action.js, dist/cli.js, dist/tree-sitter.wasm, dist/grammars/
```

Releases commit `dist/` on the tag (`git add -f dist`), then move the `v1` tag.
