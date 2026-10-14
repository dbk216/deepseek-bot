/**
 * Refuse to test a build that cannot be a plugin.
 *
 * Two mistakes motivated this and the second one was expensive. `tsc --noEmit` after an edit
 * leaves `dist` behind, so the guard compares modification times — and modification time is all
 * it compared, which let a *newer* build through even when that build was not a plugin at all.
 *
 * What happened: an edit emptied `index.ts` to zero lines, the two commits that followed carried
 * it (a typecheck of an empty module succeeds), `dist/index.js` became `export {}`, and the
 * harness answered every boot with "failed to import". The live bot only survived because its
 * process predated the damage. Two days went into hunting a loader bug that was this.
 *
 * So the guard checks content now: the source is not near-empty, the entry has exports, and every
 * published module exists. Imported by the test files, and runnable on its own with `pnpm run build:check`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const source = fileURLToPath(new URL('../index.ts', import.meta.url))

function fail(message) {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

let sourceText
try {
  sourceText = readFileSync(source, 'utf8')
} catch (e) {
  fail(`could not read index.ts: ${String(e?.message ?? e)}`)
}

// An edit that truncates the source is the failure this exists for: 2113 lines became 0, and
// nothing else noticed.
if (sourceText.trim().length < 1000) {
  fail(`index.ts is ${sourceText.trim().length} characters — it looks truncated, not edited. Restore it from git.`)
}

let built
try {
  built = readFileSync(dist, 'utf8')
  statSync(dist)
} catch (e) {
  // Reported with its cause: run inside a loop right after a build this failed three times and the
  // only thing visible was the last line of a stack trace, which is not a diagnosis.
  fail(`could not read dist/index.js: ${String(e?.message ?? e)}`)
}

if (statSync(dist).mtimeMs + 1 < statSync(source).mtimeMs) {
  fail('dist/index.js is older than index.ts — run: pnpm run build')
}

const exportLines = built.split('\n').filter((line) => line.startsWith('export'))
if (exportLines.length === 0 || built.trim() === 'export {};') {
  fail('dist/index.js has no exports — the harness will say "failed to import". Run: pnpm run build')
}

// Every module the plugin imports from its own directory must have been published next to it;
// a missing one shows up as a load failure in the harness, which reports it without a reason.
const published = new Set(readdirSync(new URL('../dist/', import.meta.url)).filter((f) => f.endsWith('.js')))
for (const match of sourceText.matchAll(/from '\.\/([\w.-]+)\.js'/g)) {
  if (!published.has(`${match[1]}.js`)) {
    fail(`index.ts imports ./${match[1]}.js but dist/${match[1]}.js does not exist — run: pnpm run build`)
  }
}

// The indexer is spawned, not imported, so a missing build shows up as recall going quietly stale
// rather than as a load failure. That happened once: dist/recall was absent and the index stopped
// updating without a word.
const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const indexerSource = `${repoRoot}recall/deepbot-recall.ts`
if (existsSync(indexerSource) && !existsSync(`${repoRoot}dist/recall/deepbot-recall.js`)) {
  fail('recall/deepbot-recall.ts has no dist/recall/deepbot-recall.js — recall would go stale. Run: pnpm run build')
}

// The health probe, the watch runner and the tools are run from the build, by their suites and by the
// installers. A suite run on its own after an edit would otherwise test the build from before it.
for (const script of ['service/health-check', 'watch/watch', 'tools/persona-check', 'tools/qa-slack', 'tools/secret-patterns']) {
  const from = `${repoRoot}${script}.ts`, to = `${repoRoot}dist/${script}.js`
  if (!existsSync(from)) continue
  if (!existsSync(to)) fail(`${script}.ts has no dist/${script}.js — run: pnpm run build`)
  if (statSync(to).mtimeMs + 1 < statSync(from).mtimeMs) fail(`dist/${script}.js is older than ${script}.ts — run: pnpm run build`)
}
