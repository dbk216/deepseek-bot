#!/usr/bin/env node
/**
 * The TUI against a scripted backend, for looking at it in a real terminal.
 *
 * No gateway and no model: every message is answered with a canned, streamed reply that includes
 * a failed attempt and a tool step, so the renderer's moving parts can be watched (and driven
 * with tmux `send-keys` / captured with `capture-pane`) without a deployment.
 *
 * Run: node test/tui-demo.ts
 */
import './dist-fresh.ts'

import { App } from '../dist/tui/app.js'
import { processIO, restoreOnExit } from '../dist/tui/render/terminal.js'

const REPLY = [
  '## 배포 일정',
  '어제 #dev 스레드 기준으로 정리하면, 배포는 **staging**에 먼저 올리고 하루 지켜본 뒤 production으로 가. :warning: 롤백 기준은 에러율 1% 초과.',
  '',
  '- staging: 오늘 `npm run deploy:staging`',
  '- production: 내일 오전, [런북](https://example.com/runbook) 따라서',
  '',
  '> mixed text wraps by width — The quick brown fox jumps over the lazy dog.',
  '',
  '```bash',
  'npm run deploy:staging && npm run smoke -- --env staging',
  '```',
].join('\n')

let timers = []
const app = new App({
  io: processIO(process.stdin, process.stdout),
  env: process.env,
  platform: process.platform,
  onExit: (code) => {
    process.stdout.write('deepbot-tui demo: 종료\n')
    process.exit(code)
  },
  backend: {
    send(text) {
      app.turnStarted()
      let i = 0
      const words = REPLY.split(/(?<=[ \n])/)
      const later = (ms, fn) => timers.push(setTimeout(fn, ms))
      later(150, () => app.delta('잠깐, 다시 '))
      later(400, () => app.resetAttempt())
      later(600, () => app.toolCall({ name: 'recall', title: `"${text.slice(0, 20)}" · 2 passages` }))
      const tick = () => {
        if (i >= words.length) { app.final(REPLY); app.turnEnded(); app.setStatus({ tokens: app.status.tokens + 1830, contextPct: Math.min(100, (app.status.contextPct ?? 0) + 7) }); return }
        app.delta(words[i++])
        later(35, tick)
      }
      later(700, tick)
    },
    cancel() {
      for (const t of timers) clearTimeout(t)
      timers = []
      app.notice('중단했어.', 'warn')
      app.turnEnded()
    },
  },
})
restoreOnExit(app.terminal)
app.start()
app.setStatus({ connected: true, preset: 'ask', model: 'deepseek-v4.1-flash', workspace: '~/dsh-agent', session: 'tui-demo-0001' })
