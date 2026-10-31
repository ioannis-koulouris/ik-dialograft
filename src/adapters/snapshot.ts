import type { GitHubPort } from './github.js';

/** Files the assessment agent may read from the pinned commit. */
export function isReadable(path: string): boolean {
  if (path.includes('..') || path.startsWith('/')) return false;
  return /^src\/.+\.ts$/.test(path) || /^migrations\/[\w-]+\.sql$/.test(path) || path === 'package.json' || path === 'README.md';
}

export interface Snapshot { commit: string; files: Map<string, string>; complete: boolean }

export async function loadSnapshot(gh: GitHubPort, commit: string, maxBytes = 400_000): Promise<Snapshot> {
  const entries = (await gh.listFiles(commit)).filter((e) => e.type === 'blob' && isReadable(e.path));
  const files = new Map<string, string>();
  let total = 0;
  let complete = true;
  for (const e of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    if (total + e.size > maxBytes) { complete = false; continue; }
    files.set(e.path, await gh.readBlob(e.sha));
    total += e.size;
  }
  return { commit, files, complete };
}

/** Evidence must be an exact substring of the named file in the snapshot. */
export const evidenceChecker = (s: Snapshot) => (path: string, quote: string) =>
  quote.trim().length >= 10 && (s.files.get(path)?.includes(quote) ?? false);
