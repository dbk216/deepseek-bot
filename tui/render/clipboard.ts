/**
 * Put text on the user's clipboard.
 *
 * Locally, `pbcopy` (a macOS system binary) is reliable and needs nothing from the terminal.
 * Over SSH that would copy on the remote machine, so there the terminal is asked instead, with
 * OSC 52 — which many terminals support and some disable by default. Elsewhere OSC 52 is the
 * only option there is.
 */
import { spawnSync } from 'node:child_process'

export type CopyMethod = 'pbcopy' | 'osc52'

export interface CopyDeps {
  env: Record<string, string | undefined>
  platform: string
  write(data: string): void
  run?: (command: string, input: string) => boolean
}

const runCommand = (command: string, input: string): boolean => {
  const result = spawnSync(command, [], { input, timeout: 2000 })
  return result.status === 0
}

export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
}

export function copy(text: string, deps: CopyDeps): CopyMethod {
  const remote = Boolean(deps.env.SSH_TTY || deps.env.SSH_CONNECTION)
  if (!remote && deps.platform === 'darwin' && (deps.run ?? runCommand)('pbcopy', text)) return 'pbcopy'
  deps.write(osc52(text))
  return 'osc52'
}
