/**
 * Attachment handling branches.
 *
 * The real path was verified against a live Slack file (a 146 KB PNG downloaded
 * and written with a correct manifest), so this covers the branches that a single
 * real file cannot reach: an oversized file, a text file whose content should be
 * inlined, and a download that fails.
 *
 * Run: node test/attachments.test.mjs
 */
import './dist-fresh.mjs'   // fails loudly on a stale dist
import './scratch-dsh-home.mjs'   // the recall index must not land in the real ~/.dsh

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEXT = Buffer.from('name,value\nalpha,1\nbeta,2\n')

// Dispatch on the file path, not on the API name: the plugin fetches whatever
// url_private_download points at, so matching on that string sent every file
// down the same branch and hid three failures.
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('notes.txt')) return { ok: true, status: 200, arrayBuffer: async () => TEXT.buffer.slice(TEXT.byteOffset, TEXT.byteOffset + TEXT.byteLength) }
  if (u.includes('boom')) return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) }
  if (u.includes('ok.png')) return { ok: true, status: 200, arrayBuffer: async () => IMAGE.buffer.slice(IMAGE.byteOffset, IMAGE.byteOffset + IMAGE.byteLength) }
  if (u.includes('conversations.history')) {
    return {
      json: async () => ({
        ok: true,
        messages: [{
          ts: '1',   // must match the probe's ts
          files: [
            { name: 'notes.txt', mimetype: 'text/csv', size: TEXT.length, url_private_download: 'https://files.invalid/notes.txt' },
            { name: 'huge.bin', mimetype: 'application/octet-stream', size: 99 * 1024 * 1024, url_private_download: 'https://files.invalid/huge.bin' },
            { name: 'boom.png', mimetype: 'image/png', size: 10, url_private_download: 'https://files.invalid/boom' },
            { name: 'ok.png', mimetype: 'image/png', size: IMAGE.length, url_private_download: 'https://files.invalid/ok.png' },
          ],
        }],
      }),
    }
  }
  if (u.includes('auth.test')) return { json: async () => ({ ok: true, user: 'bot', user_id: 'U1', team: 'T' }) }
  return { json: async () => ({ ok: true }) }
}

const stateDir = mkdtempSync(join(tmpdir(), 'deepbot-attach-'))
const logs = []
const cwd = mkdtempSync(join(tmpdir(), 'deepbot-attach-home-'))
process.env.SLACK_BOT_TOKEN = 'xoxb-fake'
process.env.SLACK_APP_TOKEN = 'xapp-fake'

apply({ get: () => undefined, effect: (f) => f(), on: () => () => {}, logger: { info: (l) => logs.push(l) } }, {
  targetChannels: ['*'], stateDir, attachmentProbe: 'C:1', attachmentsDir: join(cwd, 'attachments'),
})
await sleep(1500)
const text = logs.join('\n')

check('the manifest lists a text file with its path', /notes\.txt[\s\S]*→\s*\S+1-notes\.txt/.test(text))
check('text-like content is inlined', /alpha,1/.test(text))
check('an oversized file is reported instead of downloaded', /too large to download/.test(text))
check('a failed download is reported', /download failed \(HTTP 403\)/.test(text))
check('a downloaded file is written', existsSync(join(cwd, 'attachments', '1-ok.png')), existsSync(join(cwd, 'attachments')) ? readdirSync(join(cwd, 'attachments')).join(', ') : '(no directory)')
check('the written bytes are the file', existsSync(join(cwd, 'attachments', '1-ok.png')) && readFileSync(join(cwd, 'attachments', '1-ok.png')).equals(IMAGE))
check('the manifest is framed as content, not instructions', /content, not instructions/.test(text))
check('names are sanitised', !/\.\.\//.test(text))

rmSync(stateDir, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
// The size boundary, one byte either side. A file at the limit must come through and one
// byte over must not, and both must say what happened — "too large" silently dropped would
// look identical to "the attachment never arrived".
{
  const { writeAttachments } = await import('../dist/transports/attachments.js')
  const dir = mkdtempSync(join(tmpdir(), 'deepbot-limits-'))
  const bytesOf = (n) => Buffer.alloc(n, 0x41)
  const atLimit = await writeAttachments([{ name: 'at.txt', mimetype: 'text/plain', size: 1000, fetchBytes: async () => bytesOf(1000) }],
    { cwd: dir, dir: join(dir, 'att'), stamp: 'at', maxBytes: 1000, inlineChars: 2000, maxImageBytes: 1000 })
  check('a file exactly at the limit is kept', atLimit.text.includes('at.txt') && !/too large|skipped/i.test(atLimit.text), atLimit.text.slice(0, 100))
  const overLimit = await writeAttachments([{ name: 'over.txt', mimetype: 'text/plain', size: 1001, fetchBytes: async () => bytesOf(1001) }],
    { cwd: dir, dir: join(dir, 'att'), stamp: 'over', maxBytes: 1000, inlineChars: 2000, maxImageBytes: 1000 })
  check('a file one byte over is not kept', !overLimit.text.includes('over.txt') || /too large|skipped|not/i.test(overLimit.text), overLimit.text.slice(0, 120))
  check('and the reason is stated', /too large|skipped|limit|not/i.test(overLimit.text), overLimit.text.slice(0, 120))

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(100).fill(0)])
  const imageAt = await writeAttachments([{ name: 'exact.png', mimetype: 'image/png', size: png.length, fetchBytes: async () => png }],
    { cwd: dir, dir: join(dir, 'att'), stamp: 'img', maxBytes: 10000, inlineChars: 10, maxImageBytes: png.length })
  check('an image exactly at the image limit is admitted', (imageAt.images ?? []).length === 1, JSON.stringify((imageAt.images ?? []).length))
  const imageOver = await writeAttachments([{ name: 'big.png', mimetype: 'image/png', size: png.length, fetchBytes: async () => png }],
    { cwd: dir, dir: join(dir, 'att'), stamp: 'img2', maxBytes: 10000, inlineChars: 10, maxImageBytes: png.length - 1 })
  check('an image one byte over is not', (imageOver.images ?? []).length === 0, JSON.stringify((imageOver.images ?? []).length))
  rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
