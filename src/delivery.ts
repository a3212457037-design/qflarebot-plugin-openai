import type { PluginContext, Session } from '@qqbot/sdk'
import type { Config } from './config.js'
import { conversationKey, HISTORY_TTL_SECONDS, KV_VALUE_BYTES } from './history.js'

// 官方文档未给纯文本统一的字符/字节数；这是保守的单条传输分段值，不限制总正文。
// 平台明确返回 40054007 时进一步缩小分段，原文仍在 KV 中，不截掉后半段。
export const QQ_PART_BYTES = 2000
export const GENERATION_BUDGET_MS = 27000
export const TURN_BUDGET_MS = 29000
export const MORE_TIP = '本次消息的回复条数或执行时间有限，剩余正文已保留；请发送 /more 继续领取（群聊需 @机器人），不会重新调用 AI。'
export interface PendingReply { id: string; text: string; updatedAt: number; offset: number }

export function pendingKeys(session: Session): [string, string] | null {
  const key = conversationKey(session)
  return key ? [`pending:${key}`, `pending-cursor:${key}`] : null
}

export function splitText(text: string, maxBytes = QQ_PART_BYTES, maxChunks = Infinity): string[] {
  if (maxBytes < 4) throw new Error('Chunk size must fit one Unicode code point')
  const chunks: string[] = []
  let start = 0
  while (start < text.length && chunks.length < maxChunks) {
    let end = start
    let bytes = 0
    while (end < text.length) {
      const cp = text.codePointAt(end)!
      const size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4
      if (bytes + size > maxBytes) break
      bytes += size
      end += cp > 0xffff ? 2 : 1
    }
    if (end < text.length) {
      const part = text.slice(start, end)
      const newline = part.lastIndexOf('\n')
      if (newline >= part.length / 2) end = start + newline + 1
      // 来源链接能装进一条时，不从中间拆开；不删除换行或空白。
      const tail = /https?:\/\/\S*$/u.exec(text.slice(start, end))
      if (tail && tail.index > 0 && !/\s/u.test(text[end] ?? '')) end = start + tail.index
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

export async function loadPending(ctx: PluginContext<Config>, session: Session): Promise<PendingReply | null> {
  const keys = pendingKeys(session)
  if (!keys) return null
  const raw = await ctx.kv.get(keys[0])
  if (!raw) return null
  if (new TextEncoder().encode(raw).byteLength > KV_VALUE_BYTES) throw new Error('Invalid pending reply')
  const value = JSON.parse(raw) as PendingReply
  if (!value || typeof value.id !== 'string' || value.id.length > 80 || typeof value.text !== 'string'
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    || value.updatedAt > Date.now() + 60000) throw new Error('Invalid pending reply')
  if (Date.now() - value.updatedAt >= HISTORY_TTL_SECONDS * 1000) return null
  let offset = 0
  const cursorRaw = await ctx.kv.get(keys[1])
  if (cursorRaw && cursorRaw.length < 1024) {
    try {
      const cursor = JSON.parse(cursorRaw)
      if (cursor.id === value.id && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= value.text.length
        && !(cursor.offset > 0 && /[\uDC00-\uDFFF]/u.test(value.text[cursor.offset] ?? ''))) offset = cursor.offset
    } catch { /* 损坏进度从头重发，宁可重复，不丢正文 */ }
  }
  return offset < value.text.length ? { ...value, offset } : null
}

export async function deliverPending(session: Session, ctx: PluginContext<Config>, pending: PendingReply,
  deadline: number, cancelled = () => false): Promise<undefined> {
  const keys = pendingKeys(session)!
  // 新版 QQ 单聊文档写 4 次，群聊写 5 次；均不超过 SDK 默认 5 条。
  const slots = session.scene === 'c2c' ? 4 : 5
  let attempts = 0
  let failed = false
  let bytes = QQ_PART_BYTES
  while (pending.offset < pending.text.length && attempts < slots - 1 && Date.now() < deadline && !cancelled()) {
    const chunk = splitText(pending.text.slice(pending.offset), bytes, 1)[0]!
    attempts++
    try {
      const result = await session.reply(chunk)
      if (!result.ok) {
        ctx.logger.warn('QQ 长回答发送未完成', { code: 'reply_send', status: result.status })
        if (result.code === 40054007 && bytes > 128) { bytes = Math.floor(bytes / 2); continue }
        failed = true
        break
      }
      pending.offset += chunk.length
    } catch {
      ctx.logger.warn('QQ 长回答发送未完成', { code: 'reply_send' })
      failed = true
      break
    }
  }
  if (cancelled()) return
  let progressSaved = true
  try {
    // 正文和进度分键，各在一轮里写一次，避免同一 KV key 每秒写多次。
    await ctx.kv.put(keys[1], { id: pending.id, offset: pending.offset }, { ttl: HISTORY_TTL_SECONDS })
  } catch {
    progressSaved = false
    ctx.logger.warn('QQ 长回答进度保存失败', { code: 'pending_write' })
  }
  const notice = !progressSaved ? '发送进度保存失败，原文仍保留；/more 可能重复上一批正文。'
    : failed ? 'QQ 发送失败，未发出的正文已保留，请发送 /more 重试。'
      : pending.offset < pending.text.length ? MORE_TIP : ''
  if (notice && attempts < slots && !cancelled()) {
    try {
      const result = await session.reply(notice)
      if (!result.ok) ctx.logger.warn('QQ 长回答提示发送失败', { code: 'reply_notice', status: result.status })
    } catch { ctx.logger.warn('QQ 长回答提示发送失败', { code: 'reply_notice' }) }
  }
}

export async function deliverAnswer(session: Session, ctx: PluginContext<Config>, text: string,
  deadline: number, cancelled = () => false): Promise<string | undefined> {
  if (new TextEncoder().encode(text).byteLength <= QQ_PART_BYTES) return text
  const keys = pendingKeys(session)
  if (!keys) return '回答过长，但当前会话身份不完整，无法安全保存分段；请重新提问。'
  const pending: PendingReply = { id: crypto.randomUUID(), text, updatedAt: Date.now(), offset: 0 }
  try { await ctx.kv.put(keys[0], pending, { ttl: HISTORY_TTL_SECONDS }) }
  catch {
    ctx.logger.warn('QQ 长回答保存失败', { code: 'pending_write' })
    return '长回答暂时无法保存，未开始分段发送，请稍后重试。'
  }
  if (cancelled()) { await ctx.kv.delete(keys[0]); return }
  return deliverPending(session, ctx, pending, deadline, cancelled)
}
