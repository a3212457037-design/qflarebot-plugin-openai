import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig, readConfig, configSchema } from './config.js'
import { MODEL_IDS, parseModelChoice } from './models.js'
import { apiError, askOpenAI, createInteraction, getInteraction, interactionAnswer, responseBody, RESPONSES_URL, RESPONSE_BYTES } from './responses.js'
import { message } from './history.js'

const config = { ...defaultConfig, apiKey: 'local-openai-test-credential' }
const result = (text = '回答', status = 'completed') => ({ id: 'resp_test', status,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
})
afterEach(() => vi.useRealTimers())
describe('官方 Responses API', () => {
  it.each(MODEL_IDS)('%s 固定官方端点、Bearer、manual、后台和high，携带六轮及当前问题', async model => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'resp_test', status: 'queued' }))
    const history = Array.from({ length: 7 }, (_, i) => [message('user', `问题${i}`), message('model', `回答${i}`)]).flat()
    await createInteraction('当前问题', { ...config, model }, fetcher, history)
    expect(fetcher).toHaveBeenCalledWith(RESPONSES_URL, expect.objectContaining({ method: 'POST', redirect: 'manual', headers: {
      'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`,
    } }))
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body).toMatchObject({ model, background: true, store: true, reasoning: { effort: 'high' }, max_output_tokens: 128000,
      tools: [{ type: 'web_search' }], tool_choice: 'auto', max_tool_calls: 3 })
    expect(body.input).toHaveLength(13)
    expect(body.input[0]).toEqual({ role: 'user', content: '问题1' })
    expect(body.input[1]).toEqual({ role: 'assistant', content: '回答1' })
    expect(body.input[12]).toEqual({ role: 'user', content: '当前问题' })
    expect(body).not.toHaveProperty('previous_response_id')
    expect(body).not.toHaveProperty('contents')
    expect(body).not.toHaveProperty('generationConfig')
  })
  it('Terra序号4及完整ID都可切换，默认请求明确使用high', () => {
    expect(parseModelChoice('4')).toBe('gpt-6.1-terra')
    expect(parseModelChoice('gpt-6.1-terra')).toBe('gpt-6.1-terra')
    expect(parseModelChoice('1')).toBe('gpt-6-luna')
    expect(parseModelChoice('5')).toBeNull()
    expect(responseBody('问题', config, [])).toMatchObject({ model: 'gpt-6.1-terra', reasoning: { effort: 'high' } })
  })
  it('开关关闭时无tools，原生/search才required；不调用第三方搜索', () => {
    expect(responseBody('你好', { ...config, enableWebSearch: false }, [])).not.toHaveProperty('tools')
    expect(responseBody('新闻', config, [], true)).toMatchObject({ tool_choice: 'required', tools: [{ type: 'web_search' }] })
    expect(() => responseBody('新闻', { ...config, enableWebSearch: false }, [], true)).toThrow('联网搜索')
  })
  it('同步模式复用相同Responses结构，但不远端存储历史', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result()))
    expect(await askOpenAI('问题', config, fetcher)).toBe('回答')
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ background: false, store: false })
  })
  it('仅输出最终assistant文本，不回显工具、推理、输入或进度消息', () => {
    expect(interactionAnswer({ ...result(), output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '秘密' }] },
      { type: 'message', role: 'user', content: [{ type: 'output_text', text: '旧问题' }] },
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '进度' }] },
      ...result().output,
    ] }, config)).toBe('回答')
  })
  it('真实原生引用变成QQ可访问链接，去重且过滤危险链接和Key', () => {
    const output = [{ type: 'web_search_call', status: 'completed' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `新闻[1] ${config.apiKey}`,
      annotations: [
        { type: 'url_citation', url: 'https://source.test/a', title: '真实来源', start_index: 2, end_index: 5 },
        { type: 'url_citation', url: 'https://source.test/a', title: '重复' },
        { type: 'url_citation', url: 'javascript:alert(1)', title: '无效' },
        { type: 'url_citation', url: `https://bad.test/${config.apiKey}`, title: '密钥' },
      ] }] }]
    const text = interactionAnswer({ ...result(), output }, config, true)
    expect(text).toContain('新闻[1]（https://source.test/a）')
    expect(text.match(/https:\/\/source.test\/a/gu)).toHaveLength(1)
    expect(text).not.toContain('javascript:'); expect(text).not.toContain(config.apiKey)
  })
  it('无引用不编造来源；强制搜索无调用或工具失败明确报错', () => {
    expect(interactionAnswer(result(), config)).toBe('回答')
    expect(() => interactionAnswer(result(), config, true)).toThrow('联网搜索')
    expect(() => interactionAnswer({ ...result(), output: [{ type: 'web_search_call', status: 'failed' }, ...result().output] }, config)).toThrow('联网搜索')
  })
  it('大量中文正文完整保留，不再裁剪成500字；未完成和拒答明确处理', () => {
    const text = '中文😀'.repeat(20000)
    expect(interactionAnswer(result(text), config)).toBe(text)
    expect(interactionAnswer(result(text, 'incomplete'), config)).toContain('本次生成未完成')
    expect(() => interactionAnswer({ ...result(), output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: config.apiKey }] }] }, config)).toThrow('这个问题')
    expect(() => interactionAnswer(result(''), config)).toThrow('未返回有效回答')
  })
  it.each([[401, 'auth'], [403, 'auth'], [404, 'model'], [429, 'rate'], [500, 'unavailable'], [504, 'timeout']])('HTTP%s安全分类%s，不暴露原始错误', async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: config.apiKey } }, { status: status as number }))
    const error = await askOpenAI('问题', config, fetcher).catch(e => e)
    expect(error.code).toBe(code); expect(JSON.stringify(error)).not.toContain(config.apiKey)
  })
  it('429不足额度区别限流', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }))
    await expect(askOpenAI('问题', config, fetcher)).rejects.toMatchObject({ code: 'quota' })
  })
  it.each([
    ['unsupported_country_region_territory', 'Country, region, or territory not supported', 'REGION_UNSUPPORTED'],
    ['ip_not_authorized', 'IP not authorized', 'IP_NOT_AUTHORIZED'],
    ['invalid_api_key', 'Incorrect API key provided', 'INVALID_API_KEY'],
    ['', 'Missing scopes: model.request', 'INSUFFICIENT_PERMISSIONS'],
    ['model_not_found', 'model unavailable', 'MODEL_ACCESS_DENIED'],
    ['', 'Your organization must be verified', 'ORG_VERIFICATION_REQUIRED'],
    ['', 'You must be a member of an organization', 'PROJECT_OR_ORG_ACCESS'],
    [config.apiKey, config.apiKey, 'AUTH'],
  ])('403固定原因分类%s，不输出原始报错或密钥', (code, text, reason) => {
    const error = apiError(403, { error: { code, message: `${text} ${config.apiKey}`, details: { secret: config.apiKey } } })
    expect(error).toMatchObject({ code: 'auth', api: { status: 403, reason } })
    expect(error.message).toBe('AI 密钥或访问权限异常，请联系机器人管理员。')
    expect(JSON.stringify(error)).not.toContain(config.apiKey)
  })
  it.each([301, 302, 307, 308])('HTTP%s不跟随，不把Key发往重定向目标', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status, headers: { location: 'https://evil.test' } }))
    await expect(createInteraction('问题', config, fetcher)).rejects.toMatchObject({ code: 'request' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('后台提交8秒超时中止，无自动重投；网络异常双重脱敏且限制长度', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    const pending = createInteraction('问题', config, fetcher).catch(e => e)
    await vi.advanceTimersByTimeAsync(8001)
    expect((await pending).code).toBe('timeout')
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const error = new TypeError(`${config.apiKey} ${encodeURIComponent(config.apiKey)}\n${'x'.repeat(500)}`)
    error.name = config.apiKey
    const broken = await createInteraction('问题', config, vi.fn<typeof fetch>().mockRejectedValue(error)).catch(e => e)
    expect(JSON.stringify(broken)).not.toContain(config.apiKey)
    expect(broken.diagnostic.message.length).toBeLessThanOrEqual(200)
  })
  it('无效JSON和过大响应安全失败，ResponseID不能注入URL或读取别的任务', async () => {
    for (const raw of ['not-json', 'x'.repeat(RESPONSE_BYTES + 1)]) {
      await expect(askOpenAI('问题', config, vi.fn<typeof fetch>().mockResolvedValue(new Response(raw)))).rejects.toMatchObject({ code: 'response' })
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result()))
    await expect(getInteraction('../evil', config, fetcher)).rejects.toMatchObject({ code: 'response' })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(getInteraction('resp_other', config, fetcher)).rejects.toMatchObject({ code: 'response' })
  })
  it('发送和返回都去除已配置Key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result(config.apiKey + '正常正文')))
    expect(await askOpenAI(config.apiKey, config, fetcher, [message('user', config.apiKey), message('model', config.apiKey)])).not.toContain(config.apiKey)
    expect(fetcher.mock.calls[0]![1]!.body).not.toContain(config.apiKey)
  })
  it('writeOnly配置、安全模型列表、正确默认及范围', () => {
    expect(configSchema).toMatchObject({ properties: { apiKey: { writeOnly: true } } })
    expect(defaultConfig).toMatchObject({ executionMode: 'background', reasoningEffort: 'high', maxOutputTokens: 128000 })
    expect(readConfig({ apiKey: config.apiKey } as typeof config)).toMatchObject({ model: 'gpt-6.1-terra', executionMode: 'background' })
    for (const patch of [{ model: 'https://evil.test' }, { timeoutMs: 27001 }, { maxOutputTokens: 128001 }, { enableWebSearch: 'yes' }, { apiKey: 'bad\nkey' }]) {
      expect(readConfig({ ...config, ...patch } as typeof config)).toBeNull()
    }
  })
})
