import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HelperProcess } from '../src/helper-process.js'

/** 假 helper：按协议吐 ready + chat，用来验证宿主侧的桌面对话接线。 */
function fakeHelper(mode = 'chat') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-fake-'))
  const file = path.join(dir, 'fake-helper.mjs')
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
console.log(JSON.stringify({ protocolVersion: 1, kind: 'ready', timestamp: Date.now() }))
setTimeout(() => {
  console.log(JSON.stringify({ protocolVersion: 1, kind: 'chat', timestamp: Date.now(), text: '在吗', mode: '${mode}' }))
}, 120)
setInterval(() => {}, 1000)
`,
    'utf8',
  )
  fs.chmodSync(file, 0o755)
  return file
}

function waitForChat(script) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for chat')), 4000)
    const helper = new HelperProcess(
      {
        command: script,
        logFile: null,
        heartbeatMs: 0,
        startupTimeoutMs: 4000,
        onChat(payload) {
          clearTimeout(timer)
          resolve({ helper, payload })
        },
      },
      { debug() {}, info() {}, warn() {}, error() {} },
    )
    helper.start()
  })
}

test('helper 发来的 chat 会被宿主收到（自由对话）', async () => {
  const { helper, payload } = await waitForChat(fakeHelper('chat'))
  assert.equal(payload.text, '在吗')
  assert.equal(payload.mode, 'chat')
  helper.stop('test')
})

test('task 模式原样透传到宿主', async () => {
  const { helper, payload } = await waitForChat(fakeHelper('task'))
  assert.equal(payload.mode, 'task')
  helper.stop('test')
})
