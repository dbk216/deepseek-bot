/**
 * Live Slack checks that clean up after themselves.
 *
 * The unit suites drive a fake transport, and the scenarios drive the core. Neither says
 * anything about whether this deployment's real Slack app accepts what the transport sends:
 * the token scheme, the message-length chunking, replacing a message, and the app's own
 * messages being ignored. This runs those against the live workspace and deletes every
 * message it creates, so it can be run at any time without leaving litter.
 *
 * It never starts a turn: everything it posts is posted *by the bot*, which the adapter
 * ignores by design — and one of the checks is that it is indeed ignored.
 *
 * Cleanup works by **snapshot**, not by bookkeeping. The first version tracked the messages
 * the script posted itself — and the transport posts three when a body needs chunking, so
 * those were never tracked and never deleted. It left three parts of a 9000-character
 * alphabet in a real channel, twice. Everything the bot says after the run starts is now
 * deleted, however it was sent, and a message from a person is never touched.
 *
 * Run: node tools/qa-slack.mjs [--channel <id|name>] [--keep]
 */
import { readFileSync, existsSync } from 'node:fs'
import { createSlackTransport } from '../dist/transports/slack.js'

const args = process.argv.slice(2)
const wantsToPost = args.includes('--post')
const channelArg = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : undefined

// Posting is opt-in, and it goes to a lab channel by default — never to whatever channel
// happens to be first in the list, which is how a 9000-character alphabet ended up in a real
// one. The channel is resolved below and the run refuses if it is not there.
const token = process.env.SLACK_BOT_TOKEN ?? ''
if (token === '') { console.error('SLACK_BOT_TOKEN is not set — source ~/.dsh/.env first'); process.exit(2) }

const logs = []
const log = (...parts) => { const line = parts.join(' '); logs.push(line); console.log(`    · ${line}`) }
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body ?? {}),
  })
  return await res.json()
}

// ── which channel ──────────────────────────────────────────────────────────
const DEFAULT_CHANNEL = process.env.DEEPBOT_QA_CHANNEL ?? 'hope-lab'

/** Resolve a channel name or id, and refuse to guess: the first run picked one and posted into it. */
async function resolveChannel(name) {
  if (/^[CG][A-Z0-9]{6,}$/.test(name)) return name
  const list = await api('conversations.list', { limit: 300, exclude_archived: true, types: 'public_channel,private_channel' })
  if (list.ok !== true) { console.error(`cannot list channels: ${list.error}`); process.exit(2) }
  const found = (list.channels ?? []).find((c) => c.name === name.replace(/^#/, ''))
  if (found === undefined) {
    console.error(`no channel named ${name} that the bot can see — pass --channel <name|id>`)
    console.error(`  it can see: ${(list.channels ?? []).map((c) => '#' + c.name).slice(0, 10).join(' ')}`)
    process.exit(2)
  }
  if (found.is_member === false) { console.error(`the bot is not in #${found.name} — invite it first`); process.exit(2) }
  return found.id
}

const channel = await resolveChannel(channelArg ?? DEFAULT_CHANNEL)

const keep = args.includes('--keep')
const me = await api('auth.test')
const botId = me.user_id

/** The newest message in the channel right now: anything after it belongs to this run. */
async function newestTs() {
  const h = await api('conversations.history', { channel, limit: 1 })
  return Number(h.messages?.[0]?.ts ?? 0)
}
const baseline = await newestTs()

async function post(text) {
  const r = await api('chat.postMessage', { channel, text, unfurl_links: false })
  if (r.ok !== true) throw new Error(`chat.postMessage: ${r.error}`)
  return r.ts
}

/**
 * Delete every message the bot said after this run began — including the ones the transport
 * sent on its own, which is where the first version leaked. A person's message is never
 * touched, even if a test posted right above it.
 */
async function cleanup() {
  if (keep) { console.log('  cleanup: skipped (--keep)'); return }
  const h = await api('conversations.history', { channel, limit: 100, oldest: String(Math.max(0, baseline - 1)) })
  let deleted = 0, considered = 0
  for (const m of [...(h.messages ?? [])].reverse()) {
    if (m.user !== botId && m.bot_id !== botId) continue
    considered++
    const r = await api('chat.delete', { channel, ts: m.ts })
    if (r.ok === true) deleted++
    else console.log(`  cleanup: could not delete ${m.ts} (${r.error})`)
  }
  console.log(`  cleanup: ${deleted}/${considered} bot messages deleted`)
  const after = await api('conversations.history', { channel, limit: 20, oldest: String(Math.max(0, baseline - 1)) })
  const left = (after.messages ?? []).filter((m) => m.user === botId || m.bot_id === botId).length
  console.log(`  cleanup: ${left} left behind${left === 0 ? ' ✓' : ' ✗'}`)
}

// An interrupted run must not leak either.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup().then(() => process.exit(130), () => process.exit(130)) })
}

// ── 1. the token and the identity, the way the transport uses them ─────────
const host = {
  cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], slackTokenRef: 'SLACK_BOT_TOKEN' },
  log, sessionCwd: async () => process.cwd(), credential: async () => token, onHealth: () => {},
}
const transport = createSlackTransport(host)
let identity
try {
  await transport.authenticate()
  identity = await transport.identity()
  check('the live token authenticates with the transport', true, `${identity.name} @ ${identity.id}`)
} catch (e) {
  check('the live token authenticates with the transport', false, String(e?.message ?? e))
  await cleanup()
  process.exit(1)
}

// Everything below writes into the channel, so it only runs when asked for.
if (!wantsToPost) {
  console.log('\n  read-only checks only — pass --post --channel <name> to exercise posting')
  const failedReadOnly = results.filter((r) => !r.ok)
  console.log(`  ${results.length - failedReadOnly.length}/${results.length} checks passed`)
  process.exit(failedReadOnly.length === 0 ? 0 : 1)
}

// ── 2. a message larger than Slack's limit is chunked, and readable back ───
const LONG = 9000
const body = Array.from({ length: LONG }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
try {
  const first = await transport.post({ channel, threadTs: null }, body)
  check('a message is posted through the transport', first?.ts !== undefined, JSON.stringify(first))
  // Slack's history is not guaranteed to include a message the instant it is posted: reading
  // immediately returned one part of three, which looked like a chunking failure and was a
  // race in this script.
  await new Promise((r) => setTimeout(r, 2000))
  const history = await api('conversations.history', { channel, limit: 50, oldest: String(Math.max(0, Number(first.ts) - 5)) })
  // Everything at or after the first part belongs to this run (the script deletes what it
  // posts, so a channel it has run against before holds nothing of its own).
  const mine = (history.messages ?? []).filter((m) => Number(m.ts) >= Number(first.ts) - 1).reverse()
  const sizes = mine.map((m) => m.text.length)
  check('a 9000-character body arrives as several messages', mine.length >= 3, `parts: ${sizes.join(', ')}`)
  check('no part exceeds Slack\'s 4000-character limit', sizes.every((n) => n <= 4000), `max ${Math.max(0, ...sizes)}`)
  const rejoined = mine.map((m) => m.text.replace(/^\(\d+\/\d+\)\n/, '')).join('')
  check('the parts carry the whole body in order', rejoined === body, `${rejoined.length}/${body.length} characters`)
  check('each part is numbered', mine.every((m) => /^\(\d+\/\d+\)/.test(m.text)), mine[0]?.text.slice(0, 12))
} catch (e) {
  check('chunking against the live API', false, String(e?.message ?? e))
  await cleanup()
  process.exit(1)
}

// ── 3. replacing a message (how progress becomes the answer) ───────────────
try {
  const ts = await post('progress placeholder')
  const replaced = await transport.post({ channel, threadTs: null }, 'the answer', { replace: ts })
  check('replacing a message keeps the same id', replaced?.ts === ts, `${ts} → ${replaced?.ts}`)
  const one = await api('conversations.history', { channel, limit: 5, oldest: String(Math.max(0, Number(ts) - 2)) })
  const updated = (one.messages ?? []).find((m) => m.ts === ts)
  check('the replacement is what the channel shows', updated?.text === 'the answer', JSON.stringify(updated?.text))
} catch (e) {
  check('replacing against the live API', false, String(e?.message ?? e))
}

// ── 4. the bot's own message does not start a turn ─────────────────────────
const logPath = process.env.DEEPBOT_LOG ?? `${process.env.HOME}/.dsh/slack-state/deepbot.log`
const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').length : 0
await post('qa-slack: this is the bot talking to itself, and nothing should answer')
await new Promise((r) => setTimeout(r, 4000))
const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
const added = text.split('\n').slice(before).join('\n')
check('a message from the bot starts no turn', !/accepted channel=/.test(added), added.trim().split('\n').slice(-3).join(' | ').slice(0, 140) || '(no new lines)')

await cleanup()
const failed = results.filter((r) => !r.ok)
console.log(`\n  ${results.length - failed.length}/${results.length} live checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
