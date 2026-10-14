#!/usr/bin/env node
/**
 * dsh: the bot in a terminal.
 *
 *   dsh [--name <gateway>] [--socket <path>] [--tenant <name>] [--resume <conversation>]
 *   dsh <anything else>   handed to the DeepSeek Harness CLI, whose name this shares
 *
 * Connects to a running gateway whose deepbot row serves `platform: 'local'` (alone or in a list
 * with Slack). The conversation, its memory and its session live in that gateway; this process is
 * only the screen, so quitting loses nothing and `--resume` picks the conversation up again.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { constants } from 'node:os'
import { App } from './app.js'
import { Connection, discover } from './client.js'
import { bind, COMMAND_INFO, createCommands, HARNESS_CLI, parseArgs, resumeHint, route, USAGE, type Commands } from './cli.js'
import { fileFinder } from './files.js'
import { appendHistory, historyFile, loadHistory } from './history.js'
import { processIO, restoreOnExit } from './render/terminal.js'

/** `dsh <harness arguments>`: run the harness CLI with them, and leave with its status. */
function forward(argv: string[]): never {
  const bin = process.env.DSH_BIN || HARNESS_CLI
  if (!existsSync(bin)) { process.stderr.write(`dsh: DeepSeek Harness CLI가 없음: ${bin} (DSH_BIN으로 경로 지정)\n`); process.exit(127) }
  // A DSH_BIN that is this command would call itself forever.
  if (realpathSync(bin) === realpathSync(process.argv[1])) { process.stderr.write('dsh: DSH_BIN이 이 명령 자신을 가리킴 — harness CLI 경로로 지정\n'); process.exit(127) }
  const run = spawnSync(bin, argv, { stdio: 'inherit' })
  if (run.error) { process.stderr.write(`dsh: ${run.error.message}\n`); process.exit(127) }
  process.exit(run.signal ? 128 + (constants.signals[run.signal] ?? 0) : (run.status ?? 1))
}

function main(): void {
  const argv = process.argv.slice(2)
  if (route(argv) === 'harness') forward(argv)
  const parsed = parseArgs(argv)
  if ('error' in parsed) { process.stderr.write(`${parsed.error}\n\n${USAGE}`); process.exit(2) }
  if (parsed.help) { process.stdout.write(USAGE); return }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('dsh: 터미널(TTY)에서 실행해야 함\n'); process.exit(2) }

  let socketPath = parsed.socket
  if (socketPath === undefined) {
    const found = discover(parsed.name)
    if ('error' in found) { process.stderr.write(`dsh: ${found.error}\n`); process.exit(2) }
    socketPath = found.socket
  }

  let connection: Connection | null = null
  let commands: Commands | null = null
  const findFiles = fileFinder()
  const history = historyFile(process.env)
  const app = new App({
    intercept: (text) => commands?.intercept(text) ?? false,
    commands: COMMAND_INFO,
    files: (query) => findFiles(app.status.workspace, query),
    remember: (text) => appendHistory(history, text),
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
      if (resume) process.stdout.write(resumeHint(resume))
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
  app.editor.load(loadHistory(history))
  restoreOnExit(app.terminal)
  app.start()
  connection.start()
}

main()
