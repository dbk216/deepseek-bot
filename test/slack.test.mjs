/**
 * The Slack transport's outbound payloads, pinned against a stubbed Web API.
 *
 * Found live, not here: a channel-level post could never be sent, because the transport
 * always included `thread_ts` — as an empty string when a target has no thread — and Slack
 * rejects that with `no_text`. The failure was logged and then reported as success with an
 * empty `ts`, so a caller would edit a message that did not exist and believe it had
 * answered. `tools/qa-slack.mjs` caught it against the real workspace; this keeps it caught.
 *
 * No network: `globalThis.fetch` is stubbed and every request is inspected.
 *
 * Run: node test/slack.test.mjs
 */
import './dist-fresh.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSlackTransport } from '../dist/transports/slack.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Stub the Web API: record requests, answer with the shapes Slack answers with. */
function stubSlack(options = {}) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const method = String(url).split('/api/')[1] ?? ''
    // The upload URL takes raw bytes, so the body is not always JSON — parsing it unconditionally
    // threw inside this stub and the transport reported failure.
    const raw = init.body === undefined ? '' : String(init.body)
    const body = raw.startsWith('{') ? JSON.parse(raw) : {}
    calls.push({ method, body })
    const ok = options.fail?.includes(method) !== true
    // The file APIs answer with their own shapes; the chain below is for chat calls.
    if (ok && method === 'files.getUploadURLExternal') {
      return { ok: true, status: 200, json: async () => ({ ok: true, upload_url: 'https://upload.example/u/1', file_id: 'F1' }), text: async () => '' }
    }
    if (ok && method === 'files.completeUploadExternal') {
      return { ok: true, status: 200, json: async () => ({ ok: true, files: [{ id: 'F1' }] }), text: async () => '' }
    }
    const json = ok
      // chat.update answers with the same ts it updated; chat.postMessage with a new one.
      ? { ok: true, ts: method === 'chat.update' ? body.ts : `ts-${calls.length}`, channel: body.channel ?? 'C1' }
      : { ok: false, error: options.error ?? 'no_text' }
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
  }
  return { calls, restore: () => { globalThis.fetch = realFetch } }
}

function transportFor(api) {
  const logs = []
  const t = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], slackTokenRef: 'SLACK_BOT_TOKEN', chunkChars: 4000 },
    log: (...parts) => logs.push(parts.join(' ')),
    sessionCwd: async () => process.cwd(),
    credential: async () => 'xoxb-fake',
    onHealth: () => {},
  })
  t.logs = logs
  t.api = api
  return t
}

// 1. A channel-level post must not carry an empty thread_ts.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'hello')
  api.restore()
  const post = api.calls.find((c) => c.method === 'chat.postMessage')
  check('a channel post goes to chat.postMessage', post !== undefined, JSON.stringify(api.calls.map((c) => c.method)))
  check('and carries the text', post?.body?.text === 'hello', JSON.stringify(post?.body))
  check('and does NOT carry an empty thread_ts', !('thread_ts' in (post?.body ?? {})), JSON.stringify(post?.body))
  check('it returns the message id Slack gave', sent?.ts === 'ts-1', JSON.stringify(sent))
}

// 2. A threaded post still threads.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  await t.post({ channel: 'C1', threadTs: '111.222' }, 'in thread')
  api.restore()
  const post = api.calls.find((c) => c.method === 'chat.postMessage')
  check('a threaded post keeps thread_ts', post?.body?.thread_ts === '111.222', JSON.stringify(post?.body))
}

// 3. A refused post is reported as nothing, not as an empty message.
{
  const api = stubSlack({ fail: ['chat.postMessage'] })
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'hello')
  api.restore()
  check('a refused post returns null', sent === null, JSON.stringify(sent))
  check('and says why in the log', t.logs.some((l) => /reply post failed: no_text/.test(l)), t.logs.join(' | ').slice(0, 120))
}

// 4. Long text is chunked, numbered, and the first id is returned.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'x'.repeat(9000))
  api.restore()
  const posts = api.calls.filter((c) => c.method === 'chat.postMessage')
  check('9000 characters become three posts', posts.length === 3, String(posts.length))
  check('each is within the limit', posts.every((c) => c.body.text.length <= 4000), posts.map((c) => c.body.text.length).join(', '))
  check('each is numbered', posts.every((c, i) => c.body.text.startsWith(`(${i + 1}/3)`)), posts[0]?.body?.text.slice(0, 8))
  check('the first id is returned, not the last', sent?.ts === 'ts-1', JSON.stringify(sent))
}

// 5. Replacing uses chat.update and keeps the id.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'the answer', { replace: 'ts-original' })
  api.restore()
  const update = api.calls.find((c) => c.method === 'chat.update')
  check('a replace calls chat.update', update !== undefined, JSON.stringify(api.calls.map((c) => c.method)))
  check('against the given ts', update?.body?.ts === 'ts-original', JSON.stringify(update?.body))
  check('and does not post a second message', !api.calls.some((c) => c.method === 'chat.postMessage'))
  check('the returned id is the replaced one', sent?.ts === 'ts-original', JSON.stringify(sent))
}

// 6. A refused replace falls back to a new message rather than losing the answer.
{
  const api = stubSlack({ fail: ['chat.update'] })
  const t = transportFor(api)
  await t.authenticate()
  const sent = await t.post({ channel: 'C1', threadTs: null }, 'the answer', { replace: 'gone' })
  api.restore()
  check('a failed replace posts a new message', api.calls.some((c) => c.method === 'chat.postMessage'), JSON.stringify(api.calls.map((c) => c.method)))
  check('and the answer is still reported as sent', sent?.ts !== undefined && sent?.ts !== '', JSON.stringify(sent))
}

// 7. A transport built without a chunk size still sends the text.
// Found live: the QA harness passed a partial config, chunkChars was undefined, the slice
// went to NaN, and every reply was an empty body — which Slack answers with `no_text`. The
// failure was total and silent, and the cause was a missing setting.
{
  const api = stubSlack()
  const logs = []
  const bare = createSlackTransport({
    cfg: { platform: 'slack', stateDir: '.', targetChannels: ['*'], slackTokenRef: 'SLACK_BOT_TOKEN' },
    log: (...parts) => logs.push(parts.join(' ')),
    sessionCwd: async () => process.cwd(),
    credential: async () => 'xoxb-fake',
    onHealth: () => {},
  })
  await bare.authenticate()
  const sent = await bare.post({ channel: 'C1', threadTs: null }, 'hello without a configured chunk size')
  api.restore()
  const post = api.calls.find((c) => c.method === 'chat.postMessage')
  check('a missing chunk size does not empty the body', post?.body?.text === 'hello without a configured chunk size', JSON.stringify(post?.body?.text).slice(0, 60))
  check('and the message is reported as sent', sent?.ts !== undefined, JSON.stringify(sent))
}

// 8. Reply text carries clickable links, which is what a person can actually use.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  await t.post({ channel: 'C1', threadTs: null }, 'see [the docs](https://example.com/a) and **this**')
  api.restore()
  const body = api.calls.find((c) => c.method === 'chat.postMessage')?.body?.text ?? ''
  check('a markdown link becomes a Slack link', body.includes('<https://example.com/a|the docs>'), body.slice(0, 90))
  check('and the markdown form is gone', !body.includes('](https://example.com/a)'))
  check('bold still converts', body.includes('*this*'))

  const api2 = stubSlack()
  const t2 = transportFor(api2)
  await t2.authenticate()
  await t2.post({ channel: 'C1', threadTs: null }, 'bare https://example.com/b and a path /Users/x/note.docx')
  api2.restore()
  const body2 = api2.calls.find((c) => c.method === 'chat.postMessage')?.body?.text ?? ''
  check('a bare URL is left for Slack to link', body2.includes('https://example.com/b') && !body2.includes('<https://example.com/b'), body2.slice(0, 70))
  check('a local path is left as text, because it cannot be a link', body2.includes('/Users/x/note.docx'), body2.slice(-40))
}

// 9. A document is uploaded rather than named: a local path cannot be clicked, so the file travels.
{
  const api = stubSlack()
  const t = transportFor(api)
  await t.authenticate()
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-upload-'))
  const file = join(dir, 'report.docx')
  const bytes = 'pretend docx bytes'
  writeFileSync(file, bytes)
  const ok = await t.uploadFile({ channel: 'C1', threadTs: '111.222' }, file, 'the report')
  const names = api.calls.map((c) => c.method)
  const started = api.calls.find((c) => c.method === 'files.getUploadURLExternal')
  const done = api.calls.find((c) => c.method === 'files.completeUploadExternal')
  api.restore()
  check('uploading asks for a URL first', names.includes('files.getUploadURLExternal'), names.join(', '))
  check('and names the file and its size', started?.body?.filename === 'report.docx' && started?.body?.length === bytes.length, JSON.stringify(started?.body))
  check('the bytes go to the URL it was given', names.filter((x) => x === '').length === 1, names.join(', '))
  check('and it is completed into the thread', done?.body?.channel_id === 'C1' && done?.body?.thread_ts === '111.222', JSON.stringify(done?.body))
  check('with the title asked for', done?.body?.files?.[0]?.title === 'the report', JSON.stringify(done?.body?.files))
  check('and reports success', ok === true, String(ok))
  rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
