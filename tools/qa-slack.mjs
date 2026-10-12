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
 * Run: node tools/qa-slack.mjs [--channel <id|name>]
 */
import { readFileSync, existsSync } from 'node:fs'
import { createSlackTransport } from '../dist/transports/slack.js'

const args = process.argv.slice(2)
const channelArg = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : undefined
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
let channel = channelArg
if (channel === undefined) {
  const list = await api('conversations.list', { limit: 100, exclude_archived: true })
  if (list.ok !== true) { console.error(`cannot list channels: ${list.error}`); process.exit(2) }
  const writable = list.channels.filter((c) => !c.is_archived)
  if (writable.length === 0) { console.error('no channel the bot can see'); process.exit(2) }
  channel = writable[0].id
  console.log(`  channel: #${writable[0].name} (${channel})`)
} else if (!/^C[A-Z0-9]+$/.test(channel)) {
  const list = await api('conversations.list', { limit: 200, exclude_archived: true })
  const found = (list.channels ?? []).find((c) => c.name === channel.replace(/^#/, ''))
  if (found === undefined) { console.error(`no such channel: ${channel}`); process.exit(2) }
  channel = found.id
}

const posted = []
async function post(text) {
  const r = await api('chat.postMessage', { channel, text, unfurl_links: false })
  if (r.ok !== true) throw new Error(`chat.postMessage: ${r.error}`)
  posted.push(r.ts)
  return r.ts
}

async function cleanup() {
  let deleted = 0
  for (const ts of posted) {
    const r = await api('chat.delete', { channel, ts })
    if (r.ok === true) deleted++
  }
  console.log(`  cleanup: ${deleted}/${posted.length} messages deleted`)
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
