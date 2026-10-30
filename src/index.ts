import { definePlugin, isMessageEvent } from '@qqbot/sdk'
import type { CommandInput } from '@qqbot/sdk'
import { configSchema, defaultConfig, readConfig, type Config } from './config.js'
import { askOpenAI, OpenAIError, tips } from './responses.js'
import { conversationKey, loadHistory, saveHistory, type ChatMessage } from './history.js'
import { hideKey } from './grounding.js'
import { deliverAnswer, deliverPending, loadPending, pendingKeys, GENERATION_BUDGET_MS, TURN_BUDGET_MS } from './delivery.js'
import { resolveModel, parseModelChoice, saveModel, modelMenu, ModelStateError } from './models.js'
import { abandonBackground, BackgroundError, cancelBackground, hasBackground, processBackground, reserveBackground, submitBackground, type Task } from './background.js'
import { backgroundRoutes } from './background-panel.js'

export function createOpenAIPlugin(fetcher: typeof fetch = (...args) => fetch(...args)) {
  // 只保存冷却时间，不保存问答。Worker isolate 重建或扩容后会重置，非全局强限流。
  const users = new Map<string, number>()
  let busy = false
  let nextRequestAt = 0
  let activeHistoryKey: string | null = null
  let resetDuringRequest = false

  async function chat({ session, ctx, argText }: Pick<CommandInput<Config>, 'session' | 'ctx' | 'argText'>, forceSearch = false) {
    if (session.scene !== 'c2c' && session.scene !== 'group') return
    if (session.scene === 'group' && !session.atMe) return
    if (!session.canReply) return
    if (!isMessageEvent(session.event) || session.attachments.length) return
    let question = argText.trim()
    if (!question) return forceSearch ? '用法：/search 搜索关键词（群聊请先 @机器人）。' : '用法：/ai 你的问题（群聊请先 @机器人）。'
    const config = readConfig(ctx.config)
    if (!config) return 'AI 配置异常，请联系机器人管理员。'
    if (!config.apiKey || config.apiKey.startsWith('__qflare_secret__:')) return 'AI 尚未配置，请联系机器人管理员。'
    if (Array.from(question).length > config.maxInputChars) return `问题太长，请限制在 ${config.maxInputChars} 字符以内。`
    question = hideKey(question, config.apiKey)
    if (forceSearch && !config.enableWebSearch) return '联网搜索未开启，请联系机器人管理员。'

    const now = Date.now()
    const user = JSON.stringify([session.botId, session.userId])
    if (busy) return 'AI 正在回答，请稍后再问。'
    if (now < nextRequestAt || now < (users.get(user) ?? 0)) return '提问太频繁，请稍后再试。'
    for (const [id, until] of users) if (until <= now) users.delete(id)
    if (users.size >= 1024) return 'AI 服务暂时繁忙，请稍后再试。'
    users.set(user, now + 10000)
    nextRequestAt = now + 6000
    busy = true
    const key = conversationKey(session)
    activeHistoryKey = key
    resetDuringRequest = false
    let task: Task | undefined
    try {
      if (await hasBackground(ctx, session)) return '本会话已有后台任务，请等待自动回复；可用 /reset 取消。'
      const pending = await loadPending(ctx, session).catch(() => null)
      if (pending) return '上一条长回答尚未发完，请用 /more 继续领取；或用 /reset 清除后再提新问题。'
      config.model = (await resolveModel(ctx, session, config.model)).model
      if (config.executionMode === 'background') task = await reserveBackground(ctx, session, config)
      let history: ChatMessage[] = []
      if (key) {
        try { history = await loadHistory(ctx.kv, key) }
        catch { ctx.logger.warn('OpenAI 历史读取失败', { code: 'history_read' }) }
      }
      if (resetDuringRequest) history = []
      if (task) {
        await submitBackground(ctx, task, config, fetcher, question, history, forceSearch)
        return // 普通消息无需命令取结果；不发送占用 msg_seq 的“已收到”消息。
      }
      const remaining = now + GENERATION_BUDGET_MS - Date.now()
      if (remaining <= 0) throw new OpenAIError('timeout')
      const reply = await askOpenAI(question, { ...config, timeoutMs: Math.min(config.timeoutMs, remaining) }, fetcher, history, forceSearch)
      if (key && !resetDuringRequest) {
        try {
          await saveHistory(ctx.kv, key, history, question, reply)
          // /reset 若发生在 KV 写入期间，写入完成后再次删除，避免恢复已重置的历史。
          if (resetDuringRequest) await ctx.kv.delete(key)
        } catch { ctx.logger.warn('OpenAI 历史保存失败', { code: 'history_write' }) }
      }
      return await deliverAnswer(session, ctx, reply, now + TURN_BUDGET_MS, () => resetDuringRequest)
    } catch (error) {
      if (error instanceof BackgroundError) {
        ctx.logger.warn('OpenAI 后台任务未完成', { code: error.code })
        return error.message
      }
      if (error instanceof ModelStateError) {
        ctx.logger.warn('OpenAI 会话模型读取失败', { code: error.code })
        return error.message
      }
      const code = error instanceof OpenAIError ? error.code : 'unavailable'
      ctx.logger.warn('OpenAI 请求未完成', {
        code,
        ...(error instanceof OpenAIError && error.diagnostic ? { error: error.diagnostic } : {}),
        ...(error instanceof OpenAIError && error.api ? { api: error.api } : {}),
      })
      if (task && ['timeout', 'network', 'response', 'unavailable'].includes(code)) return '后台提交结果暂时无法确认，为避免重复请求已停止重试；请稍后发送 /reset 后再提问。'
      return tips[code]
    } finally {
      if (task) await abandonBackground(ctx, task.id).catch(() => {})
      activeHistoryKey = null
      busy = false
    }
  }

  return definePlugin<Config>({
    name: 'openai',
    apiVersion: 4,
    displayName: 'OpenAI 文本问答',
    description: '通过 OpenAI Responses API 聊天，支持原生搜索、上下文与后台自动回复',
    permissions: ['net', 'kv', 'db'],
    configSchema,
    defaultConfig,
    ui: { path: '/ui/', title: 'OpenAI 后台任务', icon: 'Clock' },
    routes: backgroundRoutes(fetcher),
    cron: { background: { cron: '* * * * *', async handler({ ctx }) {
      const config = readConfig(ctx.config)
      if (!config?.apiKey) return
      try { await processBackground(ctx, config, fetcher) }
      catch { ctx.logger.warn('OpenAI 后台轮询不可用', { code: 'background_poll' }) }
    } } },
    commands: {
      ai: {
        description: '向 OpenAI 提问',
        usage: '/ai <问题>',
        scenes: ['c2c', 'group'],
        handler: chat,
      },
      search: {
        description: '联网搜索并由 AI 整理回答',
        usage: '/search <关键词>',
        scenes: ['c2c', 'group'],
        handler: (input) => chat(input, true),
      },
      model: {
        description: '查看或切换当前会话模型',
        usage: '/model [序号|模型ID|default]',
        scenes: ['c2c', 'group'],
        async handler({ session, ctx, argText }) {
          if ((session.scene !== 'c2c' && session.scene !== 'group') || !session.canReply
            || (session.scene === 'group' && !session.atMe) || !isMessageEvent(session.event) || session.attachments.length) return
          const config = readConfig(ctx.config)
          if (!config) return 'AI 配置异常，请联系机器人管理员。'
          const choice = argText.trim().toLowerCase()
          try {
            if (!choice || choice === 'list') return modelMenu(await resolveModel(ctx, session, config.model), config.model)
            const selected = choice === 'default' ? null : parseModelChoice(choice)
            if (choice !== 'default' && selected === null) return '模型不在可选列表中，请发送 /model 查看；可用序号或完整模型ID切换。'
            if (busy) return 'AI 正在回答，请稍后再切换模型。'
            busy = true
            try {
              if (!await saveModel(ctx, session, selected)) return '无法识别当前会话，模型未切换。'
            } finally { busy = false }
            return selected === null ? `本会话已恢复跟随后台默认：${config.model}。上下文保留。`
              : `本会话已切换为 ${selected}，从下一条问题生效。上下文保留；可用性和额度以 OpenAI 项目为准。`
          } catch (error) {
            ctx.logger.warn('OpenAI 会话模型设置未完成', { code: error instanceof ModelStateError ? error.code : 'model_state' })
            return error instanceof ModelStateError ? error.message : '模型选择暂时不可用，请稍后再试。'
          }
        },
      },
      more: {
        description: '领取长回答剩余正文',
        usage: '/more',
        scenes: ['c2c', 'group'],
        async handler({ session, ctx }) {
          if ((session.scene !== 'c2c' && session.scene !== 'group') || !session.canReply
            || (session.scene === 'group' && !session.atMe) || !isMessageEvent(session.event) || session.attachments.length) return
          if (busy) return 'AI 正在回答，请稍后再问。'
          const now = Date.now()
          const user = JSON.stringify([session.botId, session.userId])
          if (now < nextRequestAt || now < (users.get(user) ?? 0)) return '提问太频繁，请稍后再试。'
          for (const [id, until] of users) if (until <= now) users.delete(id)
          if (users.size >= 1024) return 'AI 服务暂时繁忙，请稍后再试。'
          users.set(user, now + 10000)
          nextRequestAt = now + 6000
          busy = true
          activeHistoryKey = conversationKey(session)
          resetDuringRequest = false
          try {
            const pending = await loadPending(ctx, session)
            if (!pending) return '当前没有待发送的正文，或已超过 24 小时。'
            const config = readConfig(ctx.config)
            if (!config) return 'AI 配置异常，请联系机器人管理员。'
            // 已保存文本再次做双密钥脱敏；不读取或打印真实密钥。
            const prefix = hideKey(pending.text.slice(0, pending.offset), config.apiKey)
            pending.text = hideKey(pending.text, config.apiKey)
            pending.offset = prefix.length
            return await deliverPending(session, ctx, pending, now + TURN_BUDGET_MS, () => resetDuringRequest)
          } catch {
            ctx.logger.warn('QQ 待发送正文读取失败', { code: 'pending_read' })
            return '暂时无法读取剩余正文，请稍后再试。'
          } finally { activeHistoryKey = null; busy = false }
        },
      },
      reset: {
        description: '清除当前对话历史',
        usage: '/reset',
        scenes: ['c2c', 'group'],
        async handler({ session, ctx }) {
          if (session.scene !== 'c2c' && session.scene !== 'group') return
          if (session.scene === 'group' && !session.atMe) return
          if (!session.canReply) return
          const key = conversationKey(session)
          if (!key) return '无法识别当前会话，请稍后再试。'
          if (activeHistoryKey === key) resetDuringRequest = true
          try {
            await cancelBackground(ctx, session)
            await ctx.kv.delete(key)
            const keys = pendingKeys(session)
            if (keys) await Promise.all(keys.map((item) => ctx.kv.delete(item)))
            return '当前会话的对话历史已清除。'
          } catch {
            ctx.logger.warn('OpenAI 历史重置失败', { code: 'history_reset' })
            return '暂时无法清除对话历史，请稍后再试。'
          }
        },
      },
    },
    regex: [{
      pattern: '\\S',
      scenes: ['c2c', 'group'],
      priority: -100,
      block: false,
      handler({ session, ctx }) {
        if (session.scene !== 'c2c' && session.scene !== 'group') return
        if (session.scene === 'group' && !session.atMe) return
        if (!isMessageEvent(session.event) || session.attachments.length) return
        const text = session.content.trim()
        if (!text || text.startsWith('/')) return
        const prefixes = ctx.config?.ignoredCommandPrefixes ?? defaultConfig.ignoredCommandPrefixes
        if (Array.isArray(prefixes) && prefixes.some((prefix) => typeof prefix === 'string' && prefix.length && text.startsWith(prefix))) return
        return chat({ session, ctx, argText: text })
      },
    }],
  })
}

export default createOpenAIPlugin()
