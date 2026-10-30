import { readConfig, validGateway, type Config } from './config.js'
import { apiError, object, readJson } from './responses.js'

type Check = { status: number | null; result: string; format?: 'cloudflare' | 'openai' | 'other' }
// 只读检查：不创建 Response、不生成 Token、不发送 QQ、不读写历史。
// 原始 JSON、错误消息、响应头和凭证均不返回、不记录、不持久化。
async function check(url: string, headers: Record<string, string>, fetcher: typeof fetch, verifyToken = false): Promise<Check> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async (): Promise<Check> => {
        const response = await fetcher(url, { method: 'GET', redirect: 'manual', headers, signal: controller.signal })
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => {})
          return { status: response.status, result: 'REDIRECT_REFUSED' }
        }
        if (response.ok && !verifyToken) {
          void response.body?.cancel().catch(() => {})
          return { status: response.status, result: 'READ_ACCESS_OK' }
        }
        let json: unknown
        try { json = await readJson(response, 64 * 1024) } catch { return { status: response.status, result: 'UNCLASSIFIED', format: 'other' } }
        const value = object(json)
        if (verifyToken) {
          const state = object(value.result).status
          return { status: response.status, result: response.ok && value.success === true && state === 'active' ? 'TOKEN_ACTIVE'
            : state === 'disabled' ? 'TOKEN_DISABLED' : state === 'expired' ? 'TOKEN_EXPIRED' : 'TOKEN_NOT_VERIFIED' }
        }
        const format = Array.isArray(value.errors) ? 'cloudflare' : Object.keys(object(value.error)).length ? 'openai' : 'other'
        // Cloudflare 封装中只识别官方错误码；不把任意上游 code/message 当作诊断输出。
        const codes = Array.isArray(value.errors) ? value.errors.slice(0, 8).map(item => object(item).code) : []
        const result = codes.includes(2009) ? 'PROVIDER_CREDENTIAL_REJECTED'
          : codes.includes(2044) ? 'PROVIDER_CREDENTIAL_REQUIRED'
          : response.status === 404 ? 'RESOURCE_NOT_FOUND'
          : apiError(response.status, json).api!.reason
        return { status: response.status, result, format }
      })(),
      new Promise<Check>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: null, result: 'TIMEOUT' }) }, 3500) }),
    ])
  } catch { return { status: null, result: 'NETWORK' } }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

export async function checkAuthentication(raw: Config, fetcher: typeof fetch) {
  const config = readConfig(raw)
  if (!config?.apiKey || config.apiKey.startsWith('__qflare_secret__:')) return { result: 'CONFIG_INVALID' }
  const direct = () => check('https://api.openai.com/v1/models', { authorization: `Bearer ${config.apiKey}` }, fetcher)
  if (!config.useAiGateway || !validGateway(config)) return { directOpenAI: await direct(), gateway: { result: 'DISABLED' } }
  const account = config.aiGatewayUrl!.split('/')[4]!
  const token = async () => {
    const headers = { authorization: `Bearer ${config.aiGatewayToken}` }
    const user = await check('https://api.cloudflare.com/client/v4/user/tokens/verify', headers, fetcher, true)
    if (user.result === 'TOKEN_ACTIVE') return user
    const accountToken = await check(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, headers, fetcher, true)
    return accountToken.result === 'TOKEN_ACTIVE' ? accountToken : { user, account: accountToken }
  }
  const [cloudflareToken, directOpenAI, gateway] = await Promise.all([
    token(), direct(),
    // 查询固定不存在的资源，不创建后台任务；404 只代表资源不存在，不宣称模型调用已验证。
    check(`${config.aiGatewayUrl}/responses/resp_qflarebot_auth_check_nonexistent`, {
      authorization: `Bearer ${config.apiKey}`, 'cf-aig-authorization': `Bearer ${config.aiGatewayToken}`,
      'cf-aig-collect-log': 'false', 'cf-aig-collect-log-payload': 'false',
      'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1',
    }, fetcher),
  ])
  return { cloudflareToken, directOpenAI, gateway,
    note: '只读认证诊断，不代表模型生成、计费额度或 QQ 投递已验证；网关 404 只代表资源不存在。' }
}
