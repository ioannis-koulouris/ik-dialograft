import { lstat, mkdir, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Persistent artifact storage confined to one root directory. */
export class ArtifactStore {
  constructor(readonly root: string) {}

  async write(tenantId: string, fileName: string, data: Buffer): Promise<{ relPath: string; sizeBytes: number }> {
    if (!/^[\w.-]+$/.test(fileName) || !/^[\w-]+$/.test(tenantId)) throw new Error('unsafe artifact name');
    const relPath = join(tenantId, fileName);
    const abs = resolve(this.root, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data, { flag: 'wx' });
    return { relPath, sizeBytes: data.length };
  }

  /** Resolves a stored relative path; rejects traversal and symlinks. */
  async resolveForRead(relPath: string): Promise<string> {
    const rootReal = await realpath(this.root);
    const abs = resolve(rootReal, relPath);
    const rel = relative(rootReal, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path outside artifact root');
    const st = await lstat(abs);
    if (!st.isFile()) throw new Error('not a regular file');
    if ((await realpath(abs)) !== abs) throw new Error('symlinked artifact');
    return abs;
  }

  /**
   * Lists regular files of a tenant that are older than minAgeMs and not in `referenced`
   * (exports written before their transaction failed). Deletes them unless dryRun.
   */
  async sweepOrphans(tenantId: string, referenced: Set<string>, opts: { minAgeMs: number; dryRun: boolean; now?: number }) {
    if (!/^[\w-]+$/.test(tenantId)) throw new Error('unsafe tenant id');
    const dir = resolve(this.root, tenantId);
    const now = opts.now ?? Date.now();
    const orphans: string[] = [];
    let names: string[];
    try { names = await readdir(dir); } catch { return orphans; }
    for (const name of names.sort()) {
      const relPath = join(tenantId, name);
      const st = await lstat(join(dir, name));
      if (!st.isFile() || referenced.has(relPath) || now - st.mtimeMs < opts.minAgeMs) continue;
      orphans.push(relPath);
      if (!opts.dryRun) await unlink(join(dir, name));
    }
    return orphans;
  }
}
