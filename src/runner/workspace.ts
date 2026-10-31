import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface Entry { kind: 'file' | 'symlink' | 'other'; hash?: string }

const SKIP = new Set(['node_modules', 'dist', '.git']);

/** Walks a tree without following symlinks and fingerprints regular files. */
export async function fingerprint(root: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  async function walk(dir: string) {
    for (const name of await readdir(dir)) {
      if (SKIP.has(name) && dir === root) continue;
      const abs = join(dir, name);
      const rel = relative(root, abs).split('\\').join('/');
      const st = await lstat(abs);
      if (st.isSymbolicLink()) out.set(rel, { kind: 'symlink' });
      else if (st.isDirectory()) await walk(abs);
      else if (st.isFile()) out.set(rel, { kind: 'file', hash: createHash('sha256').update(await readFile(abs)).digest('hex') });
      else out.set(rel, { kind: 'other' });
    }
  }
  await walk(root);
  return out;
}

export interface Change { path: string; kind: Entry['kind']; existedBefore: boolean; deleted: boolean }

export function diff(before: Map<string, Entry>, after: Map<string, Entry>): Change[] {
  const changes: Change[] = [];
  for (const [path, a] of after) {
    const b = before.get(path);
    if (!b || b.kind !== a.kind || b.hash !== a.hash) changes.push({ path, kind: a.kind, existedBefore: !!b, deleted: false });
  }
  for (const [path, b] of before) if (!after.has(path)) changes.push({ path, kind: b.kind, existedBefore: true, deleted: true });
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}
