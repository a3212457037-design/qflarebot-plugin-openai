import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyWebhook } from '../src/webhook.js'
import { defaultConfig, readConfig, configSchema } from '../src/config.js'
import { createInteraction, interactionAnswer } from '../src/responses.js'

const secret = 'whsec_' + Buffer.from('local-test-signing-key-32-bytes!!').toString('base64')
const now = 1793353000000
function request(body: string, stamp = String(now / 1000), id = 'wh_test', signingSecret = secret) {
  const signature = createHmac('sha256', Buffer.from(signingSecret.slice(6), 'base64')).update(`${id}.${stamp}.${body}`).digest('base64')
  return new Request('https://bot.test/p/openai/callback', { method: 'POST', body,
    headers: { 'webhook-id': id, 'webhook-timestamp': stamp, 'webhook-signature': `v1,${signature}` } })
}
const body = JSON.stringify({ type: 'response.completed', data: { id: 'resp_test' } })
describe('OpenAI Standard Webhooks 验签', () => {
  it('独立 Node HMAC 签名可通过 WebCrypto 校验，原始空白及中文保持', async () => {
    expect(await verifyWebhook(request(' {"type":"response.completed", "data":{"id":"resp_test"},"note":"中文"}\n'), secret, now)).toEqual({ id: 'wh_test', interaction: 'resp_test' })
  })
  it('支持轮换期间多个签名', async () => {
    const r = request(body); r.headers.set('webhook-signature', 'v1,invalid v2,ignored ' + r.headers.get('webhook-signature'))
    expect(await verifyWebhook(r, secret, now)).toBeTruthy()
  })
  it.each([-301, 301])('拒绝超出五分钟的过去/未来时间戳 %s', async delta => {
    await expect(verifyWebhook(request(body, String(now / 1000 + delta)), secret, now)).rejects.toThrow()
  })
  it('拒绝修改后的正文及错误密钥', async () => {
    const original = request(body)
    await expect(verifyWebhook(new Request(original.url, { method: 'POST', headers: original.headers, body: body + ' ' }), secret, now)).rejects.toThrow()
    await expect(verifyWebhook(request(body), 'whsec_' + btoa('different-local-key-32-bytes!!!!!'), now)).rejects.toThrow()
  })
  it('拒绝缺失、无效头、畸形 JSON 和过大正文，不泄露签名密钥', async () => {
    const cases = [request('not json'), request('a'.repeat(65537)), request(body, 'bad'), request(body, String(now / 1000), 'bad.id'), new Request('https://bot.test', { method: 'POST', body })]
    for (const r of cases) {
      const error = await verifyWebhook(r, secret, now).catch(e => e)
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(secret)
    }
  })
  it('过滤其他事件及无效 Response ID', async () => {
    expect(await verifyWebhook(request('{"type":"batch.completed"}'), secret, now)).toBeNull()
    await expect(verifyWebhook(request('{"type":"response.completed","data":{"id":"https://bad.test/"}}'), secret, now)).rejects.toThrow()
  })
  it('旧配置保持 Cron，签名密钥 writeOnly，非法模式/密钥拒绝', () => {
    const legacy = { ...defaultConfig, apiKey: 'test' }; delete legacy.backgroundDelivery; delete legacy.webhookSecret
    expect(readConfig(legacy)).toMatchObject({ backgroundDelivery: 'cron', webhookSecret: '' })
    expect(configSchema.properties?.webhookSecret).toMatchObject({ writeOnly: true })
    expect(readConfig({ ...legacy, backgroundDelivery: 'bad' } as never)).toBeNull()
    expect(readConfig({ ...legacy, webhookSecret: 'bad\nsecret' })).toBeNull()
  })
  it('网络诊断、请求及回答同时隐藏 API Key 和签名密钥', async () => {
    const config = { ...defaultConfig, apiKey: 'local-api-secret', webhookSecret: secret }
    const combined = config.apiKey + ' ' + secret + ' ' + encodeURIComponent(secret)
    const error = await createInteraction(combined, config, async () => { throw new TypeError(combined) }).catch(e => e)
    expect(JSON.stringify(error.diagnostic)).not.toContain(config.apiKey)
    expect(JSON.stringify(error.diagnostic)).not.toContain(secret)
    const answer = interactionAnswer({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: combined }] }] }, config)
    expect(answer).not.toContain(config.apiKey); expect(answer).not.toContain(secret)
  })
})

