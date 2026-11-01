import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createPersonaBridge,
  dayBubble,
  diaryBubble,
  growthBubbles,
  idleBubble,
} from '../src/persona-bridge.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-persona-'))
}

function persona(overrides = {}) {
  return {
    identity: { name: '大肥鱼', role: 'coding agent', bornAt: Date.now() - 2 * 86_400_000 },
    traits: [
      { id: 'ai-jiaozhen', label: '爱较真', value: 62 },
      { id: 'dongshou', label: '动手优先', value: 45 },
    ],
    voice: [{ text: '先给结论' }],
    values: [],
    quirks: [{ text: '踩到的坑要写下来' }],
    relation: { user: '', moments: [{ text: '一起换掉了 billion-context' }] },
    diary: [{ day: '2026-10-28', text: '今天写完插件，感觉壳有点温度。', mood: '兴奋' }],
    evolution: [{ at: Date.now(), kind: 'trait', detail: '性格「爱较真」+5 → 62' }],
    stats: { growthEvents: 1, growthDay: '2026-10-28', growthToday: 1 },
    ...overrides,
  }
}

function writePersona(dir, value) {
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify(value, null, 2))
}

test('性格成长气泡带强度与阶段评语', () => {
  const bubbles = growthBubbles(persona(), [{ kind: 'trait', detail: '性格「爱较真」+5 → 62' }])
  assert.equal(bubbles.length, 1)
  assert.match(bubbles[0].message, /性格「爱较真」\+5 → 62/)
  assert.match(bubbles[0].message, /正在长成我的样子/)
  assert.match(bubbles[0].detail, /强度 62/)
})

test('说话方式 / 小习惯 / 共同经历各有说法', () => {
  const [voice] = growthBubbles(persona(), [{ kind: 'voice', detail: '新增说话方式：先给结论' }])
  assert.match(voice.message, /新的说话方式/)
  const [quirk] = growthBubbles(persona(), [{ kind: 'quirk', detail: '新增小习惯：踩到的坑要写下来' }])
  assert.match(quirk.message, /小习惯/)
  const [moment] = growthBubbles(persona(), [{ kind: 'moment', detail: '记下一段共同经历：一起换掉了 billion-context' }])
  assert.match(moment.message, /记住啦/)
})

test('日记气泡带心情且截断', () => {
  const bubble = diaryBubble(persona(), { text: '很长'.repeat(40), mood: '兴奋' })
  assert.match(bubble.message, /日记写好咯（兴奋）/)
  assert.ok(bubble.message.length < 80)
})

test('换天问候使用认识天数', () => {
  const bubble = dayBubble(persona(), 3)
  assert.match(bubble.message, /认识你第 3 天/)
})

test('闲话会从人设里取材', () => {
  const bubble = idleBubble(persona())
  assert.ok(bubble.message.length > 0)
  assert.match(bubble.detail, /人设/)
})

test('首次启动只记基线，不倒出历史成长', () => {
  const dir = tmpDir()
  writePersona(dir, persona())
  const sent = []
  const bridge = createPersonaBridge({ dir, send: (m) => sent.push(m), idleMinutes: 0 })
  bridge.start()
  assert.equal(sent.length, 0)
  bridge.stop()
})

test('新增日记后等到空闲才发气泡', () => {
  const dir = tmpDir()
  writePersona(dir, persona())
  const sent = []
  let clock = 1_000_000
  let busy = true
  const bridge = createPersonaBridge({
    dir,
    send: (m) => sent.push(m),
    isBusy: () => busy,
    idleMinutes: 0,
    now: () => clock,
  })
  bridge.start()

  const next = persona()
  next.diary.push({ day: '2026-10-28', text: '第二条日记。', mood: '好奇' })
  writePersona(dir, next)
  bridge.pollNow()
  assert.equal(sent.length, 0, '忙的时候不发')

  busy = false
  bridge.pumpNow()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'task')
  assert.equal(sent[0].task, 'persona')
  assert.match(sent[0].message, /日记写好咯（好奇）/)
  assert.match(sent[0].detail, /第 2 篇/)

  // 最小气泡间隔：立即再 pump 不会连发。
  clock += 10_000
  bridge.pumpNow()
  assert.equal(sent.length, 1)
  bridge.stop()
})

test('新增成长事件会发成长气泡', () => {
  const dir = tmpDir()
  writePersona(dir, persona())
  const sent = []
  const bridge = createPersonaBridge({ dir, send: (m) => sent.push(m), idleMinutes: 0 })
  bridge.start()

  const next = persona()
  next.traits[0].value = 70
  next.evolution.push({ at: Date.now(), kind: 'trait', detail: '性格「爱较真」+8 → 70' })
  next.stats.growthEvents = 2
  writePersona(dir, next)
  bridge.pumpNow()

  assert.equal(sent.length, 1)
  assert.match(sent[0].message, /爱较真/)
  bridge.stop()
})

test('关闭开关后不冒泡', () => {
  const dir = tmpDir()
  writePersona(dir, persona())
  const sent = []
  const bridge = createPersonaBridge({ dir, send: (m) => sent.push(m), idleMinutes: 0, enabled: false })
  bridge.start()
  const next = persona()
  next.diary.push({ day: '2026-10-28', text: '关了也要安静。' })
  writePersona(dir, next)
  bridge.pumpNow()
  assert.equal(sent.length, 0)
  bridge.stop()
})
