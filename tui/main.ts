#!/usr/bin/env node
/**
 * deepbot-tui: the bot in a terminal.
 *
 *   deepbot-tui [--name <gateway>] [--socket <path>] [--tenant <name>] [--resume <conversation>]
 *
 * Connects to a running gateway whose deepbot row serves `platform: 'local'` (alone or in a list
 * with Slack). The conversation, its memory and its session live in that gateway; this process is
 * only the screen, so quitting loses nothing and `--resume` picks the conversation up again.
 */
import { App } from './app.js'
import { Connection, discover } from './client.js'
import { bind, createCommands, parseArgs, USAGE, type Commands } from './cli.js'
import { processIO, restoreOnExit } from './render/terminal.js'

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) { process.stderr.write(`${parsed.error}\n\n${USAGE}`); process.exit(2) }
  if (parsed.help) { process.stdout.write(USAGE); return }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('deepbot-tui: 터미널(TTY)에서 실행해야 함\n'); process.exit(2) }

  let socketPath = parsed.socket
  if (socketPath === undefined) {
    const found = discover(parsed.name)
    if ('error' in found) { process.stderr.write(`deepbot-tui: ${found.error}\n`); process.exit(2) }
    socketPath = found.socket
  }

  let connection: Connection | null = null
  let commands: Commands | null = null
  const app = new App({
    intercept: (text) => commands?.intercept(text) ?? false,
    io: processIO(process.stdin, process.stdout),
    env: process.env,
    platform: process.platform,
    backend: {
      send(text) { if (!connection?.send({ type: 'message', text })) app.notice('gateway에 연결되어 있지 않아 보내지 못함', 'error') },
      cancel() { connection?.send({ type: 'cancel' }) },
      action(id) { if (!connection?.send({ type: 'action', id })) app.notice('gateway에 연결되어 있지 않아 보내지 못함', 'error') },
      view(kind, id, owner) { connection?.send({ type: 'view', kind, ...(id !== undefined ? { id } : {}), ...(owner !== undefined ? { owner } : {}) }) },
      agentSend(id, text) { if (!connection?.send({ type: 'agent.send', id, text })) app.notice('gateway에 연결되어 있지 않아 보내지 못함', 'error') },
      agentInterrupt(id) { connection?.send({ type: 'agent.interrupt', id }) },
      jobKill(id, owner) { connection?.send({ type: 'job.kill', id, owner }) },
      answer(id, answers) { if (!connection?.send({ type: 'answer', id, answers })) app.notice('gateway에 연결되어 있지 않아 답을 보내지 못함 — 다시 연결되면 질문이 다시 열림', 'error') },
    },
    onExit(code) {
      connection?.close()
      const resume = connection?.conversation
      if (resume) process.stdout.write(`이어서 대화하려면: deepbot-tui --resume ${resume}\n`)
      process.exit(code)
    },
  })
  connection = new Connection({
    socketPath,
    conversation: parsed.resume,
    tenant: parsed.tenant,
    onFrame: (frame) => bind(app, frame, commands ?? undefined),
    onRollback: (message) => commands?.rolledBack(message),
    onState: (state, detail) => {
      if (state === 'connecting') app.setStatus({ connected: false, link: '연결 중…' })
      else if (state === 'disconnected') app.setStatus({ connected: false, link: `연결 끊김 · ${detail ?? '재연결 중'}` })
    },
  })
  commands = createCommands(app, connection, { resumeOnStart: parsed.resume !== undefined })
  restoreOnExit(app.terminal)
  app.start()
  connection.start()
}

main()
