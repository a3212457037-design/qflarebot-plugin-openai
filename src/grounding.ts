function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function hideKey(text: string, apiKey: string, ...otherKeys: string[]): string {
  for (const key of new Set([apiKey, ...otherKeys].flatMap((key) => [key, encodeURIComponent(key)]))) {
    if (key) text = text.split(key).join('[密钥已隐藏]')
  }
  return text
}

export function sourceUrl(value: unknown, keys: string[]): string | null {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    let decoded = value
    try { decoded = decodeURIComponent(value) } catch { /* 检查原值 */ }
    if (keys.some((key) => hideKey(value, key) !== value || hideKey(decoded, key) !== decoded)) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

// 保留完整正文与最多两个真实来源；传输分段由 QQ 投递层完成。
export function appendSources(answer: string, metadata: unknown, apiKey: string, ...otherKeys: string[]): string {
  const chunks = record(metadata).groundingChunks
  if (!Array.isArray(chunks)) return answer
  const seen = new Set<string>()
  let result = answer
  let count = 0
  for (const chunk of chunks) {
    if (count === 2) break
    const web = record(record(chunk).web)
    const href = sourceUrl(web.uri, [apiKey, ...otherKeys])
    if (!href) continue
    if (seen.has(href)) continue
    const title = hideKey(typeof web.title === 'string' && web.title.trim() ? web.title : new URL(href).hostname, apiKey, ...otherKeys)
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/(?:https?:\/\/|www\.)\S+/giu, '')
      .replace(/\s+/gu, ' ').trim() || new URL(href).hostname
    const prefix = count ? '\n' : '\n来源：\n'
    const label = Array.from(title).slice(0, 24).join('')
    result += prefix + label + ' ' + href
    seen.add(href)
    count++
  }
  return result
}
