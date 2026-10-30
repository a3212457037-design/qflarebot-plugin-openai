import type { PluginContext, Session } from '@qqbot/sdk'
import type { Config } from './config.js'
import { conversationKey, HISTORY_TTL_SECONDS, loadHistory, parseHistory, saveHistory, type ChatMessage } from './history.js'
import { hideKey } from './grounding.js'
import { MORE_TIP, pendingKeys, QQ_PART_BYTES, splitText } from './delivery.js'
import { OpenAIError, tips } from './responses.js'
import { createInteraction, getInteraction, interactionAnswer, interactionFailure } from './responses.js'
import type { ModelId } from './models.js'

type Ctx = PluginContext<Config>
export const ACTIVE = "('preparing','submitting','pending','polling','ready','sending','uncertain','submit_unknown')"
export interface Task {
  id: string; conversation: string; generation: string; bot: string; user: string; scene: 'c2c' | 'group'; target: string; message: string;
  created: number; message_at: number; model: ModelId; state: string; interaction: string | null; token: string; lease: number;
  next_poll: number; seq: number; offset: number; error: string | null; updated: number
}
interface Payload { question: string; history: ChatMessage[]; forceSearch?: boolean }
export class BackgroundError extends Error {
  constructor(readonly code: string, text = '后台任务暂时不可用，请稍后再试。') { super(text); this.name = 'BackgroundError' }
}

export async function ensureBackground(ctx: Ctx): Promise<void> {
  // 更新原插件时 onInstall 不一定重跑，所有入口都幂等建表；只使用 SDK 专属命名空间。
  await ctx.db.exec(`CREATE TABLE IF NOT EXISTS {async_sessions} (conversation TEXT PRIMARY KEY, generation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS {async_tasks} (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, generation TEXT NOT NULL,
      bot TEXT NOT NULL, user TEXT NOT NULL, scene TEXT NOT NULL, target TEXT NOT NULL, message TEXT NOT NULL,
      created INTEGER NOT NULL, message_at INTEGER NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL, interaction TEXT,
      token TEXT NOT NULL DEFAULT '', lease INTEGER NOT NULL DEFAULT 0, next_poll INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0, error TEXT, model_ms INTEGER, updated INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS {async_one_active} ON {async_tasks}(conversation) WHERE state IN ${ACTIVE};
    CREATE UNIQUE INDEX IF NOT EXISTS {async_message_once} ON {async_tasks}(bot, scene, message);
    CREATE INDEX IF NOT EXISTS {async_poll} ON {async_tasks}(bot, state, next_poll);
    CREATE TABLE IF NOT EXISTS {async_meta} (name TEXT PRIMARY KEY, value TEXT NOT NULL);`)
}

export async function metaGet<T>(ctx: Ctx, name: string): Promise<T | null> {
  const row = await ctx.db.first<{ value: string }>('SELECT value FROM {async_meta} WHERE name=?', name)
  if (!row) return null
  try { return JSON.parse(row.value) as T } catch { return null }
}
export async function metaPut(ctx: Ctx, name: string, value: unknown) {
  await ctx.db.run('INSERT INTO {async_meta}(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value', name, JSON.stringify(value))
}
export async function hasBackground(ctx: Ctx, session: Session): Promise<boolean> {
  // 同步模式无 D1 的旧安装仍可运行；异步模式的 D1 错误必须 fail closed。
  try {
    await ensureBackground(ctx)
    return !!await ctx.db.first(`SELECT id FROM {async_tasks} WHERE conversation=? AND state IN ${ACTIVE}`, conversationKey(session))
  } catch {
    if (ctx.config.executionMode === 'background' || await ctx.kv.get('async:installed').catch(() => 'unknown')) throw new BackgroundError('db')
    return false
  }
}

export async function reserveBackground(ctx: Ctx, session: Session, config: Config): Promise<Task> {
  const key = conversationKey(session)
  if (!key || !session.messageId || !session.targetId || ctx.botId !== session.botId) throw new BackgroundError('identity', '当前消息缺少后台回复凭据，请重新发送普通文字。')
  await ensureBackground(ctx)
  const now = Date.now(); const id = crypto.randomUUID()
  await ctx.kv.put('async:installed', '1')
  await ctx.db.run('INSERT OR IGNORE INTO {async_sessions}(conversation,generation) VALUES (?,?)', key, crypto.randomUUID())
  const stamp = Number.isFinite(session.timestamp) && session.timestamp > 0 ? Math.min(session.timestamp, now) : now
  const inserted = await ctx.db.run(`INSERT OR IGNORE INTO {async_tasks}
    (id,conversation,generation,bot,user,scene,target,message,created,message_at,model,state,updated)
    SELECT ?,conversation,generation,?,?,?,?,?,?,?,?,'preparing',? FROM {async_sessions} WHERE conversation=?`,
    id, session.botId, session.userId, session.scene, session.targetId, session.messageId, now, stamp, config.model, now, key)
  if (!inserted.changes) throw new BackgroundError('busy', '本会话已有后台任务，请等待自动回复；可用 /reset 取消。')
  return (await ctx.db.first<Task>('SELECT * FROM {async_tasks} WHERE id=?', id))!
}

export async function abandonBackground(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.run("UPDATE {async_tasks} SET state='failed',updated=? WHERE id=? AND state='preparing'", Date.now(), id)
}

export async function submitBackground(ctx: Ctx, task: Task, config: Config, fetcher: typeof fetch, question: string, history: ChatMessage[], forceSearch = false): Promise<void> {
  const clean = (text: string) => hideKey(text, config.apiKey, config.webhookSecret ?? '')
  const payload: Payload = { question: clean(question), history: history.map(m => ({ role: m.role, parts: [{ text: clean(m.parts[0].text) }] })), forceSearch }
  await ctx.kv.put(`async:payload:${task.id}`, payload, { ttl: HISTORY_TTL_SECONDS })
  const claimed = await ctx.db.run("UPDATE {async_tasks} SET state='submitting',updated=? WHERE id=? AND state='preparing'", Date.now(), task.id)
  if (!claimed.changes) return // reset 已取消，不能再提交。
  try {
    const result = await createInteraction(payload.question, config, fetcher, payload.history, forceSearch)
    await ctx.db.run("UPDATE {async_tasks} SET state='pending',interaction=?,next_poll=?,updated=? WHERE id=? AND state='submitting'", result.id, Date.now(), Date.now(), task.id)
  } catch (error) {
    // POST 超时/连接失败/响应丢失无法确定服务器是否已创建；绝不自动重投。
    const ambiguous = !(error instanceof OpenAIError) || ['timeout', 'network', 'response', 'unavailable'].includes(error.code)
    await ctx.db.run("UPDATE {async_tasks} SET state=?,error=?,updated=? WHERE id=? AND state='submitting'",
      ambiguous ? 'submit_unknown' : 'failed', error instanceof OpenAIError ? error.code : 'unavailable', Date.now(), task.id)
    throw error
  }
}

export async function cancelBackground(ctx: Ctx, session: Session): Promise<void> {
  try {
    await ensureBackground(ctx)
    const key = conversationKey(session)
    await ctx.db.batch([
      { sql: 'UPDATE {async_sessions} SET generation=? WHERE conversation=?', params: [crypto.randomUUID(), key] },
      { sql: `UPDATE {async_tasks} SET state='cancelled',updated=? WHERE conversation=? AND state IN ${ACTIVE}`, params: [Date.now(), key] },
    ])
  } catch { if (ctx.config.executionMode === 'background' || await ctx.kv.get('async:installed').catch(() => 'unknown')) throw new BackgroundError('reset', '后台任务取消失败，暂未重置，请稍后重试。') }
}

async function current(ctx: Ctx, task: Task, state?: string): Promise<boolean> {
  return !!await ctx.db.first(`SELECT id FROM {async_tasks} WHERE id=? AND token=? ${state ? 'AND state=?' : ''}
    AND generation=(SELECT generation FROM {async_sessions} WHERE conversation=?) AND state!='cancelled'`,
    task.id, task.token, ...(state ? [state] : []), task.conversation)
}

export function replyDeadline(task: Pick<Task, 'scene' | 'message_at'>): number {
  // 截止前再留 15 秒给 QQ 请求，不转为有额度的主动消息。
  return task.message_at + (task.scene === 'c2c' ? 3600000 : 300000) - 15000
}

async function readPayload(ctx: Ctx, task: Task): Promise<Payload> {
  const raw = await ctx.kv.get(`async:payload:${task.id}`)
  if (!raw) throw new BackgroundError('payload')
  const value = JSON.parse(raw) as Payload
  if (typeof value.question !== 'string' || !value.question.trim() || Array.from(value.question).length > 1000) throw new BackgroundError('payload')
  const history = parseHistory(JSON.stringify({ updatedAt: task.created, messages: value.history }))
  if (value.forceSearch !== undefined && typeof value.forceSearch !== 'boolean') throw new BackgroundError('payload')
  return { question: value.question, history, forceSearch: value.forceSearch === true }
}

async function saveCursor(ctx: Ctx, task: Task, text: string) {
  const keys = pendingKeys({ botId: task.bot, userId: task.user, scene: task.scene, targetId: task.target } as Session)!
  await ctx.kv.put(keys[1], { id: task.id, offset: task.offset }, { ttl: HISTORY_TTL_SECONDS })
  // 普通短回复全部完成不需要 /more。长回复正文在投递前已保存。
  if (text.length === task.offset) return
}

async function deliverTask(ctx: Ctx, task: Task, config: Config, maxSends: number): Promise<void> {
  const raw = await ctx.kv.get(`async:answer:${task.id}`)
  if (!raw) throw new BackgroundError('answer')
  const text = hideKey(raw, config.apiKey, config.webhookSecret ?? '')
  const slots = task.scene === 'c2c' ? 4 : 5
  let bytes = QQ_PART_BYTES
  const keys = pendingKeys({ botId: task.bot, userId: task.user, scene: task.scene, targetId: task.target } as Session)!
  if (new TextEncoder().encode(text).byteLength > QQ_PART_BYTES) {
    if (!await current(ctx, task, 'ready')) return
    await ctx.kv.put(keys[0], { id: task.id, text, updatedAt: Date.now(), offset: 0 }, { ttl: HISTORY_TTL_SECONDS })
    if (!await current(ctx, task, 'ready')) { await ctx.kv.delete(keys[0]); return }
  }
  let sends = 0
  while (task.offset < text.length && task.seq < slots && sends < maxSends && Date.now() < replyDeadline(task)) {
    const notice = task.seq === slots - 1 && splitText(text.slice(task.offset), bytes, 2).length > 1
    const chunk = notice ? MORE_TIP : splitText(text.slice(task.offset), bytes, 1)[0]!
    // 发送之前原子占用，并记录序号。sending 不会被 Cron 重新认领。
    const claim = await ctx.db.run(`UPDATE {async_tasks} SET state='sending',seq=seq+1,updated=?
      WHERE id=? AND token=? AND state='ready' AND generation=(SELECT generation FROM {async_sessions} WHERE conversation=?)`, Date.now(), task.id, task.token, task.conversation)
    if (!claim.changes) return
    task.seq++
    sends++
    let ok = false; let tooLong = false
    try {
      const result = await ctx.api.sendMessage({ scene: task.scene, id: task.target }, chunk, { messageId: task.message, msgSeq: task.seq })
      ok = result.ok
      tooLong = result.code === 40054007
      if (!ok) ctx.logger.warn('后台 QQ 投递未完成', { code: tooLong ? 'reply_length' : 'delivery_uncertain', status: result.status })
    } catch { ctx.logger.warn('后台 QQ 投递未完成', { code: 'delivery_uncertain' }) }
    if (!ok && !tooLong) {
      await ctx.db.run("UPDATE {async_tasks} SET state='uncertain',updated=? WHERE id=? AND token=? AND state='sending'", Date.now(), task.id, task.token)
      await saveCursor(ctx, task, text)
      return // 网络超时或未知结果绝不以新 seq 重发。
    }
    if (ok && !notice) task.offset += chunk.length
    const state = ok && (notice || task.offset === text.length) ? 'delivered' : 'ready'
    const saved = await ctx.db.run("UPDATE {async_tasks} SET state=?,offset=?,updated=? WHERE id=? AND token=? AND state='sending'", state, task.offset, Date.now(), task.id, task.token)
    if (!saved.changes) return // reset 发生在在途发送时，不能继续发或写新上下文。
    if (tooLong) bytes = Math.max(128, Math.floor(bytes / 2))
    if (state === 'delivered') break
  }
  if (!await current(ctx, task)) return
  await saveCursor(ctx, task, text)
  if (task.seq >= slots || Date.now() >= replyDeadline(task)) await ctx.db.run("UPDATE {async_tasks} SET state=?,updated=? WHERE id=? AND token=? AND state='ready'", task.offset === text.length ? 'delivered' : 'expired', Date.now(), task.id, task.token)
  else await ctx.db.run("UPDATE {async_tasks} SET lease=0 WHERE id=? AND token=? AND state='ready'", task.id, task.token)
}

export async function processBackground(ctx: Ctx, config: Config, fetcher: typeof fetch, interaction?: string, maxSends = Infinity): Promise<void> {
  await ensureBackground(ctx)
  const now = Date.now()
  await metaPut(ctx, 'last_cron_or_callback', now)
  // 崩溃后的提交或发送结果未知，不重复创建/投递。轮询 GET 的过期租约则可以恢复。
  await ctx.db.run("UPDATE {async_tasks} SET state='uncertain',updated=? WHERE bot=? AND state='sending' AND updated<?", now, ctx.botId, now - 90000)
  await ctx.db.run("UPDATE {async_tasks} SET state='submit_unknown',updated=? WHERE bot=? AND state IN ('preparing','submitting') AND updated<?", now, ctx.botId, now - 90000)
  const rows = await ctx.db.all<Task>(`SELECT * FROM {async_tasks} WHERE bot=? AND
    (state IN ('pending','ready') OR (state='polling' AND lease<?)) AND ${interaction ? 'interaction=?' : 'next_poll<=?'} ORDER BY created LIMIT 2`, ctx.botId, now, interaction ?? now)
  for (const task of rows) {
    const token = crypto.randomUUID()
    const claim = await ctx.db.run(`UPDATE {async_tasks} SET token=?,lease=?,state=CASE WHEN state='ready' THEN 'ready' ELSE 'polling' END
      WHERE id=? AND bot=? AND ((state IN ('pending','ready') AND lease<?) OR (state='polling' AND lease<?))`, token, Date.now() + 90000, task.id, ctx.botId, Date.now(), Date.now())
    if (!claim.changes) continue
    task.token = token
    try {
      if (!await current(ctx, task)) continue
      if (Date.now() >= replyDeadline(task)) {
        await ctx.db.run("UPDATE {async_tasks} SET state='expired',updated=? WHERE id=? AND token=?", Date.now(), task.id, token)
        continue
      }
      if (task.state !== 'ready') {
        const payload = await readPayload(ctx, task)
        const result = await getInteraction(task.interaction!, config, fetcher)
        if (result.status === 'in_progress' || result.status === 'queued') {
          await ctx.db.run("UPDATE {async_tasks} SET state='pending',lease=0,next_poll=?,updated=? WHERE id=? AND token=? AND state='polling'", Date.now() + 45000, Date.now(), task.id, token)
          continue
        }
        let success = ['completed', 'incomplete'].includes(String(result.status))
        let text: string
        try {
          if (!success) throw new OpenAIError(interactionFailure(result))
          text = interactionAnswer(result, config, payload.forceSearch)
        } catch (error) {
          if (!(error instanceof OpenAIError)) throw error
          success = false
          text = error.message
          ctx.logger.warn('OpenAI 后台任务失败', { code: error.code })
        }
        if (!await current(ctx, task, 'polling')) continue
        await ctx.kv.put(`async:answer:${task.id}`, text, { ttl: HISTORY_TTL_SECONDS })
        if (success) {
          await saveHistory(ctx.kv, task.conversation, payload.history, payload.question, text)
          if (!await current(ctx, task, 'polling')) { await ctx.kv.delete(task.conversation); continue }
        }
        const elapsed = typeof result.completed_at === 'number' && typeof result.created_at === 'number' ? (result.completed_at - result.created_at) * 1000 : NaN
        const ready = await ctx.db.run("UPDATE {async_tasks} SET state='ready',model_ms=?,updated=? WHERE id=? AND token=? AND state='polling'", Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 86400000 ? elapsed : null, Date.now(), task.id, token)
        if (!ready.changes) continue
      }
      await deliverTask(ctx, task, config, maxSends)
    } catch (error) {
      const code = error instanceof OpenAIError ? error.code : 'background_state'
      if (error instanceof OpenAIError && error.api) await metaPut(ctx, 'last_api_failure', { ...error.api, at: Date.now() }).catch(() => {})
      ctx.logger.warn('OpenAI 后台任务未完成', { code, ...(error instanceof OpenAIError && error.diagnostic ? { error: error.diagnostic } : {}), ...(error instanceof OpenAIError && error.api ? { api: error.api } : {}) })
      // 只重试 GET / KV 工作，不重试已进入 sending 的投递。
      await ctx.db.run("UPDATE {async_tasks} SET state=CASE WHEN state='polling' THEN 'pending' ELSE state END,lease=0,next_poll=?,error=?,updated=? WHERE id=? AND token=? AND state IN ('polling','ready')", Date.now() + 60000, code, Date.now(), task.id, token)
    }
  }
  await ctx.db.run(`DELETE FROM {async_tasks} WHERE id IN (SELECT id FROM {async_tasks} WHERE bot=? AND updated<? AND state NOT IN ${ACTIVE} LIMIT 30)`, ctx.botId, now - 86400000)
}
