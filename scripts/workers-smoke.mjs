// 真实 workerd + D1 + KV，OpenAI / QQ 使用本地替身；不读取真实凭证。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../../QFlareBot/package.json', import.meta.url))
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare')
const { build } = wranglerRequire('esbuild')
const { outputFiles } = await build({ stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `
import {createOpenAIPlugin} from './dist/plugin.js';
import {createScopedDB,createScopedKV} from '../QFlareBot/packages/runtime/src/scoped.ts';
export default {async fetch(request,env,execution){
 const url=new URL(request.url); const mode=url.searchParams.get('mode'); const scene=url.searchParams.get('scene')??'c2c';
 const config={apiKey:'local-fake-background-key',model:'gpt-6-luna',executionMode:'background',reasoningEffort:'max',enableWebSearch:true,maxInputChars:1000,maxOutputTokens:65536,timeoutMs:27000,ignoredCommandPrefixes:['/']};
 const db=createScopedDB(env.DB,'openai');const kv=createScopedKV(env.KV,'openai');
 const fetcher=async(input,init)=>{
  if(!String(input).startsWith('https://api.openai.com/v1/responses'))throw new Error('unexpected host');
  if(init.redirect!=='manual'||init.headers.authorization!=='Bearer '+config.apiKey)throw new Error('unsafe request');
  if(init.method==='POST'){
   const body=JSON.parse(init.body);if(!body.background||!body.store||body.reasoning.effort!=='max'||body.tools[0].type!=='web_search')throw new Error('invalid native request');
   return Response.json({id:'resp_'+scene,status:'queued'});
  }
  return Response.json({id:'resp_'+scene,status:'completed',output:[{type:'reasoning',summary:[{type:'summary_text',text:'never send'}]},
   {type:'web_search_call',status:'completed'},{type:'message',role:'assistant',content:[{type:'output_text',text:'workerd自动回复中文😀',annotations:[{type:'url_citation',url:'https://source.test/',title:'真实来源'}]}]}]});
 };
 const plugin=createOpenAIPlugin(fetcher);
 const ctx={config,db,kv,botId:'bot',logger:{warn(){}},waitUntil:p=>execution.waitUntil(p),api:{async sendMessage(target,text,options){
  await db.run('INSERT INTO {smoke_sent}(scene,text,seq) VALUES (?,?,?)',target.scene,text,options.msgSeq);return {ok:true,status:200,raw:{}};
 }}};
 await db.exec('CREATE TABLE IF NOT EXISTS {smoke_sent}(scene TEXT,text TEXT,seq INTEGER)');
 const session={botId:'bot',userId:'u',scene,targetId:scene==='group'?'g':'u',messageId:'m-'+scene,timestamp:Date.now(),event:scene==='group'?'qq.group.at_message':'qq.c2c.message',content:'你好',atMe:true,attachments:[],canReply:true};
 if(mode==='submit'){
  // 先跑管理页GET，确保在真实D1中幂等建表；这里只注入已核验标记，绝不调用外网。
  const route=plugin.routes.find(r=>r.path==='/api/status');await route.handler({ctx,request,params:{},authenticated:true});
  const reply=await plugin.regex[0].handler({ctx,session,match:['你']});return Response.json({reply:reply??null,tasks:await db.all('SELECT state,interaction FROM {async_tasks}')});
 }
 if(mode==='reset') await plugin.commands.reset.handler({ctx,session,argText:''});
 if(mode==='poll') await plugin.cron.background.handler({ctx,job:'background',scheduledAt:Date.now()});
 return Response.json({sent:await db.all('SELECT * FROM {smoke_sent}'),tasks:await db.all('SELECT state,scene,seq FROM {async_tasks}')});
}};` }, write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' })
const options = { modules: true, script: outputFiles[0].text, compatibilityDate: '2026-09-01', d1Databases: { DB: 'smoke' }, kvNamespaces: ['KV'] }
const mf = new Miniflare(typeof convertV4MiniflareOptions === 'function' ? convertV4MiniflareOptions(options) : options)
try {
  const call = async (mode, scene = 'c2c') => {
    const response = await mf.dispatchFetch('https://smoke.test/?mode=' + mode + '&scene=' + scene)
    const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text)
  }
  assert.equal((await call('submit')).reply, null)
  // 每次请求重建插件实例；数据和任务仍由真实 D1 / KV 保留。
  await Promise.all([call('poll'), call('poll')])
  const done = await call('status'); assert.equal(done.sent.length, 1); assert.equal(done.sent[0].text, 'workerd自动回复中文😀\n来源：\n真实来源 https://source.test/'); assert.equal(done.sent[0].seq, 1)
  assert.equal(done.tasks[0].state, 'delivered')
  await call('submit', 'group'); await call('reset', 'group'); await call('poll', 'group')
  const reset = await call('status'); assert.equal(reset.sent.length, 1); assert.equal(reset.tasks.find(t => t.scene === 'group').state, 'cancelled')
  console.log('后台 workerd + D1 + KV：提交持久化、跨请求自动回复、并发幂等、reset取消四项通过，包括原生搜索请求与真实来源渲染（外部API为替身）')
} finally { await mf.dispose() }
