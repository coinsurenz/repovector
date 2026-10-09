export interface ChunkOptions {
  /** Target chunk length in characters. */
  size: number;
  /** Characters of the previous chunk repeated at the start of the next one. */
  overlap: number;
}

export interface TextChunk {
  text: string;
  /** Inclusive start offset into the source text. */
  start: number;
  /** Exclusive end offset into the source text. */
  end: number;
}

/** Boundary preferences, strongest first. Each is searched backwards from the cut point. */
const BOUNDARIES = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];

/**
 * Sliding-window chunker that snaps cut points to natural boundaries
 * (paragraph > line > sentence > clause > word) and overlaps consecutive
 * chunks. Every character of the input lies inside at least one chunk's
 * [start, end) range, so nothing is lost; whitespace-only chunks are dropped.
 */
export function chunkTextWithOffsets(text: string, opts: ChunkOptions): TextChunk[] {
  validate(opts);
  const chunks: TextChunk[] = [];
  const len = text.length;
  let start = 0;

  while (start < len) {
    const hardEnd = Math.min(start + opts.size, len);
    const end = hardEnd < len ? snapToBoundary(text, start, hardEnd) : hardEnd;
    const piece = text.slice(start, end);
    if (piece.trim().length > 0) chunks.push({ text: piece.trim(), start, end });
    if (end >= len) break;
    start = Math.max(end - opts.overlap, start + 1);
  }
  return chunks;
}

export function chunkText(text: string, opts: ChunkOptions): string[] {
  return chunkTextWithOffsets(text, opts).map((c) => c.text);
}

function validate(opts: ChunkOptions): void {
  if (!Number.isInteger(opts.size) || opts.size < 1) throw new Error('chunk size must be a positive integer');
  if (!Number.isInteger(opts.overlap) || opts.overlap < 0) throw new Error('chunk overlap must be a non-negative integer');
  if (opts.overlap >= opts.size) throw new Error('chunk overlap must be smaller than chunk size');
}

/** Find the best boundary in the back half of [start, hardEnd]; fall back to the hard cut. */
function snapToBoundary(text: string, start: number, hardEnd: number): number {
  const floor = start + Math.floor((hardEnd - start) / 2);
  for (const marker of BOUNDARIES) {
    const idx = text.lastIndexOf(marker, hardEnd - 1);
    if (idx >= floor) return idx + marker.length;
  }
  return hardEnd;
}
