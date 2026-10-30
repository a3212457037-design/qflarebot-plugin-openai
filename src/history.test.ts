import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizePlugin } from '@qqbot/sdk'
import { createMemoryKV, createMockContext, createMockSession, type MockSessionOptions } from '@qqbot/sdk/testing'
import { createOpenAIPlugin } from './index.js'
import { defaultConfig } from './config.js'
import { conversationKey, HISTORY_TTL_SECONDS, message, parseHistory } from './history.js'
import { tips } from './responses.js'
import { createScopedKV } from '../../QFlareBot/packages/runtime/src/scoped.js'

const config = { ...defaultConfig, apiKey: 'local-history-test-credential', executionMode: 'responses' as const }
const response = (text = '回答') => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] })
const sessionFor = (options: MockSessionOptions = {}) => createMockSession({
  scene: 'c2c', event: 'qq.c2c.message', botId: 'bot-a', userId: 'user-a', targetId: 'user-a', ...options,
})

function requestContents(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  return JSON.parse(fetcher.mock.calls[index]![1]!.body as string).input.map((m: { role: string; content: string }) => message(m.role === 'assistant' ? 'model' : 'user', m.content))
}

function harness(fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response())) {
  const plugin = createOpenAIPlugin(fetcher)
  const kv = createMemoryKV()
  const ctx = { ...createMockContext(plugin, { config }), kv }
  async function invoke(command: string, argText = '', options: MockSessionOptions = {}) {
    const spec = normalizePlugin(plugin).commands.find((c) => c.name === command)!
    return spec.handler({ ctx, session: sessionFor(options), command, argText, args: argText ? [argText] : [] })
  }
  return { kv, ctx, invoke, fetcher }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('会话上下文', () => {
  it('第一轮保存 user/model，第二轮传递历史并刷新 86400 秒 TTL', async () => {
    const bot = harness()
    const put = vi.spyOn(bot.kv, 'put')
    const key = conversationKey(sessionFor())!
    await bot.invoke('ai', '问题一')
    const first = JSON.parse(bot.kv.data.get(key)!)
    expect(first.messages).toEqual([message('user', '问题一'), message('model', '回答')])
    expect(put).toHaveBeenLastCalledWith(key, first, { ttl: 86400 })
    await vi.advanceTimersByTimeAsync(10001)
    await bot.invoke('ai', '问题二')
    const second = JSON.parse(bot.kv.data.get(key)!)
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(put).toHaveBeenLastCalledWith(key, second, { ttl: HISTORY_TTL_SECONDS })
    expect(requestContents(bot.fetcher, 1)).toEqual([
      ...first.messages, message('user', '问题二'),
    ])
  })

  it('超过 6 轮只存最近 6 轮，请求最多带 12 条历史和当前问题', async () => {
    let round = 0
    const bot = harness(vi.fn<typeof fetch>().mockImplementation(async () => response(`回答${++round}`)))
    for (let n = 1; n <= 8; n++) {
      await bot.invoke('ai', `问题${n}`)
      await vi.advanceTimersByTimeAsync(10001)
    }
    const stored = JSON.parse(bot.kv.data.get(conversationKey(sessionFor())!)!)
    expect(stored.messages).toHaveLength(12)
    expect(stored.messages[0]).toEqual(message('user', '问题3'))
    expect(stored.messages[11]).toEqual(message('model', '回答8'))
    expect(stored.messages.map((m: { role: string }) => m.role)).toEqual(Array.from({ length: 6 }, () => ['user', 'model']).flat())
    const contents = requestContents(bot.fetcher, 7)
    expect(contents).toHaveLength(13)
    expect(contents[0]).toEqual(message('user', '问题2'))
    expect(contents[12]).toEqual(message('user', '问题8'))
  })

  it('超过最后成功交互 24 小时后忽略历史，即使 KV 缓存仍返回旧值', async () => {
    const bot = harness()
    await bot.invoke('ai', '旧问题')
    await vi.advanceTimersByTimeAsync(HISTORY_TTL_SECONDS * 1000)
    await bot.invoke('ai', '新问题')
    expect(requestContents(bot.fetcher, 1)).toEqual([message('user', '新问题')])
  })

  it('按机器人、场景、群和用户分别隔离，不同会话不共享历史', async () => {
    const bot = harness()
    const scopes: MockSessionOptions[] = [
      {}, { userId: 'user-b' }, { botId: 'bot-b' },
      { scene: 'group', targetId: 'group-a' }, { scene: 'group', targetId: 'group-b' },
      { scene: 'group', targetId: 'group-a', userId: 'user-b' },
      { scene: 'group', targetId: 'group-a', botId: 'bot-b' },
    ]
    for (const [i, scope] of scopes.entries()) {
      await bot.invoke('ai', `私密问题${i}`, scope)
      expect(requestContents(bot.fetcher, i)).toEqual([message('user', `私密问题${i}`)])
      await vi.advanceTimersByTimeAsync(10001)
    }
    expect(bot.kv.data.size).toBe(scopes.length)
    await bot.invoke('ai', '再次提问')
    expect(requestContents(bot.fetcher, scopes.length)).toEqual([
      message('user', '私密问题0'), message('model', '回答'), message('user', '再次提问'),
    ])
  })

  it('/reset 只删除当前历史，不请求 OpenAI，不影响其他用户和设置', async () => {
    const bot = harness()
    await bot.invoke('ai', '用户一')
    await vi.advanceTimersByTimeAsync(10001)
    await bot.invoke('ai', '用户二', { userId: 'user-b' })
    bot.kv.data.set('unrelated-setting', 'preserved')
    const otherKey = conversationKey(sessionFor({ userId: 'user-b' }))!
    const otherHistory = bot.kv.data.get(otherKey)
    const calls = bot.fetcher.mock.calls.length
    expect(await bot.invoke('reset')).toBe('当前会话的对话历史已清除。')
    expect(bot.kv.data.has(conversationKey(sessionFor())!)).toBe(false)
    expect(bot.kv.data.get(otherKey)).toBe(otherHistory)
    expect(bot.kv.data.get('unrelated-setting')).toBe('preserved')
    expect(bot.ctx.config.apiKey).toBe(config.apiKey)
    expect(bot.fetcher).toHaveBeenCalledTimes(calls)
    expect(await bot.invoke('reset')).toBe('当前会话的对话历史已清除。')
  })

  it('API 失败不写入未完成的问答，不刷新已有历史或 TTL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => response())
      .mockImplementation(async () => Response.json({ error: { code: 429 } }, { status: 429 }))
    const bot = harness(fetcher)
    await bot.invoke('ai', '成功的问题')
    const key = conversationKey(sessionFor())!
    const saved = bot.kv.data.get(key)
    const put = vi.spyOn(bot.kv, 'put')
    await vi.advanceTimersByTimeAsync(10001)
    expect(await bot.invoke('ai', '失败的问题')).toBe(tips.rate)
    expect(bot.kv.data.get(key)).toBe(saved)
    expect(put).not.toHaveBeenCalled()
  })

  it.each(['not-json', 'null', '{}', '[]', '{"messages":[]}'])('损坏 JSON 或结构 %s 不导致崩溃', async (raw) => {
    const bot = harness()
    bot.kv.data.set(conversationKey(sessionFor())!, raw)
    expect(await bot.invoke('ai', '新问题')).toBe('回答')
    expect(requestContents(bot.fetcher, 0)).toEqual([message('user', '新问题')])
    expect(JSON.parse(bot.kv.data.get(conversationKey(sessionFor())!)!).messages).toHaveLength(2)
  })

  it('拒绝半轮、错序、非文本和超长历史', () => {
    for (const messages of [
      [message('user', '未完成')],
      [message('model', '错序'), message('user', '错序')],
      [{ role: 'user', parts: [{ inlineData: {} }] }, message('model', '回答')],
      [message('user', 'x'.repeat(1001)), message('model', '回答')],
    ]) expect(parseHistory(JSON.stringify({ updatedAt: Date.now(), messages }))).toEqual([])
    expect(parseHistory('x'.repeat(65537))).toEqual([])
  })

  it('KV 读写失败仍返回有效回答，日志不包含存储异常内容或 Key', async () => {
    const bot = harness()
    const get = bot.kv.get.bind(bot.kv)
    vi.spyOn(bot.kv, 'get').mockImplementation((key) => key.startsWith('history:')
      ? Promise.reject(new Error(`private-kv ${config.apiKey}`)) : get(key))
    vi.spyOn(bot.kv, 'put').mockRejectedValue(new Error(`private-kv ${config.apiKey}`))
    const warn = vi.spyOn(bot.ctx.logger, 'warn')
    expect(await bot.invoke('ai', '问题')).toBe('回答')
    expect(warn.mock.calls.map((c) => c[1])).toEqual([{ code: 'history_read' }, { code: 'history_write' }])
    expect(JSON.stringify(warn.mock.calls)).not.toContain(config.apiKey)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-kv')
  })

  it('调用中 /reset 不会被随后完成的问答恢复历史', async () => {
    let finish!: (result: Response) => void
    const bot = harness(vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve })))
    const pending = bot.invoke('ai', '正在回答')
    await vi.waitFor(() => expect(bot.fetcher).toHaveBeenCalledTimes(1))
    await bot.invoke('reset')
    finish(response())
    expect(await pending).toBe('回答')
    expect(bot.kv.data.size).toBe(0)
  })

  it('写入期间 /reset 会在待完成写入后清除当前历史', async () => {
    const bot = harness()
    const original = bot.kv.put.bind(bot.kv)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(bot.kv, 'put').mockImplementation(async (...args) => { await gate; await original(...args) })
    const pending = bot.invoke('ai', '写入中')
    await vi.waitFor(() => expect(bot.kv.put).toHaveBeenCalledTimes(1))
    await bot.invoke('reset')
    release()
    await pending
    expect(bot.kv.data.size).toBe(0)
  })

  it('缺少用户身份时不创建共享历史', async () => {
    const bot = harness()
    expect(await bot.invoke('ai', '问题', { userId: '' })).toBe('回答')
    expect(bot.kv.data.size).toBe(0)
  })

  it('官方 KV 包装使用插件前缀，并把 TTL 按秒传给 expirationTtl', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const scoped = createScopedKV({ put } as unknown as KVNamespace, 'openai')
    await scoped.put('history:test', { messages: [] }, { ttl: HISTORY_TTL_SECONDS })
    expect(put).toHaveBeenCalledWith('p:openai:history:test', '{"messages":[]}', { expirationTtl: 86400 })
  })
})
