#!/usr/bin/env node
/**
 * The terminal UI's path against a real gateway and a real model, in an isolated instance.
 *
 * What the unit suites cannot show: that the harness really streams to the adapter, that a turn's
 * ask_user_question really reaches the terminal and its answer really reaches the model, and that a
 * conversation's history can be read back. Like the scenarios, this needs a model credential, so CI
 * does not run it.
 *
 * Isolation, as run-scenario.mjs does it: its own profile (DEEPBOT_TEST_PROFILE, default agent-test),
 * a fresh agent home, its own port, and a --patch overlay that serves only the local transport — it
 * never connects to Slack.
 *
 * Usage: node test/tui-live.mjs [--keep]      Exits 0 when every check passed.
 */
import './dist-fresh.mjs'

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_BIN = process.env.DSH_BIN ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PROFILE = process.env.DEEPBOT_TEST_PROFILE ?? 'agent-test'
const PORT = process.env.DEEPBOT_TEST_PORT ?? '19596'
const LIVE_HOME = process.env.DEEPBOT_LIVE_HOME ?? join(homedir(), 'dsh-agent')
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const HOME = join(homedir(), `dsh-agent-test-tui-${Date.now().toString(36)}`)
const NAME = `tui-live-${process.pid}`
const keep = process.argv.includes('--keep')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(DSH_BIN)) { console.error(`dsh not found: ${DSH_BIN}`); process.exit(2) }
mkdirSync(join(HOME, 'memory'), { recursive: true })
writeFileSync(join(HOME, '.deepbot-root'), '')
for (const file of ['AGENTS.md', 'CLAUDE.md']) if (existsSync(join(LIVE_HOME, file))) cpSync(join(LIVE_HOME, file), join(HOME, file))
const overlay = join(HOME, 'tui-live.patch.yml')
writeFileSync(overlay, [
  '# Serve only the terminal: no Slack connection from a test instance.',
  '- id: deepbot',
  '  config:',
  '    platform: local',
  "    targetChannels: ['tui']",
  `    stateDir: ${JSON.stringify(join(HOME, 'plugin-state'))}`,
  `    tuiName: ${NAME}`,
  "    approvalPatterns: ['rm ']",
  '',
].join('\n'))

console.log(`profile : ${PROFILE}\nhome    : ${HOME}\nport    : ${PORT}\n`)
const env = { ...process.env }
for (const k of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) delete env[k]
// Launcher options (--profile, --patch) come before the app's (--port, --no-open).
const gateway = spawn(DSH_BIN, ['--profile', PROFILE, '--patch', overlay, '--port', PORT, '--no-open'], { cwd: HOME, env, stdio: ['ignore', 'pipe', 'pipe'] })
let gatewayOutput = ''
gateway.stdout.on('data', (d) => { gatewayOutput += d })
gateway.stderr.on('data', (d) => { gatewayOutput += d })

async function finish(code) {
  try { gateway.kill('SIGTERM') } catch { /* gone */ }
  await sleep(1500)
  if (gateway.exitCode === null) { try { gateway.kill('SIGKILL') } catch { /* gone */ } }
  if (!keep) rmSync(HOME, { recursive: true, force: true })
  else console.log(`kept: ${HOME}`)
  process.exit(code)
}

// The socket, from the discovery file the gateway writes.
const discovery = join(DSH_HOME, 'run', 'deepbot-tui', `${NAME}.json`)
let socketPath = null
for (let i = 0; i < 120 && socketPath === null; i++) {
  await sleep(250)
  try { const d = JSON.parse(readFileSync(discovery, 'utf8')); if (existsSync(d.socket)) socketPath = d.socket } catch { /* not yet */ }
  if (gateway.exitCode !== null) break
}
if (socketPath === null) {
  console.error('the gateway did not open a terminal socket\n--- gateway output ---\n' + gatewayOutput.split('\n').slice(-30).join('\n'))
  await finish(2)
}

const frames = []
let buffer = ''
const socket = connect(socketPath)
socket.setEncoding('utf8')
socket.on('data', (d) => {
  buffer += d
  let i
  while ((i = buffer.indexOf('\n')) !== -1) { frames.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1) }
})
await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
const send = (frame) => socket.write(JSON.stringify(frame) + '\n')
async function waitFor(predicate, ms = 120000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const hit = frames.find(predicate); if (hit) return hit; await sleep(100) }
  return null
}

send({ type: 'hello', version: 1 })
const ready = await waitFor((f) => f.type === 'ready', 10000)
check('the gateway answers hello with a conversation', ready !== null)

// 1. A streamed answer.
send({ type: 'message', text: '1부터 30까지 숫자를 쉼표로만 나열해줘. 다른 말은 하지 마.' })
const answer = await waitFor((f) => f.type === 'post' && f.answer === true)
const streamed = frames.filter((f) => f.type === 'stream' && f.kind === 'text').map((f) => f.text).join('')
check('the answer was streamed before it was posted', frames.filter((f) => f.type === 'stream').length >= 3, `${frames.filter((f) => f.type === 'stream').length} stream frames`)
check('the streamed text is the answer', answer !== null && streamed.trim() === answer.text.trim(), JSON.stringify({ streamed: streamed.slice(0, 60), answer: answer?.text?.slice(0, 60) }))
check('the answer is right', answer !== null && /1,\s*2,\s*3/.test(answer.text) && answer.text.includes('30'))
await waitFor((f) => f.type === 'typing' && f.on === false, 10000)
const usage = await waitFor((f) => f.type === 'panel' && f.usage?.tokens > 0, 15000)
check("the conversation's token usage reaches the terminal", usage !== null, JSON.stringify(usage?.usage))
// Not a check: whether this deployment's model route reports a context window is a fact to record.
console.log(`  info  context window reported: ${usage?.usage?.contextPct === null || usage === null ? 'no (ctx % not shown)' : `yes (${usage.usage.contextPct}%)`}`)

// 2. A question from the turn, answered from the terminal.
const mark = frames.length
send({ type: 'message', text: 'ask_user_question 도구로 나에게 "A" 와 "B" 중 하나를 고르게 해. 내가 고르면 고른 글자 하나만 답해.' })
const question = await waitFor((f) => f.type === 'question')
check('the question reaches the terminal', question !== null && question.questions?.[0]?.options?.length >= 2, JSON.stringify(question?.questions?.[0]))
if (question !== null) {
  const q = question.questions[0]
  const pick = q.options.find((o) => /B/.test(o.label)) ?? q.options[q.options.length - 1]
  send({ type: 'answer', id: question.id, answers: [{ id: q.id, selected: [pick.label] }] })
  const reply = await waitFor((f, i) => f.type === 'post' && f.answer === true && frames.indexOf(f) >= mark)
  check('the answer reaches the model', reply !== null && /B/.test(reply.text), JSON.stringify(reply?.text?.slice(0, 80)))
}

// 3. The conversation can be read back (the index is refreshed after each turn, in the background).
let history = null
for (let i = 0; i < 20 && (history === null || history.items.length < 2); i++) {
  await sleep(1500)
  frames.length = 0
  send({ type: 'history' })
  history = await waitFor((f) => f.type === 'history', 5000)
}
check('its history comes back from the recall index', (history?.items?.length ?? 0) >= 2, `${history?.items?.length ?? 0} items`)

socket.end()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await finish(failed.length === 0 ? 0 : 1)
