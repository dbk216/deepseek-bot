/**
 * `dsh gateway`: messenger setup and the service commands, run against a scratch home.
 *
 * Nothing here calls launchctl, plutil, a platform or a terminal: the command takes all of them as its
 * IO, and this suite gives it fakes that record what they were asked. The profile fixture is the
 * template the installer copies (profile/cordis.patch.yml), and a second one written the way a profile
 * edited by hand looks, so the YAML edits are checked on both.
 *
 * Run: node test/gateway.test.ts
 */
import './dist-fresh.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { gateway, mergeIds, parseIds, readProfile, slackManifest, terminalAsk, writeProfile, envSet, envValue, type GatewayIO, type RunResult } from '../dist/service/gateway.js'
import { route, usage } from '../dist/tui/cli.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const TEMPLATE = readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
/** A deepbot row the way a profile edited by hand has it: block lists, comments around them. */
const HAND = `# a profile edited by hand
- id: session-query-sqlite
  config:
    openAt: startup

# ── the deepbot row
- id: deepbot
  config:
    # Slack and the terminal
    platform: ['slack', 'local']
    targetChannels:
      - 'C0AAAAAAA'
      - tui
    replyMode: mention
    approvalPatterns: ['rm ', 'sudo ']

# ── after
- id: permission
  config:
    defaultPreset: unattended
`

const OK = { status: 0, stdout: '', stderr: '' }

/** A scratch home with a profile, a credential file, and fakes for everything outside. */
function scene({ profile = TEMPLATE, env = 'DEEPSEEK_API_KEY=sk-test\n', envMode = 0o600, installed = true, loaded = ['ai.deepbot.gateway', 'ai.deepbot.health'], vars = {}, answers = undefined, fetchReply = undefined, connects = true, lastError = null, noPid = [], boots = true, failBootout = [] }: {
  profile?: string; env?: string | null; envMode?: number; installed?: boolean; loaded?: string[]; vars?: Record<string, string>
  answers?: Array<string | null>; fetchReply?: (url: string, init: any) => { ok: boolean; status: number; body: unknown }; connects?: boolean; lastError?: string | null
  /** Loaded, with no process: launchd between restarts. */ noPid?: string[]
  /** Whether a (re)started gateway gets as far as writing its health file. */ boots?: boolean
  failBootout?: string[]
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'deepbot-gateway-'))
  const dsh = join(home, '.dsh')
  mkdirSync(join(dsh, 'profiles', 'agent'), { recursive: true })
  mkdirSync(join(dsh, 'slack-state'), { recursive: true })
  const profilePath = join(dsh, 'profiles', 'agent', 'cordis.patch.yml')
  writeFileSync(profilePath, profile)
  const envPath = join(dsh, '.env')
  if (env !== null) { writeFileSync(envPath, env); chmodSync(envPath, envMode) }
  const agents = join(home, 'Library', 'LaunchAgents')
  mkdirSync(agents, { recursive: true })
  if (installed) {
    writeFileSync(join(agents, 'ai.deepbot.gateway.plist'), '<plist/>')
    writeFileSync(join(agents, 'ai.deepbot.health.plist'), '<plist/>')
  }
  const healthPath = join(dsh, 'slack-state', 'health.json')
  let clock = 1_000_000
  const running = new Set(loaded)
  const pidless = new Set(noPid)
  const calls: string[][] = []
  const fetched: Array<{ url: string; init: any }> = []
  const asked: string[] = []
  const out: string[] = []
  const err: string[] = []
  /** The gateway coming up: it writes its health file, connected or not. */
  const boot = () => {
    pidless.delete('ai.deepbot.gateway')
    if (boots) writeFileSync(healthPath, JSON.stringify({ pid: 4242, startedAt: clock, connected: connects, connectedAt: connects ? clock : null, lastError, updatedAt: clock }))
  }
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push([cmd.split('/').pop(), ...args])
    if (cmd.endsWith('plutil')) return { status: 1, stdout: '', stderr: 'no such key' }
    const [verb, target] = args
    const label = (target ?? '').split('/').pop()
    if (verb === 'print') return running.has(label) ? { status: 0, stdout: `gui/501/${label} = {\n\tstate = ${pidless.has(label) ? 'waiting' : 'running'}\n${pidless.has(label) ? '' : '\tpid = 4242\n'}\t\tstate = active\n}`, stderr: '' } : { status: 113, stdout: '', stderr: 'Could not find service' }
    if (verb === 'bootstrap') { const name = args[2].split('/').pop().replace(/\.plist$/, ''); running.add(name); if (name === 'ai.deepbot.gateway') boot(); return OK }
    if (verb === 'bootout') { if (failBootout.includes(label)) return { status: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error' }; running.delete(label); return OK }
    if (verb === 'kickstart') { boot(); return OK }
    return OK
  }
  const queue = answers === undefined ? undefined : [...answers]
  const io: GatewayIO = {
    home, uid: 501,
    env: { ...vars },
    run,
    fetch: async (url, init) => {
      fetched.push({ url, init })
      const r = fetchReply?.(url, init) ?? { ok: true, status: 200, body: { ok: true, user: 'deepbot', team: 'acme', result: { username: 'deep_bot' }, id: '42', username: 'deepbot' } }
      return { ok: r.ok, status: r.status, json: async () => r.body }
    },
    ask: queue === undefined ? undefined : async (question) => { asked.push(question); return queue.length > 0 ? queue.shift() : '' },
    out: (t) => out.push(t), err: (t) => err.push(t),
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    waitMs: 5000,
  }
  return {
    home, io, calls, fetched, asked, out, err, profilePath, envPath, healthPath,
    launchctl: () => calls.filter((c) => c[0] === 'launchctl' && c[1] !== 'print').map((c) => c.slice(1, 3).join(' ')),
    profile: () => readFileSync(profilePath, 'utf8'),
    env: () => readFileSync(envPath, 'utf8'),
    text: () => [...out, ...err].join('\n'),
    done: () => rmSync(home, { recursive: true, force: true }),
  }
}

const SLACK = { SLACK_BOT_TOKEN: 'xoxb-1-2-abc', SLACK_APP_TOKEN: 'xapp-1-def' }

// 1. Routing: only `gateway <command>` is taken from the harness CLI.
check('route: gateway with one of its commands is the gateway CLI', route(['gateway', 'setup', 'slack']) === 'gateway' && route(['gateway', 'status']) === 'gateway' && route(['gateway', 'manifest', 'slack']) === 'gateway')
check('route: gateway alone, or with anything else, still boots the harness profile named gateway', route(['gateway']) === 'harness' && route(['gateway', 'web']) === 'harness' && route(['gateway', '--help']) === 'harness')
check('usage: the terminal\'s help names dsh gateway', usage().includes('dsh gateway <command>'))

// 2. Pure pieces.
check('ids: spaces or commas, duplicates dropped', JSON.stringify(parseIds(' C1, C2 C1 ', true)) === '["C1","C2"]')
check('ids: * alone where allowed, and not where it is not', JSON.stringify(parseIds('*', true)) === '["*"]' && parseIds('*', false) === null)
check('ids: anything but letters, digits, - and _ is refused', parseIds("C1 'x'", true) === null && parseIds('C#1', true) === null && parseIds('', true) === null)
check('ids: a negative Telegram chat id is an id', JSON.stringify(parseIds('-1001234', true)) === '["-1001234"]')
check('merge: added to a narrowed list, in order', JSON.stringify(mergeIds(['C1'], ['C2', 'C1'])) === '["C1","C2"]')
check('merge: a list that is * stays *; adding * makes it *', JSON.stringify(mergeIds(['*'], ['C2'])) === '["*"]' && JSON.stringify(mergeIds(['C1', 'tui'], ['*'])) === '["*"]')
check('env: a value is read, quotes and export allowed, empty is unset', envValue('export A="x"\nB=\n', 'A') === 'x' && envValue('B=\n', 'B') === undefined && envValue('AB=1\n', 'A') === undefined)
check('env: set replaces the first line, drops the duplicates, keeps the rest', envSet('A=1\nK=old\nB=2\nK=older\n', 'K', 'new') === 'A=1\nK=new\nB=2\n')
check('env: set appends to a file without a final newline', envSet('A=1', 'K', 'v') === 'A=1\nK=v\n' && envSet('', 'K', 'v') === 'K=v\n')

// 3. The profile: read and written in place, on the template and on a hand-edited row.
{
  const lists = readProfile(TEMPLATE)
  check('template: read', !('error' in lists) && lists.platform.join() === 'slack' && lists.targetChannels.join() === '*' && lists.allowedUsers.length === 0, JSON.stringify(lists))
  const text = writeProfile(TEMPLATE, { platform: ['slack', 'discord'] }) as string
  const changed = TEMPLATE.split('\n').map((line, i) => [line, text.split('\n')[i]]).filter(([a, b]) => a !== b)
  check('template: a second platform turns the scalar into a list, and only that line changes', changed.length === 1 && changed[0][1] === "    platform: ['slack', 'discord']", JSON.stringify(changed))
  const users = writeProfile(TEMPLATE, { allowedUsers: ['U1'] }) as string
  const at = users.split('\n').indexOf("    allowedUsers: ['U1']")
  check('template: allowedUsers is put right after targetChannels', at > 0 && users.split('\n')[at - 1] === "    targetChannels: ['*']" && users.split('\n').length === TEMPLATE.split('\n').length + 1)
  check('template: and read back', (readProfile(users) as any).allowedUsers?.join() === 'U1')
}
{
  const lists = readProfile(HAND)
  check('hand-edited: a block list is read', !('error' in lists) && lists.targetChannels.join() === 'C0AAAAAAA,tui' && lists.platform.join() === 'slack,local', JSON.stringify(lists))
  const text = writeProfile(HAND, { platform: ['slack', 'local', 'discord'], targetChannels: ['C0AAAAAAA', 'tui', 'C0BBBBBBB'] }) as string
  check('hand-edited: a flow list stays a flow list', text.includes("    platform: ['slack', 'local', 'discord']"))
  check('hand-edited: a block list stays a block list, at its indent', text.includes("    targetChannels:\n      - 'C0AAAAAAA'\n      - 'tui'\n      - 'C0BBBBBBB'\n    replyMode: mention"), text)
  const [before, after] = [HAND.split('- id: deepbot')[0], HAND.split('    approvalPatterns')[1]]
  check('hand-edited: every line outside the lists is as it was', text.startsWith(before) && text.endsWith(after) && text.includes('    # Slack and the terminal\n'))
  check('hand-edited: an unchanged list is not rewritten', writeProfile(HAND, { platform: ['slack', 'local'] }) === HAND)
}
{
  const refused = (profile: string) => { const r = readProfile(profile); return 'error' in r ? r.error : '' }
  check('refused: no deepbot row', /no `- id: deepbot` row/.test(refused('- id: other\n  config: {}\n')))
  check('refused: two deepbot rows', /2 `- id: deepbot` rows/.test(refused(`${HAND}\n- id: deepbot\n  config:\n    platform: slack\n`)))
  check('refused: a comment inside a block list', /not an item/.test(refused(HAND.replace("      - tui\n", "      # the terminal\n      - tui\n"))))
  check('refused: a list that goes on after a comment line', /continues after/.test(refused(HAND.replace("      - tui\n", "    # the terminal\n      - tui\n"))))
  check('refused: a value that is not plain', /not a plain value/.test(refused(HAND.replace("['slack', 'local']", '{ a: 1 }'))))
  check('refused: no platform line', /no platform line/.test(refused(HAND.replace("    platform: ['slack', 'local']\n", ''))))
}

// 4. setup without a terminal: every answer from the environment and the flags.
{
  const s = scene({ vars: { SLACK_BOT_TOKEN: SLACK.SLACK_BOT_TOKEN } })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup', 'slack'], s.io)
  check('setup: a missing token is named, exit 2', code === 2 && s.err.join().includes('missing: SLACK_APP_TOKEN') && s.err.join().includes('SLACK_APP_TOKEN=… dsh gateway setup slack'), s.text())
  check('setup: and nothing is written, nothing asked of the platform', s.env() === before[0] && s.profile() === before[1] && s.fetched.length === 0 && s.launchctl().length === 0)
  s.done()
}
{
  const s = scene({ env: 'DEEPSEEK_API_KEY=sk-test\nSLACK_BOT_TOKEN=xoxb-old\nOTHER=1\nSLACK_BOT_TOKEN=xoxb-older\n', envMode: 0o644, vars: { ...SLACK } })
  const code = await gateway(['setup', 'slack'], s.io)
  check('setup: both tokens from the environment, checked, saved, restarted, connected', code === 0 && s.text().includes('connected (pid 4242)'), s.text())
  check('setup: .env has each key once, the other lines as they were', s.env() === `DEEPSEEK_API_KEY=sk-test\nSLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}\nOTHER=1\nSLACK_APP_TOKEN=${SLACK.SLACK_APP_TOKEN}\n`, JSON.stringify(s.env()))
  check('setup: .env is mode 600 though it was 644', (statSync(s.envPath).mode & 0o777) === 0o600, (statSync(s.envPath).mode & 0o777).toString(8))
  check('setup: the tokens were checked with Slack, each at its own method', s.fetched.map((f) => `${f.url} ${f.init.headers?.Authorization}`).join('|') === `https://slack.com/api/auth.test Bearer ${SLACK.SLACK_BOT_TOKEN}|https://slack.com/api/apps.connections.open Bearer ${SLACK.SLACK_APP_TOKEN}`, JSON.stringify(s.fetched.map((f) => f.url)))
  check('setup: who the bot is, said', s.out.includes('SLACK_BOT_TOKEN: works — @deepbot in acme'))
  check('setup: no token in what was printed', !s.text().includes(SLACK.SLACK_BOT_TOKEN) && !s.text().includes(SLACK.SLACK_APP_TOKEN))
  check('setup: the gateway was restarted with kickstart -k', s.launchctl().join() === 'kickstart -k', s.launchctl().join())
  check('setup: the profile already served slack, so it is unchanged', s.profile() === TEMPLATE)
  // Again, with the same tokens: nothing to do.
  s.calls.length = 0; s.out.length = 0
  const again = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('setup: run again with the same answers changes nothing and restarts nothing', again === 0 && s.out.includes('nothing changed') && s.launchctl().length === 0, s.text())
  s.done()
}
for (const [name, vars, why] of [
  ['a newline in a token', { ...SLACK, SLACK_BOT_TOKEN: 'xoxb-1\nEVIL=1' }, 'xoxb-…'],
  ['a space in a token', { ...SLACK, SLACK_APP_TOKEN: 'xapp-1 2' }, 'xapp-…'],
  ['the app token given as the bot token', { ...SLACK, SLACK_BOT_TOKEN: SLACK.SLACK_APP_TOKEN }, 'xoxb-…'],
] as const) {
  const s = scene({ vars })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup', 'slack'], s.io)
  check(`setup: ${name} is refused, exit 2, nothing written`, code === 2 && s.err.join().includes(why) && s.env() === before[0] && s.profile() === before[1] && s.fetched.length === 0, s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK }, fetchReply: (url) => (url.includes('auth.test') ? { ok: true, status: 200, body: { ok: false, error: 'invalid_auth' } } : { ok: true, status: 200, body: { ok: true } }) })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup', 'slack'], s.io)
  check('verify: a token Slack refuses is exit 2, with its reason, nothing written', code === 2 && s.err.join().includes('invalid_auth') && s.env() === before[0] && s.profile() === before[1], s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK }, fetchReply: () => { throw new Error('getaddrinfo ENOTFOUND') } })
  const code = await gateway(['setup', 'slack'], s.io)
  check('verify: an unreachable platform is exit 1 — it says nothing about the token — and names --no-verify', code === 1 && s.err.join().includes('could not reach slack.com') && s.err.join().includes('--no-verify'), s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK } })
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('verify: --no-verify asks nothing of the platform', code === 0 && s.fetched.length === 0, s.text())
  s.done()
}
{
  const token = '123456:AAbb_cc-dd'
  const s = scene({ vars: { TELEGRAM_BOT_TOKEN: token }, fetchReply: () => ({ ok: true, status: 200, body: { ok: true, result: { username: 'deep_bot' } } }) })
  const code = await gateway(['setup', 'telegram', '--users', '111 222'], s.io)
  check('telegram: checked with getMe at its token\'s URL', s.fetched.length === 1 && s.fetched[0].url === `https://api.telegram.org/bot${token}/getMe`, s.fetched[0]?.url)
  const lists = readProfile(s.profile()) as any
  check('telegram: added beside slack, with its people', code === 0 && lists.platform.join() === 'slack,telegram' && lists.allowedUsers.join() === '111,222', s.text())
  s.done()
}
{
  const token = 'MTA.abc_d.ef-g'
  const s = scene({ vars: { DISCORD_BOT_TOKEN: token }, fetchReply: () => ({ ok: true, status: 200, body: { id: '42', username: 'deepbot' } }) })
  const code = await gateway(['setup', 'discord'], s.io)
  check('discord: checked at users/@me with a Bot header', code === 0 && s.fetched[0].url === 'https://discord.com/api/v10/users/@me' && s.fetched[0].init.headers.Authorization === `Bot ${token}`)
  check('discord: with nobody listed, it warns that anyone can run it', s.out.some((l) => l.includes('anyone who can message the bot on discord can run it')), s.text())
  s.done()
}
{
  const s = scene({ profile: HAND, vars: { DISCORD_BOT_TOKEN: 'a.b.c' } })
  const code = await gateway(['setup', 'discord', '--channels', 'C0BBBBBBB,C0AAAAAAA', '--no-verify'], s.io)
  const lists = readProfile(s.profile()) as any
  check('channels: added to a narrowed list, once each', code === 0 && lists.targetChannels.join() === 'C0AAAAAAA,tui,C0BBBBBBB', lists.targetChannels.join())
  s.done()
}
{
  const s = scene({ vars: { DISCORD_BOT_TOKEN: 'a.b.c' } })
  const code = await gateway(['setup', 'discord', '--channels', 'C0BBBBBBB', '--no-verify'], s.io)
  check('channels: a list that is * is left as it is', code === 0 && (readProfile(s.profile()) as any).targetChannels.join() === '*')
  s.done()
}
{
  const s = scene({ vars: { DISCORD_BOT_TOKEN: 'a.b.c' } })
  const before = s.profile()
  const code = await gateway(['setup', 'discord', '--channels', 'C#1'], s.io)
  check('channels: an id that is not one is exit 2 before anything else', code === 2 && s.profile() === before && s.fetched.length === 0, s.text())
  s.done()
}
{
  const s = scene({ profile: HAND.replace('    replyMode: mention\n', "    allowedUsers: ['U0AAAAAAA']\n    replyMode: mention\n"), vars: { TELEGRAM_BOT_TOKEN: '1:a' } })
  await gateway(['setup', 'telegram', '--no-verify'], s.io)
  check('people: once the list has ids, a new platform\'s people are warned they are not answered', s.out.some((l) => l.includes('no one on telegram is answered until their id is in allowedUsers')), s.text())
  s.done()
}
{
  // Without the terminal, and without its channel: setup has to add both.
  const s = scene({ profile: HAND.replace("    platform: ['slack', 'local']", '    platform: slack').replace('      - tui\n', '') })
  const code = await gateway(['setup', 'local', '--no-restart'], s.io)
  const lists = readProfile(s.profile()) as any
  check('local: the terminal needs no token, and its channel is added to a narrowed list', code === 0 && lists.platform.join() === 'slack,local' && lists.targetChannels.join() === 'C0AAAAAAA,tui', s.text())
  check('local: --no-restart restarts nothing', s.launchctl().length === 0 && s.out.some((l) => l.includes('--no-restart')))
  s.done()
}
for (const [name, profile] of [['no deepbot row', '- id: other\n  config: {}\n'], ['a comment inside a block list', HAND.replace("      - tui\n", "      # x\n      - tui\n")]] as const) {
  const s = scene({ profile, vars: { DISCORD_BOT_TOKEN: 'a.b.c' } })
  const code = await gateway(['setup', 'discord', '--no-verify'], s.io)
  check(`setup: a profile with ${name} is exit 1, edited by hand, nothing written`, code === 1 && s.err.join().includes('Edit the deepbot row by hand') && s.profile() === profile && !s.env().includes('DISCORD'), s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK, DSH_HOME: '/elsewhere' } })
  const code = await gateway(['setup', 'slack'], s.io)
  check('setup: a DSH_HOME other than ~/.dsh is refused', code === 2 && s.err.join().includes('DSH_HOME'), s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK }, loaded: [] })
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('setup: with the gateway not running, nothing is started; it says how', code === 0 && s.launchctl().length === 0 && s.out.some((l) => l.includes('dsh gateway start')), s.text())
  s.done()
}
{
  const s = scene({ vars: { ...SLACK }, connects: false, lastError: 'invalid_auth' })
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('setup: a restart that does not connect is exit 1, with the last error', code === 1 && s.err.join().includes('last error: invalid_auth'), s.text())
  s.done()
}

// 5. setup at a terminal.
{
  const s = scene({ answers: ['', 'xapp-new-1', '7'] })
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('terminal: a token not set and not typed is missing, exit 2', code === 2 && s.err.join().includes('missing: SLACK_BOT_TOKEN') && !s.err.join().includes('run this at a terminal'), s.text())
  s.done()
}
{
  const s = scene({ env: 'SLACK_BOT_TOKEN=xoxb-kept\n', answers: ['', 'xapp-new-1', 'U0CCCCCCC'] })
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('terminal: Enter keeps a token that is set; a typed one is saved', code === 0 && s.env() === 'SLACK_BOT_TOKEN=xoxb-kept\nSLACK_APP_TOKEN=xapp-new-1\n', JSON.stringify(s.env()))
  check('terminal: it asks who may talk to it, and lists them', s.asked[2]?.startsWith('Who may talk to it?') && (readProfile(s.profile()) as any).allowedUsers.join() === 'U0CCCCCCC', JSON.stringify(s.asked))
  s.done()
}
{
  const s = scene({ answers: [null] })
  const before = [s.env(), s.profile()]
  const code = await gateway(['setup', 'telegram'], s.io)
  check('terminal: ctrl+c is exit 130, nothing written', code === 130 && s.env() === before[0] && s.profile() === before[1], s.text())
  s.done()
}

// 6. remove.
{
  const s = scene({ profile: HAND, env: 'SLACK_BOT_TOKEN=xoxb-1\n' })
  const code = await gateway(['remove', 'slack'], s.io)
  check('remove: the platform leaves the list, its token stays', code === 0 && (readProfile(s.profile()) as any).platform.join() === 'local' && s.env() === 'SLACK_BOT_TOKEN=xoxb-1\n', s.text())
  check('remove: a profile left with the terminal only waits for the process, not a connection', s.text().includes('running (pid 4242)'), s.text())
  const last = await gateway(['remove', 'local'], s.io)
  check('remove: the only platform is refused', last === 1 && (readProfile(s.profile()) as any).platform.join() === 'local', s.text())
  s.done()
}

// 7. start, stop, restart.
{
  const s = scene()
  const code = await gateway(['stop'], s.io)
  check('stop: the probe first, then the gateway', code === 0 && s.launchctl().join('|') === 'bootout gui/501/ai.deepbot.health|bootout gui/501/ai.deepbot.gateway', s.launchctl().join('|'))
  s.calls.length = 0
  const started = await gateway(['start'], s.io)
  check('start: the gateway, then its probe, and it connects', started === 0 && s.launchctl().join('|').startsWith('bootstrap gui/501|bootstrap gui/501') && s.calls.filter((c) => c[1] === 'bootstrap').map((c) => c[3].split('/').pop()).join() === 'ai.deepbot.gateway.plist,ai.deepbot.health.plist' && s.text().includes('connected'), s.text())
  s.calls.length = 0
  const again = await gateway(['start'], s.io)
  check('start: already running says so and starts nothing', again === 0 && s.launchctl().length === 0 && s.out.some((l) => l.startsWith('already running (pid 4242)')))
  s.calls.length = 0
  const restarted = await gateway(['restart'], s.io)
  check('restart: kickstart -k, and it connects', restarted === 0 && s.launchctl().join() === 'kickstart -k', s.launchctl().join())
  s.done()
}
{
  const s = scene({ installed: false, loaded: [] })
  const code = await gateway(['start'], s.io)
  check('start: not installed is exit 1, and launchctl is not asked to do anything', code === 1 && s.launchctl().length === 0 && s.err.join().includes('install'), s.text())
  s.done()
}
{
  const s = scene({ loaded: [] })
  const code = await gateway(['stop'], s.io)
  check('stop: nothing running says so', code === 0 && s.out.includes('not running') && s.launchctl().length === 0)
  s.done()
}

// 8. status.
{
  const s = scene({ env: `DEEPSEEK_API_KEY=sk-secret\nSLACK_BOT_TOKEN=${SLACK.SLACK_BOT_TOKEN}\nSLACK_APP_TOKEN=${SLACK.SLACK_APP_TOKEN}\n` })
  writeFileSync(s.healthPath, JSON.stringify({ pid: 4242, startedAt: 999_000, connected: true, connectedAt: 999_000, lastError: null, updatedAt: 999_990 }))
  const code = await gateway(['status', '--json'], s.io)
  let parsed = null
  try { parsed = JSON.parse(s.out.join('\n')) } catch { /* checked below */ }
  check('status --json: parses, healthy, exit 0', code === 0 && parsed?.healthy === true && parsed.service.pid === 4242 && parsed.profile.platforms.join() === 'slack', s.text())
  check('status --json: tokens are reported as set, never shown', parsed?.credentials.SLACK_BOT_TOKEN === true && !s.text().includes('xoxb-') && !s.text().includes('sk-secret'))
  s.out.length = 0
  writeFileSync(s.healthPath, JSON.stringify({ pid: 4242, startedAt: 1, connected: true, updatedAt: 1 }))
  const stale = await gateway(['status'], s.io)
  check('status: a stale heartbeat is exit 1 and says stale', stale === 1 && s.out.some((l) => l.includes('(stale)')), s.text())
  s.done()
}
{
  const s = scene({ env: null })
  const code = await gateway(['status'], s.io)
  check('status: a missing token is exit 1 and named', code === 1 && s.out.some((l) => l.includes('SLACK_BOT_TOKEN missing')), s.text())
  s.done()
}

// 9. The Slack manifest asks for what docs/setup.md asks for.
{
  const s = scene()
  const code = await gateway(['manifest', 'slack'], s.io)
  let m = null
  try { m = JSON.parse(s.out.join('\n')) } catch { /* checked below */ }
  const setup = readFileSync(new URL('../docs/setup.md', import.meta.url), 'utf8')
  const step = /3\. \*\*OAuth & Permissions\*\*([\s\S]*?)\n4\./.exec(setup)?.[1] ?? ''
  const documented = [...step.matchAll(/`([a-z_]+:[a-z_]+)`/g)].map((x) => x[1])
  const scopes = m?.oauth_config?.scopes?.bot ?? []
  check('manifest: JSON, Socket Mode on, interactivity on', code === 0 && m?.settings?.socket_mode_enabled === true && m.settings.interactivity.is_enabled === true)
  check('manifest: every bot scope docs/setup.md lists is in it', documented.length >= 8 && documented.every((x) => scopes.includes(x)), `documented: ${documented.join(' ')}`)
  check('manifest: the events the setup names', JSON.stringify(m?.settings?.event_subscriptions?.bot_events) === '["app_mention","message.im"]')
  check('manifest: the same as slackManifest()', JSON.stringify(m) === JSON.stringify(slackManifest()))
  s.done()
}

// 10. The terminal prompt: raw mode, backspace, no echo for a secret, ctrl+c.
{
  const prompt = (secret: boolean, ...chunks: string[]) => {
    const input = new EventEmitter() as any
    const modes: boolean[] = []
    input.setRawMode = (on: boolean) => { modes.push(on) }
    input.resume = () => {}
    input.pause = () => {}
    let shown = ''
    const output = { write: (t: string) => { shown += t; return true } } as any
    const answer = terminalAsk(input, output)('Token:', secret)
    for (const chunk of chunks) input.emit('data', Buffer.from(chunk))
    return answer.then((value) => ({ value, shown, modes, listeners: input.listenerCount('data') }))
  }
  const typed = await prompt(false, 'abx', '\x7f', '\x1b[A', 'c\r')
  check('prompt: typed, backspace, an arrow key ignored, Enter', typed.value === 'abc' && typed.shown === 'Token: abx\b \bc\n' && typed.modes.join() === 'true,false' && typed.listeners === 0, JSON.stringify(typed))
  const secret = await prompt(true, 'xoxb-1-2\r')
  check('prompt: a secret is not echoed', secret.value === 'xoxb-1-2' && secret.shown === 'Token: \n', JSON.stringify(secret.shown))
  const cancelled = await prompt(true, 'xo\x03')
  check('prompt: ctrl+c is null, and raw mode is undone', cancelled.value === null && cancelled.modes.join() === 'true,false')
}

// 11. Usage.
{
  const s = scene()
  check('usage: an unknown option is exit 2', await gateway(['status', '--channels', 'x'], s.io) === 2)
  check('usage: a stray argument is exit 2', await gateway(['stop', 'now'], s.io) === 2)
  check('usage: --help is exit 0', await gateway(['setup', '--help'], s.io) === 0 && s.out.join().includes('dsh gateway setup <slack|telegram|discord|local>'))
  s.done()
}

// 12. What the review found, each pinned — with a control where the fixture could pass by accident.
{
  const s = scene({ noPid: ['ai.deepbot.gateway'] })
  const st = await gateway(['status'], s.io)
  check('M1 status: a job loaded with no process says so, exit 1', st === 1 && s.out.some((l) => l.includes('loaded, not running')), s.text())
  s.calls.length = 0
  const code = await gateway(['start'], s.io)
  check('M1 start: a job loaded with no process is kickstarted, not called running', code === 0 && s.launchctl().join() === 'kickstart gui/501/ai.deepbot.gateway' && !s.out.some((l) => l.startsWith('already running')), s.text())
  s.done()
}
{
  const s = scene({ vars: { TELEGRAM_BOT_TOKEN: '1:a' }, lastError: 'Conflict: terminated by other getUpdates request' })
  const code = await gateway(['setup', 'telegram', '--no-verify', '--users', '1'], s.io)
  check('M2: with two platforms, one connected and another failing after it is exit 1, with its error', code === 1 && s.err.join().includes('another reported an error: Conflict'), s.text())
  s.done()
  const t = scene({ vars: { TELEGRAM_BOT_TOKEN: '1:a' } })
  const ok = await gateway(['setup', 'telegram', '--no-verify', '--users', '1'], t.io)
  check('M2 control: with none failing it is exit 0, and says it cannot tell which connected', ok === 0 && t.out.some((l) => l.includes('does not say which')), t.text())
  t.done()
}
{
  const withUsers = (list: string) => HAND.replace('    replyMode: mention\n', `    allowedUsers: ${list}\n    replyMode: mention\n`)
  check('M3: an unquoted number in a list is refused, and says to quote it', /is a number to YAML: quote it, '123456789'/.test((readProfile(withUsers('[123456789]')) as any).error ?? ''), JSON.stringify(readProfile(withUsers('[123456789]'))))
  check('M3 control: the same id quoted is read', (readProfile(withUsers("['123456789']")) as any).allowedUsers?.join() === '123456789')
}
{
  const s = scene({ vars: { ...SLACK }, boots: false })
  writeFileSync(s.healthPath, JSON.stringify({ pid: 1, startedAt: 1, connected: true, updatedAt: 1 }))
  const code = await gateway(['setup', 'slack', '--no-verify'], s.io)
  check('M4: the last process\'s "connected" does not count after a restart that never comes up', code === 1 && s.err.join().includes('not connected within'), s.text())
  s.done()
}
{
  const s = scene({ profile: HAND, vars: { TELEGRAM_BOT_TOKEN: '1:a' } })
  const before = s.profile()
  const code = await gateway(['setup', 'telegram', '--channels', '*', '--no-verify'], s.io)
  check('M6: * for one platform, with another served, is refused without --yes, nothing written', code === 2 && s.err.join().includes('every channel on slack') && s.err.join().includes('--yes') && s.profile() === before && !s.env().includes('TELEGRAM'), s.text())
  const yes = await gateway(['setup', 'telegram', '--channels', '*', '--no-verify', '--yes', '--no-restart'], s.io)
  check('M6: and taken with --yes', yes === 0 && (readProfile(s.profile()) as any).targetChannels.join() === '*', s.text())
  // At a terminal it is asked, and answered the way the other confirmation is: y or yes.
  const u = scene({ profile: HAND, vars: { TELEGRAM_BOT_TOKEN: '1:a' }, answers: ['', 'y'] })
  const asked = await gateway(['setup', 'telegram', '--channels', '*', '--no-verify', '--no-restart'], u.io)
  check('M6: at a terminal, y is enough', asked === 0 && u.asked[1]?.includes('[y/N]') && (readProfile(u.profile()) as any).targetChannels.join() === '*', JSON.stringify({ asked: u.asked, text: u.text() }))
  u.done()
  s.done()
}
{
  const token = '123456:AAbb_cc-dd'
  const s = scene({ vars: { TELEGRAM_BOT_TOKEN: token }, fetchReply: (url) => { throw new Error(`request to ${url} failed, reason: ${url}`) } })
  const code = await gateway(['setup', 'telegram'], s.io)
  check('L1: a fetch error naming the token\'s URL twice shows the token neither time', code === 1 && !s.text().includes(token) && s.err.join().includes('could not reach api.telegram.org'), s.text())
  s.done()
}
{
  const row = (lines: string) => HAND.replace("    targetChannels:\n      - 'C0AAAAAAA'\n      - tui\n", lines)
  const written = writeProfile(row(`    targetChannels: ["C1", "o'k"]\n`), { targetChannels: ['C1', "o'k", 'C2'] }) as string
  check('L2: a quote inside a value is doubled when written, and read back as it was', written.includes("    targetChannels: ['C1', 'o''k', 'C2']") && (readProfile(written) as any).targetChannels.join() === "C1,o'k,C2", written)
  check('L2: an alias, a tag or null is refused, not taken as a name', ['*anchor', '!tag', 'null', '~'].every((v) => /not a plain value/.test((readProfile(row(`    targetChannels: [${v}]\n`)) as any).error ?? '')))
  check('L2: items at two indents are refused', /different indents/.test((readProfile(row('    targetChannels:\n      - C1\n        - C2\n')) as any).error ?? ''))
  const rowLevel = HAND.replace('- id: deepbot\n  config:\n', '- id: deepbot\n  platform: discord\n  config:\n')
  check('L2: a key outside config: is not the setting', (readProfile(rowLevel) as any).platform?.join() === 'slack,local', JSON.stringify(readProfile(rowLevel)))
  const block = HAND.replace("    platform: ['slack', 'local']\n", '    notes: |\n      platform: discord\n')
  check('L2: a key inside a block of text is not the setting', /no platform line/.test((readProfile(block) as any).error ?? ''), JSON.stringify(readProfile(block)))
}
check('L3: a CRLF profile is refused by name', /line endings/.test((readProfile(HAND.replace(/\n/g, '\r\n')) as any).error ?? ''))
check('L4: in a CRLF .env the key is replaced, not added twice, and every line keeps CRLF', envSet('A=1\r\nK=old\r\nB=2\r\n', 'K', 'new') === 'A=1\r\nK=new\r\nB=2\r\n' && envValue('K=old\r\n', 'K') === 'old', JSON.stringify(envSet('A=1\r\nK=old\r\nB=2\r\n', 'K', 'new')))
{
  const s = scene({ env: 'TELEGRAM_BOT_TOKEN=1:saved\n', vars: { TELEGRAM_BOT_TOKEN: '1:fromshell' }, answers: ['n'] })
  const code = await gateway(['setup', 'telegram', '--no-verify', '--no-restart'], s.io)
  check('L5: at a terminal, a shell token that differs from the saved one is asked about; No keeps the saved one', code === 0 && s.asked[0]?.includes('differs from the saved one') && s.env() === 'TELEGRAM_BOT_TOKEN=1:saved\n', JSON.stringify({ asked: s.asked, env: s.env() }))
  s.done()
  const t = scene({ env: 'TELEGRAM_BOT_TOKEN=1:saved\n', vars: { TELEGRAM_BOT_TOKEN: '1:fromshell' }, answers: ['y'] })
  await gateway(['setup', 'telegram', '--no-verify', '--no-restart'], t.io)
  check('L5 control: Yes takes the shell\'s', t.env() === 'TELEGRAM_BOT_TOKEN=1:fromshell\n', JSON.stringify(t.env()))
  t.done()
}
check('L6: a Slack token typed where ids go is not an id', parseIds('xoxb-1-2-abc', false) === null && parseIds('U1 xapp-1-def', false) === null)
{
  const reply = (app: string) => (url: string) => (url.includes('auth.test') ? { ok: true, status: 200, body: { ok: true, user: 'bot', team: 'acme', bot_id: 'B1' } }
    : url.includes('bots.info') ? { ok: true, status: 200, body: { ok: true, bot: { app_id: app } } } : { ok: true, status: 200, body: { ok: true } })
  const tokens = { SLACK_BOT_TOKEN: 'xoxb-1-2-abc', SLACK_APP_TOKEN: 'xapp-1-A0M-2' }
  const s = scene({ vars: tokens, fetchReply: reply('A0X') })
  const before = s.env()
  const code = await gateway(['setup', 'slack'], s.io)
  check('L9: a bot token and an app-level token from two Slack apps are refused, exit 2, nothing written', code === 2 && s.err.join().includes('A0X') && s.err.join().includes('A0M') && s.env() === before, s.text())
  s.done()
  const t = scene({ vars: tokens, fetchReply: reply('A0M') })
  check('L9 control: from one app they are taken', await gateway(['setup', 'slack'], t.io) === 0, t.text())
  t.done()
}
{
  const s = scene({ env: 'SLACK_BOT_TOKEN=x\nSLACK_APP_TOKEN=y\n' })
  writeFileSync(s.healthPath, JSON.stringify({ pid: 999, startedAt: 999_000, connected: true, updatedAt: 999_990 }))
  const code = await gateway(['status'], s.io)
  check('L11: a health file from another pid than the running one is not healthy, and says so', code === 1 && s.out.some((l) => l.includes('from pid 999')), s.text())
  s.done()
}
{
  const s = scene({ failBootout: ['ai.deepbot.gateway'] })
  const code = await gateway(['stop'], s.io)
  check('L15: a gateway that will not stop gets its probe back', code === 1 && s.launchctl().join('|') === 'bootout gui/501/ai.deepbot.health|bootout gui/501/ai.deepbot.gateway|bootstrap gui/501', s.launchctl().join('|'))
  s.done()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
