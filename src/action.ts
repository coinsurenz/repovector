import { appendFileSync } from 'node:fs';
import { errorMessage } from './errors';
import { indexRepository } from './indexer';
import { createLogger } from './log';
import { actionOutputs, summaryMarkdown } from './report';

/**
 * GitHub Action entry: index the checked-out repository, write outputs and a
 * job summary, exit 0. Any failure is one ::error:: line and exit 1, and the
 * sentinel is not advanced, so the next push repeats the work safely.
 */
async function main(): Promise<number> {
  const log = createLogger();
  // Mask before anything else is printed, even before the configuration is parsed.
  for (const key of ['PINECONE_API_KEY', 'DATABASE_URL', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'REPO_VECTOR_SERVER_TOKEN']) {
    const value = process.env[key]?.trim();
    if (value) log.mask(value);
  }
  try {
    const outcome = await indexRepository({ log });
    const out = process.env.GITHUB_OUTPUT;
    if (out) appendFileSync(out, Object.entries(actionOutputs(outcome)).map(([k, v]) => `${k}=${v}\n`).join(''));
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${summaryMarkdown(outcome)}\n`);
    log.info(`Done: code ${outcome.code.mode}${outcome.history ? `, history ${outcome.history.mode}` : ''} at ${outcome.sha.slice(0, 7)}`);
    return 0;
  } catch (err) {
    log.error(errorMessage(err));
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
