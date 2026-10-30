import type { PluginContext, Route } from '@qqbot/sdk'
import { readConfig, type Config } from './config.js'
import { ensureBackground, metaPut, processBackground, type Task } from './background.js'

const EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'])
const MAX_BODY = 65536
type Ctx = PluginContext<Config>
type Notice = { id: string; interaction: string }
class InvalidWebhook extends Error {}
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))

// Standard Webhooks v1: 对原始字节验签，不先解析或重新序列化 JSON。
export async function verifyWebhook(request: Request, secret: string, now = Date.now()) {
  const id = request.headers.get('webhook-id') ?? ''
  const timestamp = request.headers.get('webhook-timestamp') ?? ''
  const signatures = request.headers.get('webhook-signature') ?? ''
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id) || !/^\d{1,12}$/u.test(timestamp)
    || Math.abs(now / 1000 - Number(timestamp)) > 300 || signatures.length > 1024) throw new InvalidWebhook()
  const reader = request.body?.getReader()
  if (!reader) throw new InvalidWebhook()
  const parts: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > MAX_BODY) { await reader.cancel(); throw new InvalidWebhook() }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(size); let offset = 0
  for (const part of parts) { body.set(part, offset); offset += part.byteLength }
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`)
  const signed = new Uint8Array(prefix.length + body.length); signed.set(prefix); signed.set(body, prefix.length)
  try {
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/u.test(secret)) throw new InvalidWebhook()
    const bytes = decode(secret.slice(6))
    if (bytes.length < 24 || bytes.length > 64) throw new InvalidWebhook()
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    let valid = false
    for (const signature of signatures.split(' ').slice(0, 8)) {
      const [version, encoded] = signature.split(',')
      if (version !== 'v1' || !encoded) continue
      try { if (await crypto.subtle.verify('HMAC', key, decode(encoded), signed)) valid = true } catch { /* 非法签名 */ }
    }
    if (!valid) throw new InvalidWebhook()
    const event = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body))
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new InvalidWebhook()
    if (!EVENTS.has(event.type)) return null
    if (!/^resp_[A-Za-z0-9_-]{1,1024}$/u.test(event.data?.id ?? '')) throw new InvalidWebhook()
    return { id, interaction: event.data.id as string }
  } catch { throw new InvalidWebhook() }
}

async function ensureInbox(ctx: Ctx) {
  await ensureBackground(ctx)
  await ctx.db.exec(`CREATE TABLE IF NOT EXISTS {async_webhooks}
    (id TEXT PRIMARY KEY, bot TEXT NOT NULL, interaction TEXT NOT NULL, state TEXT NOT NULL,
     lease INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS {async_webhooks_due} ON {async_webhooks}(bot,state,lease);`)
}

// 通知先持久化再确认接收。Cron 只恢复这个收件箱，不查询未收到通知的远端任务。
export async function drainWebhooks(ctx: Ctx, config: Config, fetcher: typeof fetch) {
  await ensureInbox(ctx)
  const notices = await ctx.db.all<Notice>("SELECT id,interaction FROM {async_webhooks} WHERE bot=? AND state='pending' AND lease<? ORDER BY created LIMIT 2", ctx.botId, Date.now())
  for (const notice of notices) {
    const claim = await ctx.db.run("UPDATE {async_webhooks} SET lease=? WHERE id=? AND state='pending' AND lease<?", Date.now() + 90000, notice.id, Date.now())
    if (!claim.changes) continue
    try {
      await processBackground(ctx, config, fetcher, notice.interaction)
      const task = await ctx.db.first<Pick<Task, 'state'>>('SELECT state FROM {async_tasks} WHERE bot=? AND interaction=?', ctx.botId, notice.interaction)
      const done = !task || ['delivered', 'failed', 'cancelled', 'expired', 'uncertain', 'submit_unknown'].includes(task.state)
      await ctx.db.run('UPDATE {async_webhooks} SET state=?,lease=? WHERE id=?', done ? 'done' : 'pending', Date.now() + 60000, notice.id)
    } catch {
      ctx.logger.warn('OpenAI 回调任务暂未完成', { code: 'webhook_process' })
      await ctx.db.run('UPDATE {async_webhooks} SET lease=? WHERE id=?', Date.now() + 60000, notice.id)
    }
  }
  await ctx.db.run("DELETE FROM {async_webhooks} WHERE id IN (SELECT id FROM {async_webhooks} WHERE state='done' AND created<? LIMIT 30)", Date.now() - 4 * 86400000)
}

export function webhookRoutes(fetcher: typeof fetch): Route<Config>[] {
  return [{ method: 'POST', path: '/callback', auth: 'public', async handler({ request, ctx }) {
    const config = readConfig(ctx.config)
    if (!config?.apiKey || config.backgroundDelivery !== 'webhook' || !config.webhookSecret) return new Response(null, { status: 503 })
    let notice: Notice | null
    try { notice = await verifyWebhook(request, config.webhookSecret) }
    catch { return new Response(null, { status: 400 }) }
    if (!notice) return new Response(null, { status: 204 })
    try {
      await ensureInbox(ctx)
      const task = await ctx.db.first('SELECT id FROM {async_tasks} WHERE bot=? AND interaction=?', ctx.botId, notice.interaction)
      if (!task) {
        // 完成通知可能早于 POST 返回 ID 的本地落库；让 OpenAI 重试，而非丢失通知。
        const submitting = await ctx.db.first("SELECT id FROM {async_tasks} WHERE bot=? AND state='submitting'", ctx.botId)
        return new Response(null, { status: submitting ? 503 : 204 })
      }
      await ctx.db.run("INSERT OR IGNORE INTO {async_webhooks}(id,bot,interaction,state,created) VALUES (?,?,?,'pending',?)", notice.id, ctx.botId, notice.interaction, Date.now())
      await metaPut(ctx, 'last_verified_webhook', Date.now())
      ctx.waitUntil(drainWebhooks(ctx, config, fetcher).catch(() => {
        ctx.logger.warn('OpenAI 回调恢复待处理', { code: 'webhook_process' })
      }))
      return new Response(null, { status: 204 })
    } catch { return new Response(null, { status: 503 }) }
  } }]
}
