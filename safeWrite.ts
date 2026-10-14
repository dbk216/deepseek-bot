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
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Make `dir` and its parents, refusing a directory that would resolve outside `root`. */
export function mkdirInside(root: string, dir: string): void {
  const realRoot = realpathSync(root)
  if (!inside(realRoot, resolvedAncestor(dir))) throw new Error(`refusing to make ${dir}: it resolves outside ${realRoot}`)
  mkdirSync(dir, { recursive: true })
  const realDir = realpathSync(dir)
  if (!inside(realRoot, realDir)) throw new Error(`refusing to use ${dir}: it resolves to ${realDir}, outside ${realRoot}`)
}

/**
 * Keep `dir` the harness's instruction root: an empty `.git` in it. The loader climbs from a session's
 * directory to the nearest `.git` — a stat, nothing more — and reads every AGENTS.md and CLAUDE.md on
 * the way down. Without one, a home under a repository (a dotfiles home) was handed that repository's
 * files, and a tenant directory under a home with one was handed the home's. git passes over an empty
 * `.git`: it is not a repository to it. One already there — a repository, a worktree's gitlink, a link
 * to a directory — is a root as it is and left alone; a link to nothing is not, and is replaced. Strict,
 * for a tenant's directory, only a .git directory is kept: a file or a link it planted is replaced.
 */
export function markInstructionRoot(root: string, dir: string, strict = false): void {
  // Inside the guard first: a directory linked outside is refused even when a .git is there.
  const realRoot = realpathSync(root)
  const realDir = realpathSync(dir)
  if (!inside(realRoot, realDir)) throw new Error(`refusing to mark ${dir}: it resolves outside ${realRoot}`)
  const marker = join(realDir, '.git')
  let entry = null
  try { entry = lstatSync(marker) } catch { /* nothing there */ }
  if (entry !== null) {
    if (entry.isDirectory()) return
    // Not strict (the home): a worktree's gitlink file, or a link to a directory, is a root as it is.
    // Strict (a tenant, never a worktree): only the directory, which the sandbox keeps in place, will do.
    if (!strict) { try { statSync(marker); return } catch { /* a link to nothing */ } }
    rmSync(marker)
  }
  mkdirSync(marker)
  // The directory could have been swapped for a link between the check and the mkdir: what was made
  // outside is taken back, and the mark refused.
  const made = realpathSync(marker)
  if (!inside(realRoot, made)) { try { rmdirSync(made) } catch { /* not ours to remove */ } throw new Error(`refusing to mark ${dir}: it moved outside ${realRoot}`) }
}

/** Whether `path` resolves inside `root`. */
export function resolvesInside(root: string, path: string): boolean {
  try { return inside(realpathSync(root), realpathSync(path)) } catch { return false }
}
