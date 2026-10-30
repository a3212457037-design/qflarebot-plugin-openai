import type { Route } from '@qqbot/sdk'
import type { Config } from './config.js'
import { ensureBackground, metaGet } from './background.js'

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css">
<style>body{font:16px system-ui;padding:20px;line-height:1.6}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{padding:10px}</style>
<h2>OpenAI 后台任务</h2><p>使用已有 D1、KV 和每分钟 Cron 自动回复，不需要 /result。后台模式允许远端推理超过 30 秒；单聊原消息 60 分钟、群聊 5 分钟内有效。</p>
<p>模型权限以当前 OpenAI 项目为准。本页仅显示安全状态，不读取或展示密钥、用户标识、问题或回答。/reset 取消当前会话未完成任务；已在途的 QQ 消息无法撤回。</p>
<button id="refresh">刷新任务状态</button><pre id="result">正在读取…</pre>
<script type="module">import {createBridge} from '/bridge.js';const bridge=await createBridge();const button=document.getElementById('refresh');
async function run(){button.disabled=true;try{const response=await bridge.fetch('/api/status');document.getElementById('result').textContent=JSON.stringify(await response.json(),null,2)}catch{document.getElementById('result').textContent='暂时无法读取状态，请稍后刷新。'}finally{button.disabled=false;bridge.resize()}}
button.onclick=run;await run();</script></html>`

export function backgroundRoutes(_fetcher: typeof fetch): Route<Config>[] {
  return [
    { method: 'GET', path: '/ui/', auth: 'admin', handler: () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
    { method: 'GET', path: '/api/status', auth: 'admin', async handler({ ctx }) {
      try {
        await ensureBackground(ctx)
        return Response.json({ executionMode: ctx.config.executionMode, model: ctx.config.model,
          lastPollAt: await metaGet(ctx, 'last_cron_or_callback'),
          tasks: await ctx.db.all('SELECT state,model,created,updated,model_ms,error FROM {async_tasks} WHERE bot=? ORDER BY created DESC LIMIT 10', ctx.botId),
        }, { headers: { 'cache-control': 'no-store' } })
      } catch { return Response.json({ error: '后台任务状态暂不可用。' }, { status: 503 }) }
    } },
  ]
}
