import { HttpError } from '../errors';

export interface EmbedResult {
  vectors: number[][];
  /** Tokens billed for the request, when the provider reports them. */
  tokens: number;
}

/** Computes vectors outside the store. Tests substitute a fake. */
export interface EmbeddingClient {
  readonly name: string;
  embed(model: string, inputs: string[], dimensions?: number): Promise<EmbedResult>;
  probeDimension(model: string, dimensions?: number): Promise<number>;
}

export interface OpenAICompatibleOptions {
  /** Shown in error messages: "OpenRouter", "OpenAI". */
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Extra fields merged into every embeddings request body. */
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding: number[]; index?: number }>;
  usage?: { total_tokens?: number; prompt_tokens?: number };
}

const PROBE_TEXT = 'dimension probe';

/** Client for any `POST {baseUrl}/embeddings` endpoint in the OpenAI shape (OpenAI, OpenRouter, and compatible gateways). */
export class OpenAICompatibleClient implements EmbeddingClient {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(model: string, inputs: string[], dimensions?: number): Promise<EmbedResult> {
    if (inputs.length === 0) return { vectors: [], tokens: 0 };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}`, ...this.opts.extraHeaders },
        body: JSON.stringify({ model, input: inputs, encoding_format: 'float', ...(dimensions ? { dimensions } : {}), ...this.opts.extraBody }),
      });
    } catch (err) {
      throw new HttpError(503, `Could not reach ${this.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw await toHttpError(this.name, res, model);
    const body = (await res.json()) as EmbeddingsResponse;
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== inputs.length) throw new HttpError(502, `${this.name} returned ${data.length} embeddings for ${inputs.length} inputs`);
    return { vectors: data.map((d) => d.embedding), tokens: body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0 };
  }

  async probeDimension(model: string, dimensions?: number): Promise<number> {
    const { vectors } = await this.embed(model, [PROBE_TEXT], dimensions);
    const dimension = vectors[0]?.length ?? 0;
    if (dimension === 0) throw new HttpError(502, `${this.name} returned an empty embedding for ${model}`);
    return dimension;
  }
}

async function toHttpError(name: string, res: Response, model: string): Promise<HttpError> {
  const detail = await res
    .json()
    .then((b) => {
      const error = (b as { error?: { message?: string } | string }).error;
      return typeof error === 'string' ? error : (error?.message ?? '');
    })
    .catch(() => '');
  const suffix = detail ? `: ${detail}` : '';
  if (res.status === 401) return new HttpError(401, `${name} rejected the API key${suffix}`);
  if (res.status === 402) return new HttpError(402, `${name} account needs credit${suffix}`);
  if (res.status === 404) return new HttpError(400, `${name} does not know the model "${model}"${suffix}`);
  if (res.status === 429) return new HttpError(429, `${name} rate limit hit${suffix}`);
  if (res.status >= 500) return new HttpError(502, `${name} error ${res.status}${suffix}`);
  return new HttpError(400, `${name} rejected the request${suffix}`);
}

export function openRouterClient(apiKey: string, dataCollection: 'deny' | 'allow', fetchImpl?: typeof fetch): EmbeddingClient {
  return new OpenAICompatibleClient({
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    // Route only to providers that do not retain inputs, unless the user widened it.
    extraBody: { provider: { data_collection: dataCollection } },
    extraHeaders: { 'X-Title': 'repo-vector' },
    fetchImpl,
  });
}

export function openAIClient(apiKey: string, baseUrl: string, fetchImpl?: typeof fetch): EmbeddingClient {
  return new OpenAICompatibleClient({ name: 'OpenAI', baseUrl, apiKey, fetchImpl });
}
