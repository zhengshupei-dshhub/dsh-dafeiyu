import assert from 'node:assert/strict'
import test from 'node:test'

import { bubblePreview, buildChatPrompt, buildFollowupMessage, extractAssistantText } from '../src/chat.js'

test('自由对话原样透传并清理空白', () => {
  assert.equal(buildChatPrompt('  今天  怎么样？ '), '今天 怎么样？')
  assert.equal(buildChatPrompt('', 'chat'), '')
})

test('任务模式带先确认的约束', () => {
  const prompt = buildChatPrompt('把插件版本升到 0.2', 'task')
  assert.match(prompt, /桌面任务/)
  assert.match(prompt, /确认再执行/)
  assert.match(prompt, /把插件版本升到 0\.2/)
})

test('从 assistant/message 抽正文，跳过 reasoning', () => {
  const event = {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '内部思考' },
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
          { type: 'tool-call', name: 'bash' },
        ],
      },
    },
  }
  assert.equal(extractAssistantText(event), '第一段\n第二段')
})

test('没有正文时返回空串', () => {
  assert.equal(extractAssistantText({}), '')
  assert.equal(extractAssistantText({ data: { message: { content: [{ type: 'reasoning', text: 'x' }] } } }), '')
})

test('气泡预览折行并截断', () => {
  assert.equal(bubblePreview('a\n\nb   c'), 'a b c')
  assert.equal(bubblePreview('长'.repeat(200)).length, 84)
  assert.equal(bubblePreview('长'.repeat(200), 40).length, 40)
})


test('followup 消息是完整 UserMessage（role 必填）', () => {
  const message = buildFollowupMessage('在吗', 'chat')
  assert.equal(message.role, 'user')
  assert.match(message.id, /^desktop-chat-/)
  assert.deepEqual(message.content, [{ type: 'text', text: '在吗' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

test('空输入不产生消息', () => {
  assert.equal(buildFollowupMessage('   ', 'chat'), undefined)
})

test('任务模式在消息正文里带确认约束', () => {
  const message = buildFollowupMessage('升级插件', 'task')
  assert.match(message.content[0].text, /桌面任务/)
  assert.match(message.content[0].text, /升级插件/)
})
