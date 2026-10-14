/**
 * `dsh gateway`: connect the bot to a messenger, and run the gateway service — for a person at a
 * terminal, or for an agent that has none.
 *
 *   dsh gateway setup <slack|telegram|discord|local> [--channels <ids|*>] [--users <ids>] [--profile <name>] [--no-verify] [--no-restart]
 *   dsh gateway remove <platform> [--profile <name>] [--no-restart]
 *   dsh gateway start | stop | restart
 *   dsh gateway status [--json] [--profile <name>]
 *   dsh gateway manifest slack
 *
 * Every answer has a way in that needs no terminal: a token comes from the environment variable of its
 * own name, the channels from --channels, the people from --users. Without a terminal a missing answer
 * is an error that names it, and nothing is written. A token is never taken as an argument: arguments
 * show in `ps` and in shell history.
 *
 * What it writes: tokens to ~/.dsh/.env (mode 600), and the platform, channel and people lines of the
 * profile's deepbot row. Nothing else in either file changes. The bot's own agent cannot set up or
 * remove a platform: its commands may not write those files, and that is intended. Its sandbox confines
 * writes only, though, so start, stop and restart — calls to launchd — are not kept from it.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const GATEWAY_COMMANDS = new Set(['setup', 'remove', 'start', 'stop', 'restart', 'status', 'manifest'])
const GATEWAY_LABEL = 'ai.deepbot.gateway'
const HEALTH_LABEL = 'ai.deepbot.health'
const LAUNCHCTL = '/bin/launchctl'
const PLUTIL = '/usr/bin/plutil'
const DOCS = 'https://github.com/rlaope/deepseek-bot/blob/master/docs/setup.md'
/** The probe calls a heartbeat older than this stale; status uses the same line. */
const STALE_MS = 5 * 60 * 1000

export interface RunResult { status: number | null; stdout: string; stderr: string }
export interface FetchResponse { ok: boolean; status: number; json(): Promise<any> }
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>

/** Everything that reaches outside this module, so a suite can run it with no launchctl, network or terminal. */
export interface GatewayIO {
  home: string
  env: Record<string, string | undefined>
  uid: number
  run: (cmd: string, args: string[]) => RunResult
  fetch: Fetch
  /** A question at the terminal, null when cancelled. Absent without a terminal: every answer must come another way. */
  ask?: (question: string, secret: boolean) => Promise<string | null>
  out: (text: string) => void
  err: (text: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** How long a (re)start may take to connect. */
  waitMs?: number
}

// ── Platforms ─────────────────────────────────────────────────────────────────

type Platform = 'slack' | 'telegram' | 'discord' | 'local'
interface TokenSpec { key: string; label: string; shape: RegExp; expect: string }
interface PlatformSpec { tokens: TokenSpec[]; guide: string[]; whoami: string }

const PLATFORMS: Record<Platform, PlatformSpec> = {
  slack: {
    tokens: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack bot token', shape: /^xoxb-[A-Za-z0-9-]+$/, expect: 'xoxb-…' },
      { key: 'SLACK_APP_TOKEN', label: 'Slack app-level token', shape: /^xapp-[A-Za-z0-9-]+$/, expect: 'xapp-…' },
    ],
    guide: [
      'Slack: create the app from a manifest — `dsh gateway manifest slack`, then https://api.slack.com/apps → Create New App → From a manifest.',
      'Then Basic Information → App-Level Tokens → generate one with connections:write (xapp-…), and Install App → the bot token (xoxb-…).',
      `Without the manifest: ${DOCS}#slack`,
    ],
    whoami: 'a member id (U…): your profile → ⋮ → Copy member ID',
  },
  telegram: {
    tokens: [{ key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', shape: /^\d+:[A-Za-z0-9_-]+$/, expect: '123456:AA…, from @BotFather' }],
    guide: [
      'Telegram: @BotFather → /newbot gives the token. In groups, turn privacy mode off (/setprivacy) for it to see messages.',
      `${DOCS}#telegram`,
    ],
    whoami: 'a numeric user id: @userinfobot replies with yours',
  },
  discord: {
    tokens: [{ key: 'DISCORD_BOT_TOKEN', label: 'Discord bot token', shape: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, expect: 'three parts separated by dots' }],
    guide: [
      'Discord: an application at https://discord.com/developers/applications → Bot → Reset Token; turn on the Message Content intent.',
      `${DOCS}#discord`,
    ],
    whoami: 'a numeric user id: Developer Mode on, then right-click your name → Copy User ID',
  },
  local: { tokens: [], guide: ['The terminal, dsh: no token.'], whoami: '' },
}
const isPlatform = (name: string | undefined): name is Platform => name !== undefined && Object.hasOwn(PLATFORMS, name)

/** The bot scopes docs/setup.md lists, and im:history, which DMs (`message.im`) need. */
const SLACK_BOT_SCOPES = ['app_mentions:read', 'chat:write', 'channels:read', 'channels:history', 'groups:history', 'im:history', 'users:read', 'files:read', 'files:write']

/** A Slack app manifest with what docs/setup.md asks for: Socket Mode, the scopes, the events, interactivity. */
export function slackManifest(): Record<string, unknown> {
  return {
    display_information: { name: 'deepseek-bot', description: 'An always-on agent on DeepSeek Harness' },
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'deepseek-bot', always_online: true },
    },
    oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }
}

// ── Ids ───────────────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9_-]+$/
/** A Slack token passes for an id by its characters; one pasted at the wrong prompt would land in the profile. */
const TOKEN_SHAPED = /^(xox[a-z]|xapp)-/i

/** Ids from what was typed: separated by spaces or commas, or `*` alone where that is allowed. Null when one is not an id. */
export function parseIds(input: string, star: boolean): string[] | null {
  const text = input.trim()
  if (star && text === '*') return ['*']
  const ids = text.split(/[\s,]+/).filter(Boolean)
  return ids.length > 0 && ids.every((id) => ID.test(id) && !TOKEN_SHAPED.test(id)) ? [...new Set(ids)] : null
}

/** Ids added to a list. A list that already holds `*` stays as it is; adding `*` makes it `*`. */
export function mergeIds(current: string[], given: string[]): string[] {
  if (current.includes('*')) return current
  if (given.includes('*')) return ['*']
  return [...current, ...given.filter((id) => !current.includes(id))]
}

// ── The credential file ───────────────────────────────────────────────────────

// A line ending in \r (a file saved with CRLF) is still the key's line: missed, it was appended twice.
const envLine = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*?)\\r?$`)

/** A key's value in a .env text, the last line winning; undefined when absent or empty. */
export function envValue(text: string, key: string): string | undefined {
  let value: string | undefined
  for (const line of text.split('\n')) {
    const m = envLine(key).exec(line)
    if (m) value = m[1].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return value === '' ? undefined : value
}

/**
 * The text with the key set: its first line replaced, any other line for it removed, or a line appended.
 * A file saved with CRLF keeps CRLF on every line.
 */
export function envSet(text: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  const out: string[] = []
  let placed = false
  for (const line of lines) {
    if (!envLine(key).test(line)) { out.push(line); continue }
    if (!placed) { out.push(`${key}=${value}`); placed = true }
  }
  if (!placed) out.push(`${key}=${value}`)
  return `${out.join(eol)}${eol}`
}

// With strictNullChecks off, `x !== null && 'error' in x` does not narrow; a guard does.
const failed = (x: unknown): x is { error: string } => typeof x === 'object' && x !== null && 'error' in x

// ── The profile's deepbot row ─────────────────────────────────────────────────

type ListKey = 'platform' | 'targetChannels' | 'allowedUsers'
interface ListField { values: string[]; style: 'scalar' | 'flow' | 'block'; line: number; end: number; indent: string; itemIndent: string; comment: string }
export interface DeepbotLists { platform: string[]; targetChannels: string[]; allowedUsers: string[] }

const SCALAR = /^(?:'((?:[^']|'')*)'|"([^"\\]*)"|([^\s'"[\],#{}]+))$/
/**
 * A value as YAML reads it, or why it is not one this edits: an unquoted number (YAML reads a number,
 * and a long id loses digits), an alias, a tag, a block scalar, or null.
 */
function scalar(text: string): string | { error: string } {
  const m = SCALAR.exec(text.trim())
  if (m === null) return { error: `\`${text.trim()}\` is not a plain value` }
  if (m[1] !== undefined) return m[1].replace(/''/g, "'")
  if (m[2] !== undefined) return m[2]
  const plain = m[3]
  if (/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+|0x[\da-f]+|0o[0-7]+)(e[-+]?\d+)?$/i.test(plain)) return { error: `\`${plain}\` is a number to YAML: quote it, '${plain}' — a long id loses digits otherwise` }
  if (/^[*&!|>%@`]/.test(plain) || /^(~|null|true|false)$/i.test(plain)) return { error: `\`${plain}\` is not a plain value` }
  return plain
}

/** The `- id: deepbot` row as [start, end) lines: it runs to the next top-level row or key. */
function deepbotRow(lines: string[]): { start: number; end: number } | { error: string } {
  const starts = lines.flatMap((line, i) => (/^- id: ['"]?deepbot['"]?\s*(#.*)?$/.test(line) ? [i] : []))
  if (starts.length === 0) return { error: 'it has no `- id: deepbot` row' }
  if (starts.length > 1) return { error: `it has ${starts.length} \`- id: deepbot\` rows` }
  let end = starts[0] + 1
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++
  return { start: starts[0], end }
}

const indentOf = (line: string) => /^\s*/.exec(line)[0]
const blankOrComment = (line: string) => line.trim() === '' || /^\s*#/.test(line)

/**
 * The indent of the keys under the row's `config:` — the first line below it that is not blank or a
 * comment. A key at any other indent is not the setting: it is in a block of text, or outside config.
 */
function configIndent(lines: string[], row: { start: number; end: number }): string | { error: string } {
  const at = lines.findIndex((line, i) => i > row.start && i < row.end && /^\s+config:\s*(#.*)?$/.test(line))
  if (at === -1) return { error: 'the deepbot row has no `config:` block' }
  for (let i = at + 1; i < row.end; i++) {
    if (blankOrComment(lines[i])) continue
    const indent = indentOf(lines[i])
    return indent.length > indentOf(lines[at]).length ? indent : { error: 'the deepbot row\'s `config:` block is empty' }
  }
  return { error: 'the deepbot row\'s `config:` block is empty' }
}

/** A list key in the row's config, in any of the three ways YAML writes one; null when absent. */
function readList(lines: string[], row: { start: number; end: number }, key: ListKey): ListField | null | { error: string } {
  const keys = configIndent(lines, row)
  if (failed(keys)) return keys
  const head = new RegExp(`^(${keys})${key}:(.*)$`)
  let at = -1
  for (let i = row.start + 1; i < row.end; i++) {
    if (!head.test(lines[i])) continue
    if (at !== -1) return { error: `${key} appears twice in the deepbot row` }
    at = i
  }
  if (at === -1) return null
  const [, indent, rest] = head.exec(lines[at])
  const [, body, comment = ''] = /^(.*?)(\s+#.*)?$/.exec(rest)
  const value = body.trim()
  const where = `line ${at + 1} (${key})`

  if (value === '') {
    // A block list: the items below, each `- value` at one indent. Anything else inside it is refused rather than guessed at.
    let end = at + 1
    const values: string[] = []
    let itemIndent: string | null = null
    while (end < row.end) {
      const line = lines[end]
      if (line.trim() === '') break
      const deeper = indentOf(line).length > indent.length
      const item = /^(\s*)-\s+(.*?)\s*$/.exec(line)
      if (item !== null && item[1].length >= indent.length) {
        if (itemIndent !== null && item[1] !== itemIndent) return { error: `${where}: items at different indents` }
        const v = scalar(item[2])
        if (failed(v)) return { error: `${where}: ${v.error}` }
        itemIndent = item[1]
        values.push(v)
        end++
        continue
      }
      if (deeper) return { error: `${where}: a line inside the list that is not an item` }
      break
    }
    // An item after a comment would still belong to the list in YAML.
    for (let i = end; i < row.end && blankOrComment(lines[i]); i++) {
      const next = lines[i + 1]
      if (next !== undefined && /^\s*-\s/.test(next) && indentOf(next).length >= indent.length && i + 1 < row.end) {
        return { error: `${where}: the list continues after a comment or a blank line` }
      }
    }
    if (values.length === 0) return { error: `${where}: no value` }
    return { values, style: 'block', line: at, end, indent, itemIndent, comment }
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return { error: `${where}: a list that does not close on its line` }
    const inner = value.slice(1, -1).trim()
    const values = inner === '' ? [] : inner.split(',').map(scalar)
    const bad = values.find(failed)
    if (bad !== undefined) return { error: `${where}: ${bad.error}` }
    return { values: values as string[], style: 'flow', line: at, end: at + 1, indent, itemIndent: `${indent}  `, comment }
  }
  const single = scalar(value)
  if (failed(single)) return { error: `${where}: ${single.error}` }
  return { values: [single], style: 'scalar', line: at, end: at + 1, indent, itemIndent: `${indent}  `, comment }
}

const quoted = (v: string) => `'${v.replace(/'/g, "''")}'`

function rewrite(field: ListField, key: ListKey, values: string[]): string[] {
  if (field.style === 'block' && values.length > 0) {
    return [`${field.indent}${key}:${field.comment}`, ...values.map((v) => `${field.itemIndent}- ${quoted(v)}`)]
  }
  if (field.style === 'scalar' && values.length === 1) return [`${field.indent}${key}: ${quoted(values[0])}${field.comment}`]
  return [`${field.indent}${key}: [${values.map(quoted).join(', ')}]${field.comment}`]
}

/** The three lists of the deepbot row, or why they cannot be read. An absent allowedUsers is empty. */
export function readProfile(text: string): DeepbotLists | { error: string } {
  // Refused by name: either one used to read as "no deepbot row" or "no platform line".
  if (text.includes('\r')) return { error: 'it has Windows line endings (CRLF); save it with LF' }
  if (text.startsWith('\ufeff')) return { error: 'it starts with a byte-order mark; save it without one' }
  const lines = text.split('\n')
  const row = deepbotRow(lines)
  if ('error' in row) return row
  const lists: Partial<DeepbotLists> = {}
  for (const key of ['platform', 'targetChannels', 'allowedUsers'] as const) {
    const field = readList(lines, row, key)
    if (failed(field)) return field
    if (field === null && key !== 'allowedUsers') return { error: `the deepbot row has no ${key} line` }
    lists[key] = field === null ? [] : field.values
  }
  return lists as DeepbotLists
}

/**
 * The profile text with the lists changed, every other line as it was. A list keeps the way it was
 * written; allowedUsers, when absent, is put right after targetChannels.
 */
export function writeProfile(text: string, next: Partial<DeepbotLists>): string | { error: string } {
  const readable = readProfile(text)
  if (failed(readable)) return readable
  let lines = text.split('\n')
  for (const key of ['platform', 'targetChannels', 'allowedUsers'] as const) {
    const values = next[key]
    if (values === undefined) continue
    const row = deepbotRow(lines)
    if ('error' in row) return row
    const field = readList(lines, row, key)
    if (failed(field)) return field
    if (field !== null) {
      if (field.values.join('\n') === values.join('\n')) continue
      lines = [...lines.slice(0, field.line), ...rewrite(field, key, values), ...lines.slice(field.end)]
      continue
    }
    if (values.length === 0) continue
    const anchor = readList(lines, row, 'targetChannels')
    if (anchor === null || failed(anchor)) return { error: `the deepbot row has no targetChannels line to put ${key} after` }
    lines = [...lines.slice(0, anchor.end), `${anchor.indent}${key}: [${values.map(quoted).join(', ')}]`, ...lines.slice(anchor.end)]
  }
  return lines.join('\n')
}

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * Write through a link to the file it names, by a rename. The mode is the file's own, or `mode` for a new
 * one — or `mode` always where `exact` (the credential file is 600 whatever it was).
 */
function writeFile(path: string, text: string, mode: number, exact = false): void {
  const target = existsSync(path) ? realpathSync(path) : path
  const final = !exact && existsSync(target) ? statSync(target).mode & 0o777 : mode
  const temp = join(dirname(target), `.${process.pid}.${Date.now()}.tmp`)
  // It holds the tokens until the rename: a failure on the way must not leave it beside them.
  try {
    writeFileSync(temp, text, { mode: 0o600 })
    chmodSync(temp, final)
    renameSync(temp, target)
  } catch (e) {
    rmSync(temp, { force: true })
    throw e
  }
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

function paths(io: GatewayIO) {
  const dsh = join(io.home, '.dsh')
  const agents = join(io.home, 'Library', 'LaunchAgents')
  return {
    dsh,
    env: join(dsh, '.env'),
    health: join(dsh, 'slack-state', 'health.json'),
    log: join(dsh, 'slack-state', 'deepbot.log'),
    plist: join(agents, `${GATEWAY_LABEL}.plist`),
    healthPlist: join(agents, `${HEALTH_LABEL}.plist`),
  }
}
type Paths = ReturnType<typeof paths>

const tilde = (io: GatewayIO, path: string) => (path.startsWith(`${io.home}/`) ? `~${path.slice(io.home.length)}` : path)

// ── The service ───────────────────────────────────────────────────────────────

function service(io: GatewayIO, label: string): { loaded: boolean; pid: number | null } {
  const r = io.run(LAUNCHCTL, ['print', `gui/${io.uid}/${label}`])
  if (r.status !== 0) return { loaded: false, pid: null }
  // The job's own lines are indented by one tab; its endpoints' "state = active" sit deeper.
  const pid = /^\tpid = (\d+)$/m.exec(r.stdout)
  return { loaded: true, pid: pid === null ? null : Number(pid[1]) }
}

function launchctl(io: GatewayIO, args: string[]): boolean {
  const r = io.run(LAUNCHCTL, args)
  if (r.status === 0) return true
  io.err(`launchctl ${args[0]} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`)
  return false
}

interface Health { pid?: number; startedAt?: number; connected?: boolean; connectedAt?: number | null; lastError?: string | null; updatedAt?: number }
function readHealth(p: Paths): Health | null {
  try { return JSON.parse(readFileSync(p.health, 'utf8')) } catch { return null }
}

/** How long to watch, once a platform has connected, for another one failing after it. */
const SETTLE_MS = 5000

/**
 * Wait for a process started at or after `since` to say it is up: connected, where it serves a
 * messenger. With several, the health file has one flag for all of them and the first to connect sets
 * it, so this watches a little longer for a platform failing after it, and says what it cannot tell.
 */
async function reportConnection(io: GatewayIO, p: Paths, since: number, messengers: number): Promise<number> {
  const waitMs = io.waitMs ?? 60000
  const deadline = io.now() + waitMs
  const fresh = (h: Health | null) => h !== null && (h.startedAt ?? 0) >= since
  let health = readHealth(p)
  while (!(fresh(health) && (messengers === 0 || health.connected === true))) {
    if (io.now() >= deadline) {
      const last = fresh(health) && health.lastError ? ` — last error: ${health.lastError}` : ''
      io.err(`not connected within ${Math.round(waitMs / 1000)}s${last}. It may still be starting: dsh gateway status, and the log at ${tilde(io, p.log)}`)
      return 1
    }
    await io.sleep(1000)
    health = readHealth(p)
  }
  if (messengers === 0) { io.out(`running (pid ${health.pid ?? '?'})`); return 0 }
  if (messengers === 1) { io.out(`connected (pid ${health.pid ?? '?'})`); return 0 }
  await io.sleep(SETTLE_MS)
  const later = readHealth(p)
  if (fresh(later) && later.lastError) {
    io.err(`a platform connected, and another reported an error: ${later.lastError}. The log: ${tilde(io, p.log)}`)
    return 1
  }
  io.out(`connected (pid ${health.pid ?? '?'}) — a platform did; with ${messengers} the health file does not say which, so message the one you set up`)
  return 0
}

async function restartGateway(io: GatewayIO, p: Paths, messengers: number): Promise<number> {
  io.out('restarting the gateway (a turn running now is cut off, and its conversation is told so)')
  const since = io.now()
  if (!launchctl(io, ['kickstart', '-k', `gui/${io.uid}/${GATEWAY_LABEL}`])) return 1
  return reportConnection(io, p, since, messengers)
}

async function start(io: GatewayIO, p: Paths, messengers: number): Promise<number> {
  if (!existsSync(p.plist)) {
    io.err('the gateway service is not installed: run install.sh, or service/install-service.sh in the source checkout')
    return 1
  }
  const gateway = service(io, GATEWAY_LABEL)
  const since = io.now()
  if (!gateway.loaded) {
    if (!launchctl(io, ['bootstrap', `gui/${io.uid}`, p.plist])) return 1
  } else if (gateway.pid === null) {
    // Loaded with no process: launchd is between restarts of one that keeps exiting. Start it now and see.
    if (!launchctl(io, ['kickstart', `gui/${io.uid}/${GATEWAY_LABEL}`])) return 1
  }
  // The probe was stopped with it; without it nothing restarts a gateway that drops.
  if (existsSync(p.healthPlist) && !service(io, HEALTH_LABEL).loaded && !launchctl(io, ['bootstrap', `gui/${io.uid}`, p.healthPlist])) return 1
  if (gateway.loaded && gateway.pid !== null) { io.out(`already running (pid ${gateway.pid})`); return 0 }
  return reportConnection(io, p, since, messengers)
}

function stop(io: GatewayIO, p: Paths): number {
  const gateway = service(io, GATEWAY_LABEL)
  const probe = service(io, HEALTH_LABEL)
  if (!gateway.loaded && !probe.loaded) { io.out('not running'); return 0 }
  // The probe first: left running, it would try to restart the gateway, fail, and alert that it is down.
  if (probe.loaded && !launchctl(io, ['bootout', `gui/${io.uid}/${HEALTH_LABEL}`])) return 1
  if (gateway.loaded && !launchctl(io, ['bootout', `gui/${io.uid}/${GATEWAY_LABEL}`])) {
    // The gateway is still up: put its probe back, or nothing restarts it when it drops.
    if (probe.loaded && existsSync(p.healthPlist)) launchctl(io, ['bootstrap', `gui/${io.uid}`, p.healthPlist])
    return 1
  }
  io.out('stopped, with its health probe. Both start again at login, or with: dsh gateway start')
  return 0
}

// ── Tokens with the platform ──────────────────────────────────────────────────

type Verified = { ok: true; who: string; app?: string } | { ok: false; reason: string; unreachable?: boolean }

/** The Slack app an app-level token belongs to: the part after `xapp-1-`, up to the next dash. */
const appOfAppToken = (token: string | undefined) => /^xapp-\d+-([A-Z0-9]+)-/.exec(token ?? '')?.[1]

/** Ask the platform who the token belongs to — and, for a Slack bot token, which app it is from. */
async function verifyToken(fetch: Fetch, key: string, token: string): Promise<Verified> {
  const call = async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
      let body: any = null
      try { body = await r.json() } catch { /* not JSON */ }
      return { status: r.status, ok: r.ok, body }
    } catch (e) {
      return { error: `could not reach ${new URL(url).host} (${String((e as Error)?.message ?? e)})` }
    }
  }
  const unreachable = (reason: string): Verified => ({ ok: false, reason, unreachable: true })
  const bearer = { Authorization: `Bearer ${token}` }
  if (key === 'SLACK_BOT_TOKEN') {
    const r = await call('https://slack.com/api/auth.test', { method: 'POST', headers: bearer })
    if ('error' in r) return unreachable(r.error)
    if (r.body?.ok !== true) return { ok: false, reason: `Slack refused it (${r.body?.error ?? `HTTP ${r.status}`})` }
    // Which app the bot is, to hold against the app-level token's; unknown when this is refused (users:read).
    const bot = r.body.bot_id ? await call(`https://slack.com/api/bots.info?bot=${encodeURIComponent(r.body.bot_id)}`, { method: 'GET', headers: bearer }) : null
    const app = bot !== null && !('error' in bot) && bot.body?.ok === true ? bot.body.bot?.app_id : undefined
    return { ok: true, who: `@${r.body.user} in ${r.body.team}`, ...(app ? { app } : {}) }
  }
  if (key === 'SLACK_APP_TOKEN') {
    // Asks for a Socket Mode URL and does not open it, so a running gateway's connection is untouched.
    const r = await call('https://slack.com/api/apps.connections.open', { method: 'POST', headers: bearer })
    if ('error' in r) return unreachable(r.error)
    return r.body?.ok === true ? { ok: true, who: 'Socket Mode is on' } : { ok: false, reason: `Slack refused it (${r.body?.error ?? `HTTP ${r.status}`})` }
  }
  if (key === 'TELEGRAM_BOT_TOKEN') {
    const r = await call(`https://api.telegram.org/bot${token}/getMe`, { method: 'GET' })
    if ('error' in r) return unreachable(r.error.split(token).join('…'))
    return r.body?.ok === true ? { ok: true, who: `@${r.body.result?.username}` } : { ok: false, reason: `Telegram refused it (${r.body?.description ?? `HTTP ${r.status}`})` }
  }
  if (key === 'DISCORD_BOT_TOKEN') {
    const r = await call('https://discord.com/api/v10/users/@me', { method: 'GET', headers: { Authorization: `Bot ${token}` } })
    if ('error' in r) return unreachable(r.error)
    return r.ok && r.body?.id ? { ok: true, who: `${r.body.username} (${r.body.id})` } : { ok: false, reason: `Discord refused it (${r.body?.message ?? `HTTP ${r.status}`})` }
  }
  return { ok: false, reason: `no check for ${key}` }
}

// ── Arguments ─────────────────────────────────────────────────────────────────

interface Options { positional: string[]; profile?: string; channels?: string; users?: string; verify: boolean; restart: boolean; json: boolean; yes: boolean; help: boolean }

const ALLOWED: Record<string, string[]> = {
  setup: ['--profile', '--channels', '--users', '--no-verify', '--no-restart', '--yes'],
  remove: ['--profile', '--no-restart'],
  start: [], stop: [], restart: [],
  status: ['--profile', '--json'],
  manifest: [],
}

function parseOptions(command: string, argv: string[]): Options | { error: string } {
  const o: Options = { positional: [], verify: true, restart: true, json: false, yes: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') { o.help = true; continue }
    if (!a.startsWith('-')) { o.positional.push(a); continue }
    if (!ALLOWED[command].includes(a)) return { error: `${command}: unknown option ${a}` }
    if (a === '--no-verify') o.verify = false
    else if (a === '--no-restart') o.restart = false
    else if (a === '--json') o.json = true
    else if (a === '--yes') o.yes = true
    else {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` }
      o[a.slice(2) as 'profile' | 'channels' | 'users'] = value
      i++
    }
  }
  return o
}

const GATEWAY_USAGE = `dsh gateway — connect the bot to a messenger, and run its service

  dsh gateway setup <slack|telegram|discord|local> [--channels <ids|*>] [--users <ids>] [--profile <name>] [--no-verify] [--no-restart] [--yes]
  dsh gateway remove <slack|telegram|discord|local> [--profile <name>] [--no-restart]
  dsh gateway start | stop | restart
  dsh gateway status [--json] [--profile <name>]
  dsh gateway manifest slack

  setup       saves the platform's tokens to ~/.dsh/.env, checks them with the platform, adds the platform
              to the profile and restarts the gateway. A token is read from the environment variable of
              its name (SLACK_BOT_TOKEN and SLACK_APP_TOKEN, TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN), or
              asked for at a terminal — never taken as an argument.
  --channels  channel ids to answer in, added to the list. The list is shared by the platforms, so *
              (every channel the bot is in) opens every platform the profile serves: that needs --yes.
  --users     user ids that may talk to it, added to allowedUsers; with none listed anyone who can
              reach the bot may. The list is shared by the platforms: once it has ids, add yours on
              each platform.
  --no-verify do not ask the platform whether the tokens work
  remove      takes the platform out of the profile; its tokens stay in ~/.dsh/.env
  stop        stops the gateway and its health probe, until the next login or start
  status      exit 0 when the gateway runs, is connected and has its tokens; --json for a program
  manifest    a Slack app manifest: api.slack.com/apps → Create New App → From a manifest

  Exit: 0 done; 1 failed, not connected, or a platform that could not be reached; 2 a missing or
  invalid answer (nothing written); 130 cancelled.
`

// ── Commands ──────────────────────────────────────────────────────────────────

function profileName(io: GatewayIO, p: Paths, given: string | undefined): string {
  if (given !== undefined) return given
  if (io.env.DEEPBOT_PROFILE) return io.env.DEEPBOT_PROFILE
  if (existsSync(p.plist)) {
    const r = io.run(PLUTIL, ['-extract', 'EnvironmentVariables.DEEPBOT_PROFILE', 'raw', '-o', '-', p.plist])
    if (r.status === 0 && r.stdout.trim() !== '') return r.stdout.trim()
  }
  return 'agent'
}

interface Loaded { name: string; path: string; text: string; lists: DeepbotLists }
function loadProfile(io: GatewayIO, p: Paths, given: string | undefined): Loaded | { error: string; code: number } {
  const name = profileName(io, p, given)
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name)) return { error: `not a profile name: ${name}`, code: 2 }
  const path = join(p.dsh, 'profiles', name, 'cordis.patch.yml')
  if (!existsSync(path)) return { error: `no profile at ${tilde(io, path)}: install deepseek-bot first (install.sh), or name one with --profile`, code: 1 }
  const text = readFileSync(path, 'utf8')
  const lists = readProfile(text)
  if ('error' in lists) return { error: `${tilde(io, path)}: ${lists.error}. Edit the deepbot row by hand.`, code: 1 }
  return { name, path, text, lists }
}

const messengersOf = (platforms: string[]) => platforms.filter((name) => name !== 'local')
const describeChannels = (ids: string[]) => (ids.includes('*') ? '* (every channel the bot is in)' : ids.join(', '))
const describeUsers = (ids: string[]) => (ids.length === 0 ? 'anyone who can reach the bot' : ids.join(', '))

async function setup(io: GatewayIO, p: Paths, o: Options): Promise<number> {
  const platform = o.positional[0]
  if (!isPlatform(platform)) { io.err(`setup: which platform? slack, telegram, discord or local\n\n${GATEWAY_USAGE}`); return 2 }
  const spec = PLATFORMS[platform]
  let channels = o.channels === undefined ? undefined : parseIds(o.channels, true)
  if (channels === null) { io.err(`--channels: ids are letters, digits, - and _, separated by spaces or commas, or * alone (got: ${o.channels})`); return 2 }
  let users = o.users === undefined ? undefined : parseIds(o.users, false)
  if (users === null) { io.err(`--users: ids are letters, digits, - and _, separated by spaces or commas (got: ${o.users})`); return 2 }
  const profile = loadProfile(io, p, o.profile)
  if ('error' in profile) { io.err(profile.error); return profile.code }
  const { lists } = profile

  for (const line of spec.guide) io.out(line)

  // Tokens: every answer is gathered and checked before anything is written.
  const envText = readText(p.env)
  const tokens: Array<{ key: string; value: string; from: string }> = []
  const missing: string[] = []
  for (const t of spec.tokens) {
    const given = io.env[t.key]?.trim()
    let value: string | undefined
    let from = 'from the environment'
    if (given) {
      // At a terminal, a token that happens to be exported in the shell does not silently replace the saved one.
      const saved = envValue(envText, t.key)
      if (io.ask !== undefined && saved !== undefined && saved !== given) {
        const answer = await io.ask(`${t.key} in your environment differs from the saved one. Use the environment's? [y/N]`, false)
        if (answer === null) { io.err('cancelled; nothing was written'); return 130 }
        if (/^y(es)?$/i.test(answer.trim())) value = given
      } else value = given
    } else if (io.ask !== undefined) {
      const saved = envValue(envText, t.key) !== undefined
      const answer = await io.ask(saved ? `${t.key} is set — paste a new ${t.label}, or Enter to keep it:` : `${t.label} (${t.expect}):`, true)
      if (answer === null) { io.err('cancelled; nothing was written'); return 130 }
      if (answer.trim() !== '') { value = answer.trim(); from = 'entered' }
    }
    if (value === undefined) {
      if (envValue(envText, t.key) !== undefined) io.out(`${t.key}: already set, kept`)
      else missing.push(t.key)
      continue
    }
    if (!t.shape.test(value)) { io.err(`${t.key} does not look like a ${t.label} (expected ${t.expect}); nothing was written`); return 2 }
    tokens.push({ key: t.key, value, from })
  }
  if (missing.length > 0) {
    io.err(`missing: ${missing.join(', ')}. Give ${missing.length > 1 ? 'them as environment variables' : 'it as an environment variable'} — ${missing.map((k) => `${k}=…`).join(' ')} dsh gateway setup ${platform}${io.ask === undefined ? ' — or run this at a terminal' : ''}. Nothing was written.`)
    return 2
  }
  if (o.verify) {
    let botApp: string | undefined
    for (const t of tokens) {
      const r = await verifyToken(io.fetch, t.key, t.value)
      // Refused is a wrong answer (2); unreachable says nothing about the token (1).
      if (r.ok === false) { io.err(`${t.key}: ${r.reason}. Nothing was written (--no-verify skips this check).`); return r.unreachable ? 1 : 2 }
      io.out(`${t.key}: works — ${r.who}`)
      if (t.key === 'SLACK_BOT_TOKEN') botApp = r.app
    }
    // Two tokens from two apps both work, and the bot then listens as one app and posts as another.
    const appApp = appOfAppToken(tokens.find((t) => t.key === 'SLACK_APP_TOKEN')?.value ?? envValue(envText, 'SLACK_APP_TOKEN'))
    if (botApp !== undefined && appApp !== undefined && botApp !== appApp) {
      io.err(`the bot token is from Slack app ${botApp} and the app-level token from ${appApp}: both must come from one app. Nothing was written.`)
      return 2
    }
  }

  // Channels and people, asked only where an answer is needed and a terminal can give it.
  const narrowed = !lists.targetChannels.includes('*')
  if (channels === undefined && narrowed && platform !== 'local' && io.ask !== undefined) {
    const answer = await io.ask(`The bot answers only in ${lists.targetChannels.join(', ')}. ${platform} channel ids to add (* for every channel, Enter to leave the list):`, false)
    if (answer === null) { io.err('cancelled; nothing was written'); return 130 }
    if (answer.trim() !== '') {
      channels = parseIds(answer, true)
      if (channels === null) { io.err(`not channel ids: ${answer}; nothing was written`); return 2 }
    }
  }
  if (users === undefined && platform !== 'local' && io.ask !== undefined) {
    const question = lists.allowedUsers.length === 0
      ? `Who may talk to it? ${platform} user ids, ${spec.whoami} (Enter: anyone who can reach the bot):`
      : `Only ${lists.allowedUsers.join(', ')} may talk to it. Your ${platform} user id to add — ${spec.whoami}:`
    const answer = await io.ask(question, false)
    if (answer === null) { io.err('cancelled; nothing was written'); return 130 }
    if (answer.trim() !== '') {
      users = parseIds(answer, false)
      if (users === null) { io.err(`not user ids: ${answer}; nothing was written`); return 2 }
    }
  }
  // The channel list is shared: * for this platform is * for every platform the profile serves.
  const others = messengersOf(lists.platform).filter((name) => name !== platform)
  if (channels?.includes('*') && narrowed && others.length > 0 && !o.yes) {
    const warning = `* answers in every channel on ${others.join(', ')} too, since the platforms share the list`
    if (io.ask === undefined) { io.err(`${warning}. Repeat with --yes to mean it; nothing was written.`); return 2 }
    const answer = await io.ask(`${warning}. Go on? [y/N]`, false)
    if (answer === null) { io.err('cancelled; nothing was written'); return 130 }
    if (!/^y(es)?$/i.test(answer.trim())) { io.err('nothing was written'); return 2 }
  }

  const next: DeepbotLists = {
    platform: lists.platform.includes(platform) ? lists.platform : [...lists.platform, platform],
    targetChannels: mergeIds(lists.targetChannels, platform === 'local' ? [...(channels ?? []), 'tui'] : (channels ?? [])),
    allowedUsers: users === undefined ? lists.allowedUsers : mergeIds(lists.allowedUsers, users),
  }
  const text = writeProfile(profile.text, next)
  if (typeof text !== 'string') { io.err(`${tilde(io, profile.path)}: ${text.error}. Nothing was written.`); return 1 }

  let env = envText
  for (const t of tokens) env = envSet(env, t.key, t.value)
  if (env !== envText) writeFile(p.env, env, 0o600, true)
  for (const t of tokens) io.out(`${t.key}: saved to ${tilde(io, p.env)} (${t.from})`)
  if (text !== profile.text) writeFile(profile.path, text, 0o644)

  io.out(`profile ${profile.name}: platform ${next.platform.join(', ')}`)
  io.out(`  channels: ${describeChannels(next.targetChannels)}`)
  io.out(`  people:   ${describeUsers(next.allowedUsers)}`)
  if (platform !== 'local' && channels === undefined && narrowed) io.out(`  note: it answers only in the channels listed; add this platform's with --channels`)
  if (platform !== 'local' && users === undefined) {
    io.out(next.allowedUsers.length === 0
      ? `  note: anyone who can message the bot on ${platform} can run it; --users limits who (${spec.whoami})`
      : `  note: no one on ${platform} is answered until their id is in allowedUsers: --users (${spec.whoami})`)
  }

  if (env === envText && text === profile.text) { io.out('nothing changed'); return 0 }
  return applyChange(io, p, o, next.platform)
}

async function applyChange(io: GatewayIO, p: Paths, o: Options, platforms: string[]): Promise<number> {
  if (!o.restart) { io.out('not restarted (--no-restart): it takes effect at the next start — dsh gateway restart'); return 0 }
  if (!service(io, GATEWAY_LABEL).loaded) { io.out('the gateway is not running; it takes effect when it starts — dsh gateway start'); return 0 }
  return restartGateway(io, p, messengersOf(platforms).length)
}

async function remove(io: GatewayIO, p: Paths, o: Options): Promise<number> {
  const platform = o.positional[0]
  if (!isPlatform(platform)) { io.err('remove: which platform? slack, telegram, discord or local'); return 2 }
  const profile = loadProfile(io, p, o.profile)
  if ('error' in profile) { io.err(profile.error); return profile.code }
  const { platform: current } = profile.lists
  if (!current.includes(platform)) { io.out(`${platform} is not in profile ${profile.name}; nothing changed`); return 0 }
  const rest = current.filter((name) => name !== platform)
  if (rest.length === 0) { io.err(`${platform} is the only platform in profile ${profile.name}; the gateway needs one. Set up another first.`); return 1 }
  const text = writeProfile(profile.text, { platform: rest })
  if (typeof text !== 'string') { io.err(`${tilde(io, profile.path)}: ${text.error}. Nothing was written.`); return 1 }
  writeFile(profile.path, text, 0o644)
  io.out(`profile ${profile.name}: platform ${rest.join(', ')}`)
  if (tokenKeys(platform).length > 0) io.out(`  its tokens stay in ${tilde(io, p.env)}: ${tokenKeys(platform).join(', ')}`)
  return applyChange(io, p, o, rest)
}
const tokenKeys = (platform: Platform) => PLATFORMS[platform].tokens.map((t) => t.key)

interface Status {
  service: { installed: boolean; running: boolean; pid: number | null }
  profile: { name: string; path: string; platforms: string[]; channels: string[]; allowedUsers: string[] } | { error: string }
  credentials: Record<string, boolean>
  health: { connected: boolean; connectedAt: number | null; lastError: string | null; heartbeatAgeMs: number | null } | null
  healthy: boolean
}

function status(io: GatewayIO, p: Paths, o: Options): number {
  const gateway = service(io, GATEWAY_LABEL)
  const loaded = loadProfile(io, p, o.profile)
  const envText = readText(p.env)
  const credentials: Record<string, boolean> = {}
  const platforms = 'error' in loaded ? [] : loaded.lists.platform
  for (const name of platforms) if (isPlatform(name)) for (const key of tokenKeys(name)) credentials[key] = envValue(envText, key) !== undefined
  const needed = Object.values(credentials).every(Boolean)
  // Reported, not required: a profile that routes the model through another gateway needs none.
  credentials.DEEPSEEK_API_KEY = envValue(envText, 'DEEPSEEK_API_KEY') !== undefined
  const h = readHealth(p)
  const age = h?.updatedAt === undefined ? null : io.now() - h.updatedAt
  const connected = messengersOf(platforms).length === 0 || h?.connected === true
  const s: Status = {
    service: { installed: existsSync(p.plist), running: gateway.loaded && gateway.pid !== null, pid: gateway.pid },
    profile: 'error' in loaded ? { error: loaded.error } : { name: loaded.name, path: loaded.path, platforms, channels: loaded.lists.targetChannels, allowedUsers: loaded.lists.allowedUsers },
    credentials,
    health: h === null ? null : { connected: h.connected === true, connectedAt: h.connectedAt ?? null, lastError: h.lastError ?? null, heartbeatAgeMs: age },
    healthy: false,
  }
  // The health file must be the running process's: a gateway that never started its plugin leaves the last one's.
  s.healthy = s.service.running && h?.pid === gateway.pid && !('error' in s.profile) && needed && connected && age !== null && age < STALE_MS
  if (o.json) { io.out(JSON.stringify(s, null, 2)); return s.healthy ? 0 : 1 }

  io.out(`service    ${s.service.running ? `running (pid ${s.service.pid})`
    : gateway.loaded ? 'loaded, not running — launchd restarts it; if it keeps exiting, see the log and dsh gateway restart'
    : s.service.installed ? 'stopped — dsh gateway start' : 'not installed — install.sh'}`)
  if ('error' in s.profile) io.out(`profile    ${s.profile.error}`)
  else {
    io.out(`profile    ${s.profile.name} (${tilde(io, s.profile.path)})`)
    io.out(`platforms  ${s.profile.platforms.join(', ')}`)
    io.out(`channels   ${describeChannels(s.profile.channels)}`)
    io.out(`people     ${describeUsers(s.profile.allowedUsers)}`)
  }
  const platformTokens = Object.entries(credentials).filter(([k]) => k !== 'DEEPSEEK_API_KEY')
  io.out(`tokens     ${'error' in loaded ? 'unknown — the profile could not be read' : platformTokens.map(([k, ok]) => `${k} ${ok ? 'set' : 'missing'}`).join(', ') || 'none needed'} (in ${tilde(io, p.env)})`)
  if (h !== null && s.service.running && h.pid !== gateway.pid) io.out(`           the health file is from pid ${h.pid ?? '?'}, not the running ${gateway.pid}: its plugin has not started`)
  io.out(`model key  DEEPSEEK_API_KEY ${credentials.DEEPSEEK_API_KEY ? 'set' : 'not set — needed only by the default DeepSeek route'}`)
  if (h === null) io.out('health     no health file yet — the gateway has not started')
  else {
    const since = h.connectedAt ? ` since ${new Date(h.connectedAt).toISOString()}` : ''
    const beat = age === null ? '' : `, heartbeat ${Math.round(age / 1000)}s ago${age >= STALE_MS ? ' (stale)' : ''}`
    io.out(`health     ${h.connected === true ? `connected${since}` : 'not connected'}${beat}${h.lastError ? ` — last error: ${h.lastError}` : ''}`)
  }
  return s.healthy ? 0 : 1
}

/** `dsh gateway <argv>`: the exit status. */
export async function gateway(argv: string[], io: GatewayIO): Promise<number> {
  const [command, ...rest] = argv
  if (!GATEWAY_COMMANDS.has(command)) { io.err(GATEWAY_USAGE); return 2 }
  const o = parseOptions(command, rest)
  if ('error' in o) { io.err(`${o.error}\n\n${GATEWAY_USAGE}`); return 2 }
  if (o.help) { io.out(GATEWAY_USAGE); return 0 }
  if (command === 'manifest') {
    if (o.positional.length !== 1 || o.positional[0] !== 'slack') { io.err('manifest: only slack has one (dsh gateway manifest slack)'); return 2 }
    io.out(JSON.stringify(slackManifest(), null, 2))
    return 0
  }
  if (o.positional.length > (command === 'setup' || command === 'remove' ? 1 : 0)) { io.err(`${command}: unexpected ${o.positional.join(' ')}\n\n${GATEWAY_USAGE}`); return 2 }
  // The services, the probe and the runner read ~/.dsh; tokens and profiles anywhere else would not be read.
  if (io.env.DSH_HOME && resolve(io.env.DSH_HOME) !== join(io.home, '.dsh')) {
    io.err(`DSH_HOME=${io.env.DSH_HOME} is not supported: the services read ${join(io.home, '.dsh')}`)
    return 2
  }
  const p = paths(io)
  switch (command) {
    case 'setup': return setup(io, p, o)
    case 'remove': return remove(io, p, o)
    case 'status': return status(io, p, o)
    case 'stop': return stop(io, p)
  }
  // start and restart wait for a connection only where a messenger is served; an unreadable profile counts as one.
  const loaded = loadProfile(io, p, undefined)
  const messengers = 'error' in loaded ? 1 : messengersOf(loaded.lists.platform).length
  if (command === 'restart' && service(io, GATEWAY_LABEL).loaded) return restartGateway(io, p, messengers)
  return start(io, p, messengers)
}

// ── The process's own IO ──────────────────────────────────────────────────────

/** A line read from the terminal in raw mode, not echoed when secret. Ctrl+C or Ctrl+D cancel it. */
export function terminalAsk(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
  return (question: string, secret: boolean) => new Promise<string | null>((done) => {
    output.write(`${question} `)
    let answer = ''
    const finish = (value: string | null) => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      output.write('\n')
      done(value)
    }
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk)
      if (text.startsWith('\x1b')) return     // an arrow or function key arrives whole: ignore it
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return finish(answer)
        if (ch === '\x03' || ch === '\x04') return finish(null)
        if (ch === '\x7f' || ch === '\b') {
          if (answer !== '') { answer = answer.slice(0, -1); if (!secret) output.write('\b \b') }
          continue
        }
        if (ch < ' ') continue
        answer += ch
        if (!secret) output.write(ch)
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

export function processIO(): GatewayIO {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true
  return {
    home: homedir(),
    env: process.env,
    uid: process.getuid(),
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || (r.error?.message ?? '') }
    },
    fetch: (url, init) => fetch(url, init),
    ask: tty ? terminalAsk(process.stdin, process.stdout) : undefined,
    out: (text) => { process.stdout.write(`${text}\n`) },
    err: (text) => { process.stderr.write(`${text}\n`) },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}
