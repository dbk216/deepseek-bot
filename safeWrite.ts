/**
 * Writing into a directory the agent can write, from code that runs outside its sandbox.
 *
 * The plugin and the recall indexer are unconfined, and they write files into the agent's home —
 * which the agent can prepare first. Found by security review and reproduced: a symlink left at
 * memory/recall-index.jsonl, pointing at the gateway's launcher, made the indexer overwrite the
 * launcher, which launchd runs unconfined at the next start.
 *
 * Two rules. The directory must resolve inside the root, so a linked directory is refused. The final
 * name is never followed: the data goes to a fresh file beside it (O_EXCL, so not through any existing
 * name) and is renamed over the target — rename replaces a link instead of writing through it.
 */
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, sep } from 'node:path'

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/** The nearest existing ancestor of `dir`, resolved. */
function resolvedAncestor(dir: string): string {
  let at = dir
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  return realpathSync(at)
}

export function writeInside(root: string, path: string, data: string | Uint8Array): void {
  const realRoot = realpathSync(root)
  const dir = dirname(path)
  // Checked before mkdir as well as after: creating directories through a linked parent would make
  // them outside the root even though the write itself is then refused.
  if (!inside(realRoot, resolvedAncestor(dir))) throw new Error(`refusing to write ${path}: it resolves outside ${realRoot}`)
  mkdirSync(dir, { recursive: true })
  const realDir = realpathSync(dir)
  if (!inside(realRoot, realDir)) throw new Error(`refusing to write ${path}: its directory resolves to ${realDir}, outside ${realRoot}`)
  const target = join(realDir, basename(path))
  const temp = join(realDir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(temp, data, { flag: 'wx' })
  try { renameSync(temp, target) } catch (e) { rmSync(temp, { force: true }); throw e }
}
