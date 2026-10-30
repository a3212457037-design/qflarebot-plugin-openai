# QFlareBot OpenAI 插件

适用于 QFlareBot v0.6.1（插件 API v4）的独立文本聊天插件，版本 **0.1.0**。复用 [Gemini 插件](https://github.com/a3212457037-design/qflarebot-plugin-gemini/tree/1f633234aa75b240dab3b86e7a6794fa7fa2174e) 已有的会话、限流、分段及后台投递实现；不修改 QFlareBot 核心，不迁移或读取 Gemini 的配置与历史。

## 功能

- QQ 私聊直接发送普通文字；群聊仅 @机器人时回复。跳过其他命令、附件及非文本事件。
- `/ai 问题`：保留命令用法。`/model` 查看、`/model 2` 或模型 ID 切换当前用户当前会话；`/model default` 跟随后台默认，切换保留上下文。Terra 可用 `/model 4` 或 `/model gpt-6.1-terra`。
- 最近 **6 轮完整问答**，最后一次成功后 **24 小时 TTL**；按机器人、私聊用户或群+用户隔离。`/reset` 只清除当前会话，并取消该会话旧任务，不清除 Key、模型偏好或其他用户数据。
- OpenAI 原生 `web_search`，没有 Tavily 或第三方搜索 API。开启时模型按需搜索，`/search 关键词` 强制搜索；仅展示实际返回的 URL 引用，过滤非 HTTP(S)、携带凭据或 Key 的链接，不输出推理、工具原文和内部元数据。
- 默认 OpenAI 后台推理，由每分钟 Cron 自动轮询并用原始 QQ `msg_id`、正确 `msg_seq` 自动回复，普通答案不需要 `/result` 或 `/more`。
- 无 500 字符/1500 字节的总正文裁剪；长文本按约 2000 UTF-8 字节分段。单条原消息的条数用完后，完整剩余正文保存 24 小时，`/more` 继续领取，不重新生成或搜索。

## 安装与配置

**同一机器人不要同时启用 Gemini 和本插件的普通聊天。** 两者的 `/ai`、`/model`、`/reset`、`/search`、`/more` 和普通文本匹配相同，会争用命令或重复回答。准备切换时，在面板停用 Gemini（保留其数据），再启用本插件；本仓库发布不会自动操作线上插件。

1. QFlareBot 面板「插件 → 添加插件 → 仓库链接」填写：
   `https://github.com/a3212457037-design/qflarebot-plugin-openai`
2. 构建安装完成后，在 OpenAI 插件设置填写 **OpenAI 官方 API Key** 并保存。Key 是 `writeOnly`，保存后不回显；不要通过 QQ 或 GitHub 提交密钥。不能把 Gemini Key 或 ChatGPT 登录信息当作 OpenAI API Key。
3. 保持推理执行模式 `background`，确认现有 Worker 已有 **D1、KV 和每分钟 Cron**。复用已有资源，插件通过 `ctx.db`、`ctx.kv` 自动建立自己的命名空间，不新增数据库、Durable Object、服务器或计费服务。
4. 私聊发送「你好」，再聊第二轮；发送「搜索今日科技新闻并附来源」核对原生搜索；`/model` 切换；`/reset` 清除本会话。
5. 高档推理和 Cron 会增加等待时间，可能超过一分钟。插件的「OpenAI 后台任务」页只展示安全状态，不展示 Key、用户标识、Response ID、问题或答案。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| 默认模型 | `gpt-6.1-terra` | 另外可选 `gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra`；权限由 OpenAI 项目决定，不自动换模型或重试生成 |
| 推理执行模式 | `background` | 后台推理 + Cron 自动回复；`responses` 为同步模式 |
| 推理档位 | `high` | 默认 Terra + high；四个内置模型均支持 high/max，可在后台降低档位 |
| 原生联网搜索 | 开启 | `tool_choice: auto`，模型按需使用；`/search` 为 `required`；每轮最多 3 次内置工具调用 |
| 生成 Token 上限 | `128000` | 四个内置模型官方上限，包含推理 Token；允许最大值，并非要求每次生成这么长 |
| 问题字符上限 | `1000` | Unicode 字符计数 |
| HTTP 超时 | `27000` 毫秒 | 同步模式最多 27 秒；后台提交与查询各最多 8 秒，远端推理可以继续 |
| 跳过的命令前缀 | `/` | 自定义全局前缀需在此同步，SDK 不提供读取全局前缀接口 |

**费用：** 使用自己的 OpenAI API 项目额度，模型 Token 和原生 Web Search 按官方规则计费；不会开启计费或更改账户预算。工具次数限制、冷却和本地任务保护均不是账户费用的绝对上限。没有使用或承诺 Tavily 免费额度。

## 后台任务与平台限制

- REST 端点固定为 `https://api.openai.com/v1/responses`，Key 仅在 Authorization 请求头；`redirect: manual`，3xx 不跟随，不把 Key 发往重定向目标。
- 后台请求使用 `background: true`、`store: true`。向 OpenAI 发送经过验证的最近 6 轮文本，不使用无限累加的 `previous_response_id`；同步模式 `store: false`。后台模式涉及 OpenAI 服务端存储，请按自己的数据要求选择模式。
- D1 保存任务、会话代次、原消息信息、状态、租约、投递进度；KV 保存上下文和待发正文。并发 Cron 通过原子认领及唯一约束避免重复提交/投递。`queued` 和 `in_progress` 继续等待。
- API/搜索失败不写入失败轮历史；错误日志仅固定分类及脱敏、限长的网络异常 name/message，不记录请求头、完整请求或原始响应。
- `/reset` 使旧任务失效，不能回复为新会话上下文；已经被 QQ 接收或正在发送的消息无法撤回。重置不会取消 OpenAI 服务端已经开始的推理，也不退款。
- 提交或 QQ 发送结果不确定时不盲目重发，需 `/reset` 后继续新问题。HTTP 投递与数据库无法组成同一事务，不声称跨平台绝对 exactly-once。手动 `/more` 可能重复发送结果不确定的最后一段。
- QQ 被动回复窗口：私聊原消息 60 分钟、群聊 5 分钟，截止前留 15 秒余量。过期不转成主动消息；私聊保守按 4 条、群聊按 5 条分段。本插件不能绕过 QQ 限制。
- 内存级 6 秒全局冷却、10 秒用户冷却和忙碌保护；isolate 重建/扩容会重置内存限流。持久化唯一约束负责同会话后台任务的并发保护。
- 首版使用 Cron 自动投递，没有要求用户另配 Webhook。实际账户模型权限、搜索可用性及 QQ 投递需在安装和保存自己 Key 后验证；本地替身测试不能证明真实 API 授权。

## 本地开发

Node.js 22+，在相邻 `QFlareBot/` 准备实际 v0.6.1 SDK/CLI（提交 `d143732abd6312e21f55edc2d3e6220563f06be8`），沿用官方模板的本地 `file:` 开发依赖：

```powershell
git clone https://github.com/a3212457037-design/QFlareBot.git QFlareBot
git -C QFlareBot checkout d143732abd6312e21f55edc2d3e6220563f06be8
npx.cmd --yes pnpm@10.34.5 --dir QFlareBot install --filter "@qqbot/plugin-cli..." --frozen-lockfile
npm.cmd --prefix QFlareBot/packages/sdk run build
npm.cmd --prefix QFlareBot/packages/plugin-cli run build
```

在本插件目录执行：

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd test
npm.cmd run sync
npm.cmd run check:manifest
npm.cmd run test:workers
npm.cmd run test:install
```

无运行时第三方依赖，线上安装由官方构建机注入 SDK；`node_modules`、`.env`、本地密钥和 `dist` 不提交到仓库。构建会生成 `dist/plugin.js`，根 `manifest.json` 与源码同步。

## 官方接口依据与验证

- [Responses API](https://developers.openai.com/api/reference/python/resources/responses/methods/create)
- [后台执行](https://developers.openai.com/api/docs/guides/background)
- [原生 Web Search 与 URL 引用](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)

具体检查结果和真实环境边界见 [VERIFICATION.md](VERIFICATION.md)。代码与复用来源按 MIT 许可发布，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
