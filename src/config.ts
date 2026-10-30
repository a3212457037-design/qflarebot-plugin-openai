import type { JsonSchema } from '@qqbot/sdk'
import { MODEL_IDS, isModelId, type ModelId } from './models.js'

export interface Config {
  apiKey: string
  model: ModelId
  executionMode: 'responses' | 'background'
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  enableWebSearch: boolean
  maxInputChars: number
  maxOutputTokens: number
  timeoutMs: number
  ignoredCommandPrefixes: string[]
}

export const defaultConfig: Config = {
  apiKey: '', model: 'gpt-6-luna', executionMode: 'background', reasoningEffort: 'max',
  enableWebSearch: true, maxInputChars: 1000, maxOutputTokens: 128000, timeoutMs: 27000,
  ignoredCommandPrefixes: ['/'],
}
const ranges = { maxInputChars: [1, 1000], maxOutputTokens: [64, 128000], timeoutMs: [1000, 27000] } as const
const integer = (key: keyof typeof ranges, title: string) => ({
  type: 'integer', title, default: defaultConfig[key], minimum: ranges[key][0], maximum: ranges[key][1],
})
export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    apiKey: { type: 'string', title: 'OpenAI API Key', writeOnly: true, maxLength: 4096, default: '',
      description: '仅填写 OpenAI 官方 API Key，保存后不回显。独立于 Gemini；不要把密钥发到 QQ 或聊天中。' },
    model: { type: 'string', title: '默认聊天模型', enum: [...MODEL_IDS], default: defaultConfig.model,
      description: '聊天用 /model 切换当前会话，/model default 跟随后台默认。权限及额度以 OpenAI 项目为准，不自动换模型。' },
    executionMode: { type: 'string', title: '推理执行模式', enum: ['responses', 'background'], default: 'background',
      description: '默认后台推理，由现有每分钟 Cron 自动回复，支持超过 30 秒的推理。responses 为同步模式，最多等待 27 秒。后台需要现有 D1、KV 和每分钟 Cron。' },
    reasoningEffort: { type: 'string', title: '推理档位', enum: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'max',
      description: '三个内置模型均支持 max。高推理可能增加延迟和 Token 消耗，建议保持后台模式。' },
    enableWebSearch: { type: 'boolean', title: '启用 OpenAI 原生联网搜索', default: true,
      description: '由模型按需调用官方 web_search；/search 强制搜索。不使用 Tavily，也不需要其他搜索 Key。搜索调用按 OpenAI 项目计费，每轮最多 3 次内置工具调用，非账户费用封顶。' },
    maxInputChars: integer('maxInputChars', '问题字符上限'),
    maxOutputTokens: { ...integer('maxOutputTokens', '生成 Token 上限'), description: '三个内置模型的官方最大值 128000，包含可见输出及推理 Token。只是允许的上限，普通闲聊保持简洁。' },
    timeoutMs: { ...integer('timeoutMs', 'HTTP 超时（毫秒）'), description: '同步模式最多 27 秒；后台仅对每次提交/查询 HTTP 最多等待 8 秒，不限制远端推理总时长。QQ 回复窗口仍有效。' },
    ignoredCommandPrefixes: { type: 'array', title: '跳过的命令前缀', default: ['/'], maxItems: 16,
      items: { type: 'string', minLength: 1, maxLength: 32 },
      description: '普通聊天跳过这些前缀开头的命令，/ 始终跳过。SDK 无全局前缀读取接口，自定义前缀需在此同步填写。' },
  },
  required: ['apiKey', ...Object.keys(ranges)],
}
export function readConfig(value: Config): Config | null {
  if (!value || typeof value !== 'object') return null
  const config = { ...defaultConfig, ...value }
  if (!isModelId(config.model) || !['responses', 'background'].includes(config.executionMode)
    || !['low', 'medium', 'high', 'xhigh', 'max'].includes(config.reasoningEffort)
    || typeof config.enableWebSearch !== 'boolean' || typeof config.apiKey !== 'string' || config.apiKey.length > 4096) return null
  config.apiKey = config.apiKey.trim()
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(config.apiKey)) return null
  if (!Array.isArray(config.ignoredCommandPrefixes) || config.ignoredCommandPrefixes.length > 16
    || config.ignoredCommandPrefixes.some(p => typeof p !== 'string' || !p.length || p.length > 32)) return null
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    if (!Number.isSafeInteger(config[key]) || config[key] < ranges[key][0] || config[key] > ranges[key][1]) return null
  }
  return config
}
