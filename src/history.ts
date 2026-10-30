import type { ScopedKV, Session } from '@qqbot/sdk'

export interface ChatMessage {
  role: 'user' | 'model'
  parts: [{ text: string }]
}

export const HISTORY_TTL_SECONDS = 86400
const MAX_MESSAGES = 12
// Workers KV 单值上限 25 MiB；不再把模型回答限制成 500 字符。
export const KV_VALUE_BYTES = 25 * 1024 * 1024

export function conversationKey(session: Pick<Session, 'botId' | 'userId' | 'scene' | 'targetId'>): string | null {
  if (!session.botId || !session.userId) return null
  if (session.scene === 'c2c') return `history:${JSON.stringify([session.botId, 'c2c', session.userId])}`
  if (session.scene === 'group' && session.targetId) return `history:${JSON.stringify([session.botId, 'group', session.targetId, session.userId])}`
  return null
}

export function message(role: ChatMessage['role'], text: string): ChatMessage {
  return { role, parts: [{ text }] }
}

export function parseHistory(raw: string | null, now = Date.now()): ChatMessage[] {
  if (!raw || new TextEncoder().encode(raw).byteLength > KV_VALUE_BYTES) return []
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const { updatedAt, messages } = value
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0
      || updatedAt > now + 60000 || now - updatedAt >= HISTORY_TTL_SECONDS * 1000) return []
    if (!Array.isArray(messages) || messages.length > MAX_MESSAGES || messages.length % 2 !== 0) return []
    const result: ChatMessage[] = []
    for (const [i, item] of messages.entries()) {
      const role = i % 2 === 0 ? 'user' : 'model'
      if (!item || item.role !== role || !Array.isArray(item.parts) || item.parts.length !== 1) return []
      const text = item.parts[0]?.text
      if (typeof text !== 'string' || !text.trim() || (role === 'user' && Array.from(text).length > 1000)) return []
      // 只重建已验证的文本字段，不能把存储中的任意元数据带入请求。
      result.push(message(role, text))
    }
    return result
  } catch { return [] }
}

export async function loadHistory(kv: ScopedKV, key: string): Promise<ChatMessage[]> {
  return parseHistory(await kv.get(key))
}

export async function saveHistory(kv: ScopedKV, key: string, history: ChatMessage[], question: string, answer: string): Promise<void> {
  const messages = [...history, message('user', question), message('model', answer)].slice(-MAX_MESSAGES)
  // SDK 将 ttl 原样映射为 expirationTtl（秒，最低 60），不是毫秒。
  const value = { updatedAt: Date.now(), messages }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > KV_VALUE_BYTES) throw new Error('History exceeds KV capacity')
  await kv.put(key, value, { ttl: HISTORY_TTL_SECONDS })
}
