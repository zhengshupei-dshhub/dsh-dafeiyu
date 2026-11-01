// 桌面聊天：把桌宠输入框里的文字变成一次 Agent 回复，并把回复压缩成气泡。
// 这里保持纯函数，方便单测；真正的投递（agent.followup）在 plugin.js。

export const CHAT_MODES = ['chat', 'task']

/** 桌面输入 → 发给 Agent 的文本。task 模式要求先确认再执行。 */
export function buildChatPrompt(text, mode = 'chat') {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  if (mode === 'task') {
    return `【桌面任务】用户在桌宠输入框里布置了任务。先复述你的理解并确认再执行，不要直接动手：\n${clean}`
  }
  return clean
}

/**
 * 构造一条完整的 UserMessage。
 * Agent.followup 会把入参原样 splice 进 inbox，不会补字段——缺 role 会让
 * 之后每次请求都带上一条非法消息（上游报 422 missing field `role`）。
 */
export function buildFollowupMessage(text, mode = 'chat', id) {
  const prompt = buildChatPrompt(text, mode)
  if (!prompt) return undefined
  return {
    id: id ?? `desktop-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }
}

/** 从 assistant/message 事件里抽出正文（跳过 reasoning 与工具调用）。 */
export function extractAssistantText(event) {
  const parts = event?.data?.message?.content
  if (!Array.isArray(parts)) return ''
  const out = []
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') out.push(part.text)
  }
  return out.join('\n').trim()
}

/** 气泡预览：压成一行，超长截断。桌宠气泡保持短，默认 84 字。 */
export const BUBBLE_MAX_CHARS = 84
export function bubblePreview(text, max = BUBBLE_MAX_CHARS) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
