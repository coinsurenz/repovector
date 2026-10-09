/** Rough token count for embedding models on mixed prose and code; errs on the high side. */
export const CHARS_PER_TOKEN = 3.5;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * Trailing-window limiter for embedding throughput. Pinecone's Starter plan
 * allows 250k tokens per minute per model; sending a large repository unpaced
 * returns 429 RESOURCE_EXHAUSTED. A null limit means unpaced.
 */
export class TokenRateLimiter {
  private used: Array<{ at: number; tokens: number }> = [];

  constructor(
    readonly limit: number | null,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Wait until `tokens` fit in the trailing 60 s window, then record them. Resolves with the milliseconds waited. */
  async take(tokens: number): Promise<number> {
    let waited = 0;
    for (;;) {
      const now = this.now();
      this.used = this.used.filter((u) => u.at > now - 60_000);
      const inWindow = this.used.reduce((n, u) => n + u.tokens, 0);
      // Unpaced, or fits; an oversized single request is allowed when the window is empty, since nothing smaller could ever send it.
      if (this.limit === null || inWindow + tokens <= this.limit || this.used.length === 0) {
        this.used.push({ at: now, tokens });
        return waited;
      }
      const oldest = this.used[0]!;
      const wait = Math.max(50, oldest.at + 60_000 - now + 50);
      await this.sleep(wait);
      waited += wait;
    }
  }
}
