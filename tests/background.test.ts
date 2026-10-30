import { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryKV, createMockContext, createMockSession } from '@qqbot/sdk/testing'
import { normalizePlugin, extractManifest, type DBStatement, type PluginDB, type Session } from '@qqbot/sdk'
import { scopeSql } from '@qqbot/sdk/sqlScope'
import { defaultConfig, type Config } from '../src/config.js'
import { createOpenAIPlugin } from '../src/index.js'
import { ensureBackground, processBackground, reserveBackground, type Task } from '../src/background.js'
import { RESPONSES_URL } from '../src/responses.js'
import { conversationKey, loadHistory, message } from '../src/history.js'
import { loadPending, splitText, MORE_TIP } from '../src/delivery.js'
import { webhookRoutes } from '../src/webhook.js'
const config: Config = { ...defaultConfig, apiKey: 'local-background-test-credential' }
const result = (text = '后台回答', id = 'resp_test', status = 'completed') => ({ id, status, output: [
  { type: 'reasoning', summary: [{ type: 'summary_text', text: '内部推理不可见' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
] })
function sqlite(): PluginDB {
  const sql = new DatabaseSync(':memory:')
  const prepared = (text: string) => sql.prepare(scopeSql(text, 'p_openai_'))
  const db = {
    table: (name: string) => 'p_openai_' + name,
    exec: async (text: string) => { sql.exec(scopeSql(text, 'p_openai_')) },
    run: async (text: string, ...params: unknown[]) => ({ changes: Number(prepared(text).run(...params as never[]).changes) }),
    all: async (text: string, ...params: unknown[]) => prepared(text).all(...params as never[]),
    first: async (text: string, ...params: unknown[]) => prepared(text).get(...params as never[]) ?? null,
    batch: async (items: DBStatement[]) => {
      sql.exec('BEGIN')
      try { const out = []; for (const item of items) out.push({ ...await db.run(item.sql, ...(item.params ?? [])), results: [] }); sql.exec('COMMIT'); return out }
      catch (e) { sql.exec('ROLLBACK'); throw e }
    },
  }
  return db as PluginDB
}
async function harness(scene: 'c2c' | 'group' = 'c2c') {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === 'POST'
    ? Response.json({ id: 'resp_test', status: 'queued' }) : Response.json(result()))
  let plugin = createOpenAIPlugin(fetcher)
  const db = sqlite(); const kv = createMemoryKV()
  const ctx = { ...createMockContext(plugin, { config, botId: 'bot', db, publicUrl: 'https://bot.test' }), kv }
  ctx.logger.warn = vi.fn()
  ctx.api.sendMessage = vi.fn().mockResolvedValue({ ok: true, status: 200, raw: {} })
  const session = createMockSession({ scene, botId: 'bot', targetId: scene === 'group' ? 'group' : 'user', userId: 'user', messageId: 'm1', timestamp: Date.now(), atMe: true, event: scene === 'group' ? 'qq.group.at_message' : 'qq.c2c.message', content: '你好' })
  await ensureBackground(ctx)
  const invoke = async (name = 'ai', text = '你好', s: Session = session) => normalizePlugin(plugin).commands.find(c => c.name === name)!.handler({ ctx, session: s, argText: text, args: [text], command: name })
  const poll = () => processBackground(ctx, config, fetcher)
  const task = () => db.first<Task>('SELECT * FROM {async_tasks} ORDER BY created DESC LIMIT 1')
  const ordinary = (s: Session = session) => normalizePlugin(plugin).regex[0]!.handler({ ctx, session: s, match: ['你'] })
  return { ctx, fetcher, session, db, kv, invoke, poll, task, ordinary, restart: () => { plugin = createOpenAIPlugin(fetcher) }, plugin }
}
afterEach(() => vi.useRealTimers())
describe('SDK聊天、后台持久化与投递', () => {
  it.each(['c2c', 'group'] as const)('%s 普通文字后台提交，61秒后新实例Cron自动回复一次', async scene => {
    vi.useFakeTimers(); const b = await harness(scene)
    expect(await b.ordinary()).toBeUndefined()
    expect(b.session.replies).toEqual([])
    expect(await b.task()).toMatchObject({ state: 'pending', interaction: 'resp_test', model: config.model })
    b.restart(); await vi.advanceTimersByTimeAsync(61000); await b.poll(); await b.poll()
    expect(b.ctx.api.sendMessage).toHaveBeenCalledExactlyOnceWith({ scene, id: b.session.targetId }, '后台回答', { messageId: 'm1', msgSeq: 1 })
    expect(await b.task()).toMatchObject({ state: 'delivered', seq: 1 })
    expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([message('user', '你好'), message('model', '后台回答')])
  })
  it('queued与in_progress继续等待，不当作失败回复', async () => {
    vi.useFakeTimers(); const b = await harness(); await b.invoke()
    for (const status of ['queued', 'in_progress']) {
      b.fetcher.mockResolvedValue(Response.json({ id: 'resp_test', status }))
      await b.poll(); expect(b.ctx.api.sendMessage).not.toHaveBeenCalled()
      expect(await b.task()).toMatchObject({ state: 'pending' })
      await vi.advanceTimersByTimeAsync(61000)
    }
    b.fetcher.mockResolvedValue(Response.json(result())); await b.poll()
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
  })
  it('同消息与同会话跨实例只能提交一次；并行Cron不能重复投递', async () => {
    const b = await harness()
    const reserve = await Promise.allSettled([reserveBackground(b.ctx, b.session, config), reserveBackground(b.ctx, b.session, config)])
    expect(reserve.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    b.restart(); expect(await b.invoke()).toContain('已有后台任务'); expect(b.fetcher).not.toHaveBeenCalled()
    const c = await harness(); await c.invoke(); await Promise.all([c.poll(), c.poll()])
    expect(c.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
  })
  it('第二轮复用上下文，聊天模型切换只影响本会话，后台默认生效', async () => {
    vi.useFakeTimers(); const b = await harness(); await b.invoke(); await b.poll()
    await vi.advanceTimersByTimeAsync(11000)
    expect(await b.invoke('model', '2')).toContain('gpt-6.1-sol')
    b.fetcher.mockImplementation(async (_url, init) => init?.method === 'POST' ? Response.json({ id: 'resp_second', status: 'queued' }) : Response.json(result('第二轮回答', 'resp_second')))
    const next = { ...b.session, messageId: 'm2', timestamp: Date.now() }
    await b.invoke('ai', '继续', next)
    const body = JSON.parse(b.fetcher.mock.calls.at(-1)![1]!.body as string)
    expect(body.model).toBe('gpt-6.1-sol')
    expect(body.input).toEqual([{ role: 'user', content: '你好' }, { role: 'assistant', content: '后台回答' }, { role: 'user', content: '继续' }])
    await b.poll(); expect(await loadHistory(b.kv, conversationKey(b.session)!)).toHaveLength(4)
    expect(await b.invoke('model', '', { ...b.session, userId: 'other' })).toContain('跟随后台默认')
  })
  it('群未@、附件、非文本、空白及其他命令均不触发', async () => {
    const b = await harness()
    for (const patch of [
      { scene: 'group' as const, atMe: false }, { attachments: [{ url: 'https://attachment.test' }] },
      { event: 'qq.interaction' as const }, { content: '' }, { content: '   ' }, { content: '/sid' }, { content: '/t2i test' }, { content: '/ai 问题' },
    ]) expect(await b.ordinary({ ...b.session, ...patch } as Session)).toBeUndefined()
    expect(b.fetcher).not.toHaveBeenCalled()
  })
  it('/search只发送一次OpenAI原生工具请求，Cron携带真实来源自动回复', async () => {
    const b = await harness(); await b.invoke('search', '今日新闻')
    expect(b.fetcher).toHaveBeenCalledTimes(1)
    expect(b.fetcher.mock.calls[0]![0]).toBe(RESPONSES_URL)
    expect(JSON.parse(b.fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ tools: [{ type: 'web_search' }], tool_choice: 'required' })
    b.fetcher.mockResolvedValue(Response.json({ ...result(), output: [{ type: 'web_search_call', status: 'completed' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '真实新闻', annotations: [{ type: 'url_citation', title: '真实来源', url: 'https://source.test/' }] }] }],
    }))
    await b.poll()
    expect((b.ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toContain('https://source.test/')
    expect(b.fetcher.mock.calls.every(([url]) => String(url).startsWith(RESPONSES_URL))).toBe(true)
  })
  it('关闭搜索仍可聊天，/search返回关闭提示且不提交任务', async () => {
    const b = await harness(); b.ctx.config = { ...config, enableWebSearch: false }
    expect(await b.invoke('search')).toContain('联网搜索未开启')
    expect(b.fetcher).not.toHaveBeenCalled()
    await b.invoke(); expect(JSON.parse(b.fetcher.mock.calls[0]![1]!.body as string)).not.toHaveProperty('tools')
  })
  it.each(['failed', 'empty', 'search_failed'])('%s返回固定提示，不写失败轮历史，也不反复处理', async kind => {
    const b = await harness(); await b.invoke()
    const value = kind === 'failed' ? { id: 'resp_test', status: 'failed', error: { code: 'insufficient_quota', message: config.apiKey } }
      : kind === 'empty' ? result('') : { ...result(), output: [{ type: 'web_search_call', status: 'failed' }, ...result().output] }
    b.fetcher.mockResolvedValue(Response.json(value)); await b.poll(); await b.poll()
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
    const text = String((b.ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1])
    expect(text).toContain(kind === 'failed' ? '额度不足' : kind === 'empty' ? '未返回有效回答' : '联网搜索未能完成')
    expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([])
    expect(JSON.stringify([text, (b.ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls])).not.toContain(config.apiKey)
  })
  it('用户、机器人与群隔离，/reset仅取消当前会话任务', async () => {
    const b = await harness()
    const sessions = [b.session, { ...b.session, userId: 'other', targetId: 'other', messageId: 'm2' },
      { ...b.session, scene: 'group' as const, targetId: 'g1', messageId: 'm3' },
      { ...b.session, scene: 'group' as const, targetId: 'g2', messageId: 'm4' }]
    const tasks = []
    for (const s of sessions) tasks.push(await reserveBackground(b.ctx, s, config))
    tasks.push(await reserveBackground({ ...b.ctx, botId: 'other-bot' }, { ...b.session, botId: 'other-bot' }, config))
    expect(new Set(tasks.map(t => t.conversation)).size).toBe(5)
    expect(await b.invoke('reset')).toContain('已清除')
    expect(await b.db.first('SELECT state FROM {async_tasks} WHERE id=?', tasks[0]!.id)).toMatchObject({ state: 'cancelled' })
    for (const t of tasks.slice(1)) expect(await b.db.first('SELECT state FROM {async_tasks} WHERE id=?', t.id)).toMatchObject({ state: 'preparing' })
    expect(b.ctx.config.apiKey).toBe(config.apiKey)
    expect(b.fetcher).not.toHaveBeenCalled()
  })
  it('/reset发生在读取期间，旧任务既不回复也不恢复历史', async () => {
    const b = await harness(); await b.invoke()
    let finish!: (value: Response) => void
    b.fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const job = b.poll(); await vi.waitFor(() => expect(b.fetcher).toHaveBeenCalledTimes(2))
    await b.invoke('reset'); finish(Response.json(result())); await job
    expect(b.ctx.api.sendMessage).not.toHaveBeenCalled()
    expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([])
  })
  it('提交结果未知不自动重试，必须/reset后才能继续', async () => {
    const b = await harness(); b.fetcher.mockRejectedValue(new TypeError(config.apiKey))
    expect(await b.invoke()).toContain('提交结果暂时无法确认')
    b.restart(); expect(await b.invoke()).toContain('已有后台任务')
    await b.poll(); expect(b.fetcher).toHaveBeenCalledTimes(1)
    expect(await b.task()).toMatchObject({ state: 'submit_unknown' })
    expect(JSON.stringify((b.ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(config.apiKey)
  })
  it('权限失败在管理员任务页只显示固定分类和状态，不暴露提供商原文', async () => {
    const b = await harness()
    b.fetcher.mockResolvedValue(Response.json({ error: { code: 'unsupported_country_region_territory', message: config.apiKey } }, { status: 403 }))
    expect(await b.invoke()).toContain('权限异常')
    const route = b.plugin.routes!.find(r => r.path === '/api/status')!
    const response = await route.handler({ ctx: b.ctx, request: new Request('https://bot.test'), params: {}, authenticated: true })
    const text = await response.text()
    expect(JSON.parse(text).lastApiError).toMatchObject({ status: 403, reason: 'REGION_UNSUPPORTED' })
    expect(text).not.toContain(config.apiKey)
  })
  it('QQ发送结果未知不盲目换seq重发，/reset可解除阻塞', async () => {
    const b = await harness(); await b.invoke(); b.ctx.api.sendMessage = vi.fn().mockRejectedValue(new Error(config.apiKey))
    await b.poll(); await b.poll()
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(await b.task()).toMatchObject({ state: 'uncertain', seq: 1 })
    expect(await b.invoke('reset')).toContain('已清除')
  })
  it.each(['c2c', 'group'] as const)('%s过被动回复窗口不转为主动消息', async scene => {
    vi.useFakeTimers(); const b = await harness(scene); await b.invoke()
    await vi.advanceTimersByTimeAsync(scene === 'c2c' ? 3600000 : 300000); await b.poll()
    expect(b.ctx.api.sendMessage).not.toHaveBeenCalled(); expect(await b.task()).toMatchObject({ state: 'expired' })
  })
  it('长中文按正确seq分段，剩余正文保留到/more', async () => {
    const b = await harness(); await b.invoke(); const text = '中文😀'.repeat(3000)
    b.fetcher.mockResolvedValue(Response.json(result(text))); await b.poll()
    const calls = (b.ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(4); expect(calls[3]![1]).toBe(MORE_TIP)
    expect(calls.map(c => c[2].msgSeq)).toEqual([1, 2, 3, 4])
    for (const c of calls) expect(new TextEncoder().encode(c[1]).byteLength).toBeLessThanOrEqual(2000)
    const pending = (await loadPending(b.ctx, b.session))!
    expect(calls.slice(0, 3).map(c => c[1]).join('') + pending.text.slice(pending.offset)).toBe(text)
  })
  it('保留共享冷却和忙碌保护', async () => {
    const b = await harness(); let finish!: (value: Response) => void
    b.fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const job = b.invoke(); await vi.waitFor(() => expect(b.fetcher).toHaveBeenCalledTimes(1))
    expect(await b.ordinary()).toContain('正在回答')
    finish(Response.json({ id: 'resp_test', status: 'queued' })); await job
    expect(await b.invoke()).toContain('太频繁')
  })
  it('插件命名空间、触发器和管理路由不影响Gemini', async () => {
    const b = await harness(); const manifest = extractManifest(b.plugin, { version: '0.1.0' })
    expect(manifest.name).toBe('openai'); expect(manifest.permissions).toEqual(['net', 'kv', 'db'])
    expect(manifest.commands.map(c => c.name)).toEqual(['ai', 'search', 'model', 'more', 'reset'])
    expect(manifest.cron).toEqual([{ name: 'background', cron: '* * * * *' }])
    expect(b.plugin.routes?.filter(r => r.path !== '/callback').every(r => r.auth === 'admin')).toBe(true)
    expect(b.plugin.routes?.find(r => r.path === '/callback')?.auth).toBe('public')
    const route = b.plugin.routes!.find(r => r.path === '/api/status')!
    const response = await route.handler({ ctx: b.ctx, request: new Request('https://bot.test'), params: {}, authenticated: true })
    const text = await response.text(); expect(text).not.toContain(config.apiKey)
    expect(text).not.toContain('userId'); expect(text).not.toContain('resp_test')
  })
})

const webhookSecret = 'whsec_' + Buffer.from('local-webhook-signing-key-32bytes').toString('base64')
async function webhookHarness() {
  const b = await harness()
  b.ctx.config = { ...config, backgroundDelivery: 'webhook', webhookSecret }
  const jobs: Promise<unknown>[] = []
  b.ctx.waitUntil = p => { jobs.push(p) }
  const route = webhookRoutes(b.fetcher)[0]!
  const callback = async (id = 'wh_once', responseId = 'resp_test', type = 'response.completed', valid = true) => {
    const body = JSON.stringify({ type, data: { id: responseId } }); const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')
    return route.handler({ ctx: b.ctx, authenticated: false, params: {}, request: new Request('https://bot.test/p/openai/callback', {
      method: 'POST', body, headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,' + (valid ? signature : 'bad') },
    }) })
  }
  return { ...b, callback, jobs, drain: () => Promise.all(jobs), cron: () => b.plugin.cron!.background!.handler({ ctx: b.ctx, job: 'background', scheduledAt: Date.now() }) }
}
describe('签名通知驱动自动回复', () => {
  it('无通知时 Cron 不轮询远端；通知触发 GET、原msg_id投递和六轮上下文', async () => {
    const b = await webhookHarness(); await b.invoke(); await b.cron()
    expect(b.fetcher).toHaveBeenCalledTimes(1)
    expect((await b.callback()).status).toBe(204); await b.drain()
    expect(await b.task()).toMatchObject({ state: 'delivered', seq: 1 })
    expect(b.ctx.api.sendMessage).toHaveBeenCalledExactlyOnceWith({ scene: 'c2c', id: 'user' }, '后台回答', { messageId: 'm1', msgSeq: 1 })
    expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([message('user', '你好'), message('model', '后台回答')])
  })
  it('并发重复通知与 Cron 共享认领，不重复回复；未知 Response 不调用 API', async () => {
    const b = await webhookHarness(); await b.invoke()
    await Promise.all([b.callback(), b.callback(), b.callback('wh_second'), b.cron()]); await b.drain()
    await b.callback(); await b.drain(); await b.cron()
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
    expect((await b.callback('wh_other', 'resp_unrelated')).status).toBe(204)
    expect(b.fetcher).toHaveBeenCalledTimes(2)
  })
  it('通知提前到达提交落库前返回503，供 OpenAI 重试', async () => {
    const b = await webhookHarness(); const task = await reserveBackground(b.ctx, b.session, b.ctx.config)
    await b.db.run("UPDATE {async_tasks} SET state='submitting' WHERE id=?", task.id)
    expect((await b.callback()).status).toBe(503)
    expect(b.fetcher).not.toHaveBeenCalled()
  })
  it('完成通知绕过旧轮询next_poll；无效签名及关闭开关不调用API', async () => {
    const b = await webhookHarness(); await b.invoke()
    await b.db.run('UPDATE {async_tasks} SET next_poll=?', Date.now() + 45000)
    expect((await b.callback('wh_bad', 'resp_test', 'response.completed', false)).status).toBe(400)
    expect(b.fetcher).toHaveBeenCalledTimes(1)
    expect((await b.callback()).status).toBe(204); await b.drain()
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
    b.ctx.config.backgroundDelivery = 'cron'
    expect((await b.callback()).status).toBe(503)
  })
  it('reset后旧通知不回复、不恢复历史', async () => {
    const b = await webhookHarness(); await b.invoke(); await b.invoke('reset')
    expect((await b.callback()).status).toBe(204); await b.drain()
    expect(b.ctx.api.sendMessage).not.toHaveBeenCalled()
    expect(b.fetcher).toHaveBeenCalledTimes(1)
    expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([])
  })
  it('回调GET失败后通过持久化收件箱Cron恢复，无需再次通知', async () => {
    vi.useFakeTimers(); const b = await webhookHarness(); await b.invoke()
    b.fetcher.mockRejectedValueOnce(new TypeError('local network error'))
    await b.callback(); await b.drain(); expect(b.ctx.api.sendMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(61000); await b.cron()
    expect(await b.task()).toMatchObject({ state: 'delivered' })
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
  })
  it('failed通知获取真实错误，仅发固定提示，不保存失败问答或密钥', async () => {
    const b = await webhookHarness(); await b.invoke()
    b.fetcher.mockResolvedValueOnce(Response.json({ id: 'resp_test', status: 'failed', error: { code: 'insufficient_quota', message: config.apiKey + webhookSecret } }))
    await b.callback('wh_failed', 'resp_test', 'response.failed'); await b.drain()
    const text = String((b.ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1])
    expect(text).toContain('额度不足'); expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([])
    const output = JSON.stringify([text, (b.ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls])
    expect(output).not.toContain(config.apiKey); expect(output).not.toContain(webhookSecret)
  })
})
