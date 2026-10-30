import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig, readConfig, configSchema } from './config.js'
import { createInteraction, getInteraction, interactionAnswer, RESPONSES_URL, responseBody } from './responses.js'

const url = 'https://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/local-test/openai'
const config = { ...defaultConfig, apiKey: 'local-openai-credential', useAiGateway: true,
  aiGatewayUrl: url, aiGatewayToken: 'local-gateway-credential' }
afterEach(() => vi.useRealTimers())
describe('可选 Cloudflare 官方网关传输', () => {
  it('关闭时保留直连端点，不向 OpenAI 发送 Cloudflare Token 或网关头', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'resp_test', status: 'queued' }))
    await createInteraction('你好', { ...config, useAiGateway: false }, fetcher)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(RESPONSES_URL, expect.objectContaining({ headers: {
      'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey,
    } }))
  })
  it('创建和取结果使用同一网关；模型、high、原生工具与请求体保持', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: 'resp_test', status: 'queued' }))
    await createInteraction('你好', config, fetcher); await getInteraction('resp_test', config, fetcher)
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey,
      'cf-aig-authorization': 'Bearer ' + config.aiGatewayToken, 'cf-aig-collect-log': 'false',
      'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1' }
    expect(fetcher).toHaveBeenNthCalledWith(1, url + '/responses', expect.objectContaining({ method: 'POST', redirect: 'manual', headers }))
    expect(fetcher).toHaveBeenNthCalledWith(2, url + '/responses/resp_test', expect.objectContaining({ method: 'GET', redirect: 'manual', headers }))
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(responseBody('你好', { ...config, useAiGateway: false }, [], false, true))
  })
  it.each([
    'https://bad.test/v1/openai', 'http://gateway.ai.cloudflare.com/v1/' + 'a'.repeat(32) + '/test/openai',
    url + '?destination=bad', url + '#bad', url + '/../../bad', url.replace('cloudflare.com', 'cloudflare.com.bad.test'),
    url.replace('/local-test/', '/test%2fmalicious/'), url.replace('/' + 'a'.repeat(32) + '/', '/bad-account/'),
  ])('不接受任意网关URL或路径注入 %s', async aiGatewayUrl => {
    const fetcher = vi.fn<typeof fetch>()
    expect(readConfig({ ...config, aiGatewayUrl })).toBeNull()
    await expect(createInteraction('问题', { ...config, aiGatewayUrl }, fetcher)).rejects.toMatchObject({ code: 'request' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('旧配置默认直连；网关 Token 为 writeOnly，缺失或换行拒绝', () => {
    const legacy = { ...defaultConfig }; delete legacy.useAiGateway; delete legacy.aiGatewayUrl; delete legacy.aiGatewayToken
    expect(readConfig(legacy)).toMatchObject({ useAiGateway: false, aiGatewayUrl: '', aiGatewayToken: '' })
    expect((configSchema.properties as Record<string, unknown>).aiGatewayToken).toMatchObject({ writeOnly: true })
    expect(readConfig({ ...config, aiGatewayToken: '' })).toBeNull()
    expect(readConfig({ ...config, aiGatewayToken: 'bad\nvalue' })).toBeNull()
  })
  it('网关返回3xx不跟随、不回退、不重试', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 307, headers: { location: 'https://bad.test/' } }))
    await expect(createInteraction('问题', config, fetcher)).rejects.toMatchObject({ code: 'request' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([401, 403, 429, 500])('HTTP %i 保留固定提示和安全分类，不输出原始响应', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: status === 403 ? 'unsupported_country_region_territory' : '', message: config.apiKey + config.aiGatewayToken } }, { status }))
    const error = await createInteraction('问题', config, fetcher).catch(e => e)
    expect(error.api.status).toBe(status)
    if (status === 403) expect(error.api.reason).toBe('REGION_UNSUPPORTED')
    expect(JSON.stringify(error)).not.toContain(config.apiKey); expect(JSON.stringify(error)).not.toContain(config.aiGatewayToken)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('网关 Token 在异常、请求、正文和来源链接中均脱敏', async () => {
    const secretText = config.apiKey + ' ' + config.aiGatewayToken + ' ' + encodeURIComponent(config.aiGatewayToken)
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(secretText))
    const error = await createInteraction(secretText, config, fetcher).catch(e => e)
    const input = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    const text = interactionAnswer({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: secretText,
      annotations: [{ type: 'url_citation', url: 'https://source.test/' + config.aiGatewayToken, title: '来源' }] }] }] }, config)
    for (const item of [JSON.stringify(input), JSON.stringify(error.diagnostic), text]) {
      expect(item).not.toContain(config.apiKey); expect(item).not.toContain(config.aiGatewayToken)
    }
    expect(text).not.toContain('https://source.test/')
  })
  it('网关提交超时同样中止，绝不自动重投', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    const job = createInteraction('问题', { ...config, timeoutMs: 1000 }, fetcher).catch(e => e)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await job).toMatchObject({ code: 'timeout' })
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
