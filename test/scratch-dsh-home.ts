/**
 * A scratch harness home for suites that boot the plugin.
 *
 * A turn that completes, or a message the agent sends on its own, refreshes the recall index, and the
 * index lives under the harness home (`recallIndexPath`) — the real ~/.dsh unless DSH_HOME says
 * otherwise. Without this, every run left one directory per test home in the developer's ~/.dsh.
 * Not imported by the scenario runner, which must use the real harness home to find its profile.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'deepbot-dsh-'))
process.on('exit', () => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))
