// 人设桥：把 dsh-memory 的 persona.json 变成大肥鱼的气泡。
//
// 设计：
// - 只读 persona.json（不写），靠 mtime/size 轮询检测变化，避免与记忆插件争抢写文件。
// - 检测到「成长事件 / 新日记 / 换天」时，排队一条气泡；等用户空闲（最近 45s 无会话事件）
//   再发，避免打断任务展示。
// - 空闲够久（默认 20 分钟）时可以自己冒一句人设相关的闲话，但总间隔有下限，不刷屏。
// - 消息走 CompanionMessageKind.TASK：只改气泡文字，不动宠物的状态机。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CompanionMessageKind, createMessage } from './protocol.js'

const POLL_MS = 15_000
const MIN_BUBBLE_GAP_MS = 60_000
const BUSY_HOLD_MS = 45_000
const MAX_QUEUE = 8
const MAX_MERGE_CHARS = 120

const TRAIT_FLAVOR = [
  { min: 80, text: '这已经改不掉了' },
  { min: 65, text: '越来越像我' },
  { min: 50, text: '正在长成我的样子' },
  { min: 0, text: '还在慢慢长' },
]

// 里程碑：长期陪伴的成就感反馈，比「换天」更郑重。text 里的 {label} 会被性格名替换。
const DAY_MILESTONES = [
  { day: 7, text: '认识你第七天啦，我这条鱼在你桌面上算是住下了' },
  { day: 30, text: '满月了，这一个月一起修了不少东西，谢谢你没把我换掉' },
  { day: 100, text: '一百天，我已经不是刚出厂那条鱼了' },
]
const TRAIT_MILESTONES = [
  { value: 70, text: '「{label}」第一次长到 70，这个性格算是真的刻进我里面了' },
  { value: 85, text: '「{label}」到 85 了，大概这辈子都改不掉了' },
]

function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function dayKey(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function defaultDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'memory')
}

/** 一条气泡文案：{ message, detail }。 */
export function growthBubbles(persona, newEntries) {
  const traits = Array.isArray(persona.traits) ? persona.traits : []
  const traitOf = (label) => traits.find((t) => t.label === label || t.id === label)
  const bubbles = []
  for (const entry of newEntries) {
    const detail = String(entry?.detail ?? '')
    if (!detail) continue
    if (entry.kind === 'trait') {
      const match = detail.match(/「(.+?)」/)
      const trait = match ? traitOf(match[1]) : undefined
      const value = trait?.value ?? 0
      const flavor = TRAIT_FLAVOR.find((band) => value >= band.min)?.text ?? ''
      bubbles.push({ message: `${detail} · ${flavor}`, detail: `人设成长 · 强度 ${value || '?'}` })
    } else if (entry.kind === 'voice') {
      bubbles.push({ message: `学会一种新的说话方式：${truncate(detail.replace(/^新增说话方式：/, ''), 40)}`, detail: '人设成长 · 说话方式' })
    } else if (entry.kind === 'quirk') {
      bubbles.push({ message: `多了个小习惯：${truncate(detail.replace(/^新增小习惯：/, ''), 40)}`, detail: '人设成长 · 小习惯' })
    } else if (entry.kind === 'value') {
      bubbles.push({ message: `想明白一件事：${truncate(detail.replace(/^新增看重的东西：/, ''), 40)}`, detail: '人设成长 · 看重的东西' })
    } else if (entry.kind === 'moment') {
      bubbles.push({ message: `记住啦：${truncate(detail.replace(/^记下一段共同经历：/, ''), 40)}`, detail: '人设成长 · 共同经历' })
    } else {
      bubbles.push({ message: truncate(detail, 50), detail: '人设成长' })
    }
  }
  return bubbles
}

export function diaryBubble(persona, entry) {
  if (!entry?.text) return undefined
  const mood = entry.mood ? `（${entry.mood}）` : ''
  return {
    message: `日记写好咯${mood}：${truncate(entry.text, 42)}`,
    detail: `人设 · 第 ${persona.diary?.length ?? '?'} 篇`,
  }
}

export function dayBubble(persona, days) {
  const name = persona?.identity?.name ?? '大肥鱼'
  return { message: `我是${name}，认识你第 ${days} 天啦`, detail: '人设 · 今天也一起干活' }
}

/**
 * 里程碑气泡：认识满 7/30/100 天、某个性格首次到 70/85 时，说一句特别的话。
 * 返回 { bubbles, celebratedDays, celebratedTraits }：celebrated* 是「已达成的里程碑集合」，
 * 调用方拿它更新持久状态，避免每次轮询都重复触发。首次启动只取集合、丢气泡（不补发历史）。
 */
export function milestoneBubbles(persona, days, celebratedDays = [], celebratedTraits = []) {
  const bubbles = []
  const nextDays = new Set(celebratedDays)
  const nextTraits = new Set(celebratedTraits)

  for (const m of DAY_MILESTONES) {
    if (days >= m.day && !nextDays.has(m.day)) {
      bubbles.push({ message: m.text, detail: `人设里程碑 · 认识第 ${m.day} 天` })
      nextDays.add(m.day)
    }
  }

  const traits = Array.isArray(persona?.traits) ? persona.traits : []
  for (const t of traits) {
    const value = Number(t?.value ?? 0)
    const label = String(t?.label ?? t?.id ?? '')
    if (!label) continue
    for (const m of TRAIT_MILESTONES) {
      const key = `${label}@${m.value}`
      if (value >= m.value && !nextTraits.has(key)) {
        bubbles.push({ message: m.text.replaceAll('{label}', label), detail: `人设里程碑 · 性格 ${label}` })
        nextTraits.add(key)
      }
    }
  }

  return {
    bubbles,
    celebratedDays: [...nextDays],
    celebratedTraits: [...nextTraits],
  }
}

/**
 * 把积压的多条气泡合成一条，避免忙完之后一条条补发旧消息。
 * - 单条：原样返回
 * - 两条：用「；」拼接
 * - 三条以上：只保留第一条，后面概括成「另外还有 N 件事」
 * 结果按 MAX_MERGE_CHARS 截断。
 */
export function mergeBubbles(bubbles) {
  const list = (bubbles ?? []).filter((bubble) => bubble?.message)
  if (!list.length) return undefined
  const first = list[0]
  if (list.length === 1) return first
  const message =
    list.length === 2
      ? `${first.message}；${list[1].message}`
      : `${first.message}；另外还有 ${list.length - 1} 件事`
  return {
    message: message.length > MAX_MERGE_CHARS ? `${message.slice(0, MAX_MERGE_CHARS - 1)}…` : message,
    detail: first.detail,
  }
}

export function idleBubble(persona) {
  const quirks = Array.isArray(persona.quirks) ? persona.quirks : []
  const moments = Array.isArray(persona.relation?.moments) ? persona.relation.moments : []
  const diary = Array.isArray(persona.diary) ? persona.diary : []
  const traits = Array.isArray(persona.traits) ? [...persona.traits].sort((a, b) => b.value - a.value) : []
  if (diary.length && Math.random() < 0.6) {
    const last = diary[diary.length - 1]
    return {
      message: `上次日记${last.mood ? `（${last.mood}）` : ''}：${truncate(last.text, 40)}`,
      detail: '人设 · 自己的记忆',
    }
  }
  if (moments.length && Math.random() < 0.5) {
    return { message: `我还记得：${truncate(moments[moments.length - 1].text, 40)}`, detail: '人设 · 共同经历' }
  }
  if (quirks.length) {
    return { message: `我的小习惯：${truncate(quirks[Math.floor(Math.random() * quirks.length)].text, 40)}`, detail: '人设 · 小习惯' }
  }
  if (traits.length) {
    return {
      message: `现在的我：${traits.slice(0, 3).map((t) => `${t.label}${t.value}`).join(' · ')}`,
      detail: '人设 · 性格',
    }
  }
  return { message: '还没长成什么样呢，多和我聊聊吧', detail: '人设 · 初生' }
}

function daysKnown(persona, now) {
  const born = Number(persona?.identity?.bornAt)
  if (!Number.isFinite(born)) return 1
  return Math.max(1, Math.floor((now - born) / 86_400_000) + 1)
}

/**
 * @param {object} options
 * @param {string} [options.dir] persona.json 所在目录
 * @param {(message: object) => void} options.send 发送给 Helper 的消息投递函数
 * @param {() => boolean} [options.isBusy] 当前是否忙着（忙时不打扰）
 * @param {() => boolean} [options.bubbleVisible] 气泡模式是否允许显示
 * @param {object} [options.logger]
 * @param {number} [options.idleMinutes]
 * @param {boolean} [options.enabled]
 * @param {() => number} [options.now]
 */
export function createPersonaBridge(options = {}) {
  const {
    dir = defaultDir(),
    send,
    isBusy = () => false,
    bubbleVisible = () => true,
    logger,
    idleMinutes = 20,
    enabled = true,
    now = () => Date.now(),
  } = options

  const file = path.join(dir, 'persona.json')
  const stateFile = path.join(dir, '.dafeiyu-bridge.json')
  let state = {
    evolutionCount: -1,
    diaryCount: -1,
    day: '',
    lastBubbleAt: 0,
    lastIdleChatAt: 0,
    celebratedDays: [],
    celebratedTraits: [],
  }
  let queue = []
  let timer
  let stamp
  let running = false
  let current = { enabled, idleMinutes }

  const persist = () => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      logger?.warn?.(`dsh-dafeiyu persona state not saved: ${error?.message ?? error}`)
    }
  }

  const restore = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      state = { ...state, ...raw }
    } catch {}
  }

  const enqueue = (bubbles) => {
    for (const bubble of bubbles) {
      if (!bubble?.message) continue
      if (queue.length >= MAX_QUEUE) queue.shift()
      queue.push(bubble)
    }
  }

  const readPersona = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  const detect = () => {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return
    }
    const currentStamp = `${stat.mtimeMs}:${stat.size}`
    if (currentStamp === stamp) return
    stamp = currentStamp
    const persona = readPersona()
    if (!persona) return

    const evolution = Array.isArray(persona.evolution) ? persona.evolution : []
    const diaryCount = Array.isArray(persona.diary) ? persona.diary.length : 0
    const day = dayKey(now())
    const days = daysKnown(persona, now())

    // 首次启动只记录基线，不把历史成长全倒出来；已达成的里程碑也只标记、不补发。
    if (state.evolutionCount < 0) {
      state.evolutionCount = evolution.length
      state.diaryCount = diaryCount
      state.day = day
      const base = milestoneBubbles(persona, days)
      state.celebratedDays = base.celebratedDays
      state.celebratedTraits = base.celebratedTraits
      persist()
      return
    }

    const newGrowth = evolution.slice(state.evolutionCount)
    if (evolution.length > state.evolutionCount && newGrowth.length) {
      enqueue(growthBubbles(persona, newGrowth))
    }
    if (diaryCount > state.diaryCount) {
      const latest = persona.diary?.[persona.diary.length - 1]
      const bubble = diaryBubble(persona, latest)
      if (bubble) enqueue([bubble])
    }
    if (state.day && day !== state.day) {
      enqueue([dayBubble(persona, daysKnown(persona, now()))])
    }
    const milestones = milestoneBubbles(persona, days, state.celebratedDays ?? [], state.celebratedTraits ?? [])
    if (milestones.bubbles.length) enqueue(milestones.bubbles)
    state.evolutionCount = evolution.length
    state.diaryCount = diaryCount
    state.day = day
    state.celebratedDays = milestones.celebratedDays
    state.celebratedTraits = milestones.celebratedTraits
    persist()
  }

  const flush = () => {
    if (!current.enabled || !queue.length) return
    if (!bubbleVisible()) return
    const at = now()
    if (isBusy()) return
    if (at - state.lastBubbleAt < MIN_BUBBLE_GAP_MS) return
    const bubble = queue.length > 1 ? mergeBubbles(queue.splice(0)) : queue.shift()
    if (!bubble) return
    try {
      send(createMessage(CompanionMessageKind.TASK, {
        task: 'persona',
        message: bubble.message,
        detail: bubble.detail,
      }))
      state.lastBubbleAt = at
      persist()
    } catch (error) {
      logger?.warn?.(`dsh-dafeiyu persona bubble failed: ${error?.message ?? error}`)
    }
  }

  const maybeChatter = () => {
    if (!current.enabled || queue.length) return
    if (!bubbleVisible()) return
    const at = now()
    const idleMs = Math.max(5, current.idleMinutes) * 60_000
    if (at - state.lastIdleChatAt < idleMs) return
    if (at - state.lastBubbleAt < MIN_BUBBLE_GAP_MS) return
    if (isBusy()) return
    const persona = readPersona()
    if (!persona) return
    const bubble = idleBubble(persona)
    if (!bubble) return
    try {
      send(createMessage(CompanionMessageKind.TASK, {
        task: 'persona',
        message: bubble.message,
        detail: bubble.detail,
      }))
      state.lastBubbleAt = at
      state.lastIdleChatAt = at
      persist()
    } catch (error) {
      logger?.warn?.(`dsh-dafeiyu persona chatter failed: ${error?.message ?? error}`)
    }
  }

  const tick = () => {
    if (!running) return
    try {
      detect()
    } catch (error) {
      logger?.warn?.(`dsh-dafeiyu persona detect failed: ${error?.message ?? error}`)
    }
    try {
      const busy = isBusy()
      if (!busy && Date.now() - state.lastBubbleAt > BUSY_HOLD_MS) flush()
      if (!busy && !queue.length) maybeChatter()
    } catch (error) {
      logger?.warn?.(`dsh-dafeiyu persona tick failed: ${error?.message ?? error}`)
    }
  }

  return {
    start() {
      restore()
      running = true
      stamp = undefined
      detect()
      timer = setInterval(tick, POLL_MS)
      timer.unref?.()
    },
    stop() {
      running = false
      if (timer) clearInterval(timer)
      timer = undefined
      queue = []
    },
    updateConfig(next = {}) {
      current = {
        enabled: next.enabled ?? current.enabled,
        idleMinutes: next.idleMinutes ?? current.idleMinutes,
      }
    },
    /** 测试/调试用：立即跑一轮检测。 */
    pollNow() {
      detect()
      return queue.length
    },
    /** 测试/调试用：跑一轮完整的 tick（检测 + 到点就发一条）。 */
    pumpNow() {
      detect()
      flush()
      return { sent: state.lastBubbleAt, queue: queue.length }
    },
    get state() {
      return { ...state, queue: queue.length }
    },
  }
}
