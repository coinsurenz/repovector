import { git } from './exec';

export interface Commit {
  sha: string;
  author: string;
  authoredAt: string;
  /** Epoch seconds, for range filters. */
  authoredTs: number;
  parents: string[];
  subject: string;
  body: string;
  paths: string[];
}

const RS = '\x1e';
const US = '\x1f';
// Record separator, then fields separated by unit separators; the last field is followed by git's name-only list.
const FORMAT = `${RS}%H${US}%an${US}%aI${US}%P${US}%s${US}%b${US}`;

/**
 * Commits in `range` (e.g. "abc..HEAD" or "HEAD"), newest first, with the
 * paths each touched. Merge commits list no paths under --name-only; they are
 * kept with an empty list.
 */
export async function listCommits(root: string, range: string, maxCount?: number): Promise<Commit[]> {
  const args = ['log', `--format=${FORMAT}`, '--name-only', '--no-renames', ...(maxCount ? [`--max-count=${maxCount}`] : []), range, '--'];
  return parseLog(await git(root, args));
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of out.split(RS)) {
    if (record.trim() === '') continue;
    const fields = record.split(US);
    if (fields.length < 7) continue;
    const [sha, author, authoredAt, parents, subject, body, rest] = fields as [string, string, string, string, string, string, string];
    const paths = rest.split('\n').map((p) => p.trim()).filter(Boolean);
    commits.push({
      sha: sha.trim(),
      author,
      authoredAt,
      authoredTs: Math.floor(new Date(authoredAt).getTime() / 1000),
      parents: parents.split(' ').filter(Boolean),
      subject,
      body: body.trim(),
      paths,
    });
  }
  return commits;
}
