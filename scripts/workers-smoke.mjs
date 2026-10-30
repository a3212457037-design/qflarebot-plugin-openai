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
 const config={apiKey:'local-fake-background-key',model:'gpt-6.1-terra',executionMode:'background',reasoningEffort:'high',enableWebSearch:true,maxInputChars:1000,maxOutputTokens:65536,timeoutMs:27000,ignoredCommandPrefixes:['/']};
 const webhook=url.searchParams.get('transport')==='webhook'; if(webhook){config.backgroundDelivery='webhook';config.webhookSecret='whsec_'+btoa('local-smoke-signing-key-32-bytes!!');config.useAiGateway=true;config.aiGatewayUrl='https://gateway.ai.cloudflare.com/v1/'+'a'.repeat(32)+'/local-test/openai';config.aiGatewayToken='local-gateway-token';}
 const responseId='resp_'+(webhook?'webhook_':'')+scene; const jobs=[];
 const db=createScopedDB(env.DB,'openai');const kv=createScopedKV(env.KV,'openai');
 const fetcher=async(input,init)=>{
  if(!String(input).startsWith(config.useAiGateway?config.aiGatewayUrl+'/responses':'https://api.openai.com/v1/responses'))throw new Error('unexpected host');
  if(init.redirect!=='manual'||init.headers.authorization!=='Bearer '+config.apiKey)throw new Error('unsafe request');
  if(config.useAiGateway&&(init.headers['cf-aig-authorization']!=='Bearer '+config.aiGatewayToken||init.headers['cf-aig-collect-log']!=='false'||init.headers['cf-aig-skip-cache']!=='true'||init.headers['cf-aig-max-attempts']!=='1'))throw new Error('unsafe gateway headers');
  if(init.method==='POST'){
   const body=JSON.parse(init.body);if(!body.background||!body.store||body.reasoning.effort!=='high'||body.tools[0].type!=='web_search')throw new Error('invalid native request');
   return Response.json({id:responseId,status:'queued'});
  }
  return Response.json({id:responseId,status:'completed',output:[{type:'reasoning',summary:[{type:'summary_text',text:'never send'}]},
   {type:'web_search_call',status:'completed'},{type:'message',role:'assistant',content:[{type:'output_text',text:'workerd自动回复中文😀',annotations:[{type:'url_citation',url:'https://source.test/',title:'真实来源'}]}]}]});
 };
 const plugin=createOpenAIPlugin(fetcher);
 const ctx={config,db,kv,botId:'bot',logger:{warn(){}},waitUntil:p=>jobs.push(p),api:{async sendMessage(target,text,options){
  await db.run('INSERT INTO {smoke_sent}(scene,text,seq) VALUES (?,?,?)',target.scene,text,options.msgSeq);return {ok:true,status:200,raw:{}};
 }}};
 await db.exec('CREATE TABLE IF NOT EXISTS {smoke_sent}(scene TEXT,text TEXT,seq INTEGER)');
 const session={botId:'bot',userId:webhook?'webhook-user':'u',scene,targetId:webhook?'webhook-user':scene==='group'?'g':'u',messageId:(webhook?'webhook-m-':'m-')+scene,timestamp:Date.now(),event:scene==='group'?'qq.group.at_message':'qq.c2c.message',content:'你好',atMe:true,attachments:[],canReply:true};
 if(mode==='submit'){
  // 先跑管理页GET，确保在真实D1中幂等建表；这里只注入已核验标记，绝不调用外网。
  const route=plugin.routes.find(r=>r.path==='/api/status');await route.handler({ctx,request,params:{},authenticated:true});
  const reply=await plugin.regex[0].handler({ctx,session,match:['你']});return Response.json({reply:reply??null,tasks:await db.all('SELECT state,interaction FROM {async_tasks}')});
 }
 if(mode==='callback'){
  const id='wh_smoke'; const timestamp=String(Math.floor(Date.now()/1000)); const body=JSON.stringify({type:'response.completed',data:{id:responseId}});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('local-smoke-signing-key-32-bytes!!'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(id+'.'+timestamp+'.'+body));
  const signature=btoa(String.fromCharCode(...new Uint8Array(sig)));
  const callback=new Request('https://bot.test/p/openai/callback',{method:'POST',body,headers:{'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+signature}});
  const r=await plugin.routes.find(r=>r.path==='/callback').handler({ctx,request:callback,params:{},authenticated:false});
  if(r.status!==204)throw new Error('callback failed');await Promise.all(jobs);
 }
 if(mode==='reset') await plugin.commands.reset.handler({ctx,session,argText:''});
 if(mode==='poll') await plugin.cron.background.handler({ctx,job:'background',scheduledAt:Date.now()});
 return Response.json({sent:await db.all('SELECT * FROM {smoke_sent}'),tasks:await db.all('SELECT state,scene,seq FROM {async_tasks}')});
}};` }, write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' })
const options = { modules: true, script: outputFiles[0].text, compatibilityDate: '2026-09-01', d1Databases: { DB: 'smoke' }, kvNamespaces: ['KV'] }
const mf = new Miniflare(typeof convertV4MiniflareOptions === 'function' ? convertV4MiniflareOptions(options) : options)
try {
  const call = async (mode, scene = 'c2c', transport = 'cron') => {
    const response = await mf.dispatchFetch('https://smoke.test/?mode=' + mode + '&scene=' + scene + '&transport=' + transport)
    const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text)
  }
  assert.equal((await call('submit')).reply, null)
  // 每次请求重建插件实例；数据和任务仍由真实 D1 / KV 保留。
  await Promise.all([call('poll'), call('poll')])
  const done = await call('status'); assert.equal(done.sent.length, 1); assert.equal(done.sent[0].text, 'workerd自动回复中文😀\n来源：\n真实来源 https://source.test/'); assert.equal(done.sent[0].seq, 1)
  assert.equal(done.tasks[0].state, 'delivered')
  await call('submit', 'group'); await call('reset', 'group'); await call('poll', 'group')
  const reset = await call('status'); assert.equal(reset.sent.length, 1); assert.equal(reset.tasks.find(t => t.scene === 'group').state, 'cancelled')
  await call('submit','c2c','webhook'); await call('poll','c2c','webhook');
  assert.equal((await call('status')).sent.length,1);
  await Promise.all([call('callback','c2c','webhook'),call('callback','c2c','webhook')]);
  const notified=await call('status');assert.equal(notified.sent.length,2);assert.equal(notified.tasks.filter(t=>t.state==='delivered').length,2);
  console.log('Webhook workerd：真实HMAC验签、D1通知持久化、免Cron远端轮询、重复通知仅投递一次、Gateway传输与隐私头通过');
  console.log('后台 workerd + D1 + KV：提交持久化、跨请求自动回复、并发幂等、reset取消四项通过，包括原生搜索请求与真实来源渲染（外部API为替身）')
} finally { await mf.dispose() }
