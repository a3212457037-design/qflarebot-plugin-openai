import type { PluginContext, Session } from '@qqbot/sdk'
import type { Config } from './config.js'
import { conversationKey } from './history.js'

// 官方模型枚举；模型名不用于构造 URL。
export const MODEL_IDS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'] as const
export type ModelId = typeof MODEL_IDS[number]
export const isModelId = (value: unknown): value is ModelId => typeof value === 'string' && MODEL_IDS.includes(value as ModelId)

export function modelSelectionKey(session: Session): string | null {
  const key = conversationKey(session)
  return key ? `model:${key}` : null
}

export class ModelStateError extends Error {
  constructor(readonly code: 'model_read' | 'model_write') {
    super(code === 'model_read' ? '暂时无法读取会话模型，请稍后再试。' : '模型选择保存失败，请稍后再试。')
    this.name = 'ModelStateError'
  }
}

export async function resolveModel(ctx: PluginContext<Config>, session: Session, fallback: ModelId): Promise<{ model: ModelId; overridden: boolean }> {
  const key = modelSelectionKey(session)
  if (!key) return { model: fallback, overridden: false }
  let raw: string | null
  try { raw = await ctx.kv.get(key) } catch { throw new ModelStateError('model_read') }
  if (raw && raw.length <= 256) {
    try {
      const value = JSON.parse(raw)
      if (value && typeof value === 'object' && !Array.isArray(value) && isModelId(value.model)) return { model: value.model, overridden: true }
    } catch { /* 损坏记录忽略，不把原文写入日志或请求 */ }
  }
  return { model: fallback, overridden: false }
}

export function parseModelChoice(text: string): ModelId | null {
  const value = text.trim().toLowerCase()
  if (/^[1-3]$/u.test(value)) return MODEL_IDS[Number(value) - 1]!
  return isModelId(value) ? value : null
}

export async function saveModel(ctx: PluginContext<Config>, session: Session, model: ModelId | null): Promise<boolean> {
  const key = modelSelectionKey(session)
  if (!key) return false
  try {
    if (model === null) await ctx.kv.delete(key)
    else {
      if (!isModelId(model)) return false
      // 这是会话偏好，不随聊天历史24小时TTL消失；/model default 才恢复跟随后台。
      await ctx.kv.put(key, { model })
    }
    return true
  } catch { throw new ModelStateError('model_write') }
}

export function modelMenu(current: { model: ModelId; overridden: boolean }, fallback: ModelId): string {
  return `当前模型：${current.model}（${current.overridden ? '本会话选择' : '跟随后台默认'}）\n后台默认：${fallback}\n可选模型：\n`
    + MODEL_IDS.map((id, i) => `${i + 1}. ${id}`).join('\n')
    + '\n切换：/model 序号或完整模型ID\n恢复默认：/model default\n仅影响当前会话，保留上下文；可用性和额度以 OpenAI 项目为准。'
}
