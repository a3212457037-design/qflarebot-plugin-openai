import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkAuthentication } from './auth-check.js'
import { backgroundRoutes } from './background-panel.js'
import { defaultConfig } from './config.js'

const config = { ...defaultConfig, apiKey: 'local-openai-auth-test', useAiGateway: true,
  aiGatewayUrl: 'https://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/test/openai', aiGatewayToken: 'local-cf-auth-test' }
const secret = config.apiKey + config.aiGatewayToken
afterEach(() => vi.useRealTimers())
describe('管理员只读认证检查', () => {
  it('凭证分开送往官方目标；只用 GET，不生成回答、不输出列表或私密响应', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual'); expect(init?.body).toBeUndefined()
      const headers = init?.headers as Record<string, string>
      if (String(url).includes('/tokens/verify')) {
        expect(headers).toEqual({ authorization: 'Bearer ' + config.aiGatewayToken })
        return Response.json({ success: true, result: { status: 'active', id: secret } })
      }
      expect(headers.authorization).toBe('Bearer ' + config.apiKey)
      if (String(url).includes('api.openai.com')) {
        expect(headers).not.toHaveProperty('cf-aig-authorization')
        return Response.json({ data: [secret] })
      }
      expect(headers).toMatchObject({ 'cf-aig-authorization': 'Bearer ' + config.aiGatewayToken,
        'cf-aig-collect-log': 'false', 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1' })
      return Response.json({ error: { message: secret } }, { status: 404 })
    })
    const result = await checkAuthentication(config, fetcher)
    expect(result).toMatchObject({ cloudflareToken: { result: 'TOKEN_ACTIVE' }, directOpenAI: { result: 'READ_ACCESS_OK' }, gateway: { status: 404, result: 'RESOURCE_NOT_FOUND' } })
    expect(fetcher).toHaveBeenCalledTimes(3); expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('账户所有 Token 也可验证，用户接口未验证不误判无效', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(
      String(url).includes('/accounts/') ? { success: true, result: { status: 'active' } } : { errors: [{ message: secret }] },
      { status: String(url).includes('/accounts/') ? 200 : 401 }))
    expect(await checkAuthentication(config, fetcher)).toMatchObject({ cloudflareToken: { result: 'TOKEN_ACTIVE' } })
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/accounts/' + 'a'.repeat(32) + '/tokens/verify'))).toBe(true)
  })
  it('可区分令牌验证失败、OpenAI 地区拒绝和网关封装的认证失败，不输出原文', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (String(url).includes('/tokens/verify')) return Response.json({ success: false, errors: [{ code: 1000, message: secret }] }, { status: 401 })
      if (String(url).includes('api.openai.com')) return Response.json({ error: { code: 'unsupported_country_region_territory', message: secret } }, { status: 403 })
      return Response.json({ errors: [{ code: 2009, message: secret }] }, { status: 401 })
    })
    const result = await checkAuthentication(config, fetcher)
    expect(result).toMatchObject({ cloudflareToken: { user: { result: 'TOKEN_NOT_VERIFIED' }, account: { result: 'TOKEN_NOT_VERIFIED' } },
      directOpenAI: { result: 'REGION_UNSUPPORTED' }, gateway: { format: 'cloudflare', result: 'PROVIDER_CREDENTIAL_REJECTED' } })
    expect(JSON.stringify(result)).not.toContain(config.apiKey); expect(JSON.stringify(result)).not.toContain(config.aiGatewayToken)
  })
  it('识别 OpenAI 原始错误结构但仅输出固定分类', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: 'invalid_api_key', message: secret } }, { status: 401 }))
    const result = await checkAuthentication(config, fetcher)
    expect(result.gateway).toMatchObject({ status: 401, format: 'openai', result: 'INVALID_API_KEY' })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('旧配置关闭网关时不传 Cloudflare Token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }))
    expect(await checkAuthentication({ ...config, useAiGateway: false }, fetcher)).toMatchObject({ gateway: { result: 'DISABLED' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.openai.com/v1/models')
  })
  it('配置非法不发请求，不接受任意 URL', async () => {
    const fetcher = vi.fn<typeof fetch>()
    expect(await checkAuthentication({ ...config, aiGatewayUrl: 'https://bad.test' }, fetcher)).toEqual({ result: 'CONFIG_INVALID' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('3xx 不跟随，非 JSON 和网络异常不回显', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (String(url).includes('/tokens/verify')) throw new Error(secret)
      if (String(url).includes('api.openai.com')) return new Response(null, { status: 307, headers: { location: 'https://bad.test/' + secret } })
      return new Response(secret, { status: 401 })
    })
    const result = await checkAuthentication(config, fetcher)
    expect(result).toMatchObject({ directOpenAI: { result: 'REDIRECT_REFUSED' }, gateway: { status: 401, result: 'UNCLASSIFIED' } })
    expect(JSON.stringify(result)).not.toContain(config.apiKey); expect(JSON.stringify(result)).not.toContain(config.aiGatewayToken)
  })
  it('超时中止、不重试，直接检查最多等 3.5 秒', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    const result = checkAuthentication({ ...config, useAiGateway: false }, fetcher)
    await vi.advanceTimersByTimeAsync(3501)
    expect(await result).toMatchObject({ directOpenAI: { result: 'TIMEOUT' } })
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
  })
  it('检查接口仅管理员 POST 可用，并有短冷却且不缓存', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }))
    const route = backgroundRoutes(fetcher).find(item => item.path === '/api/auth-check')!
    expect(route).toMatchObject({ method: 'POST', auth: 'admin' })
    const input = { ctx: { config: { ...config, useAiGateway: false } } } as never
    const first = await route.handler(input)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const second = await route.handler(input)
    expect(second.status).toBe(429); expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
