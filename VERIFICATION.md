## 可选 AI Gateway 传输（2026-10-30）

- 123/123 测试通过：新增 18 项覆盖开关、旧配置、严格官方域名与路径、POST/GET、凭证不发到直连端点、3xx不跟随、无自动重试/回退、HTTP错误、超时、三密钥脱敏。
- 类型检查、官方构建、manifest 一致性通过；真实本地 workerd/D1/KV/HMAC 冒烟同时覆盖签名通知通过网关取结果、隐私头与一次投递（外部 OpenAI、Cloudflare Gateway、QQ 为替身）。
- 新增 writeOnly 网关令牌与可选传输配置，保留模型、high、请求参数、Webhooks、Cron、六轮上下文和聊天行为；版本仍 0.1.0。
- 用户账户验证网关已创建，日志、缓存、自动重试关闭、认证开启；真实网关和 QQ 测试尚待管理员保存 Run Token 后完成。以上本地结果不代表地区限制已解决。

## Webhook 最小实现（2026-10-30）

- **最新真实 QQ 验收失败**：用户创建项目端点并自行保存签名密钥后，普通 QQ 消息的初始 POST 返回 `403 REGION_UNSUPPORTED`（安全诊断时间 1793353913643）；任务 failed/auth，lastVerifiedWebhookAt 仍为 null，未进入结果回调。已立即恢复 Gemini、停用 OpenAI，保留两者数据和配置，停止后续改造。不能以之前的模拟提交成功声明线上可用，也不能认定已保证受支持出口地区。
- 用户自行更换正确的 API Key 后，在现有 Worker 上模拟 `/ai 只回复 OK，不联网。`：后台任务已进入 pending，interaction ID 已保存，error 为 null。该次未复现 401/403；旧 lastApiError 的 401 时间早于本次任务，不能误当作新失败。模拟会话随后单独 reset，Gemini 已恢复、OpenAI 停用，真实会话与配置保留。
- 105 项单元/回归测试通过（其中通知相关 16 项），类型检查、官方构建、manifest 一致性、本地真实 workerd/D1/KV 冒烟通过。新增 Web Crypto 签名、持久化通知、免远端 Cron 轮询、重复通知单次投递；保留原四项后台冒烟。
- Webhook 模式仅处理签名验证后持久化的通知；Cron 只恢复收件箱。旧配置仍是 cron 模式。模型、原生搜索、六轮上下文、reset、more、长度、限流保持。
- 无新增依赖、数据库、服务器或计费服务，版本仍 0.1.0。API Key 与新增签名密钥均保护，不记录原始通知、请求或响应。
- 用户已确认创建项目端点并保存签名密钥；尚未通过真实 OpenAI 签名回调及 QQ Webhook 自动回复。成功模拟提交只证明那一次后台创建可用，不代表结果获取/模型答案/QQ投递通过，也不证明出口地区固定。未修改共用 Worker Placement。

## HTTP 403 安全诊断（2026-10-30）

- 真实 QQ 首次调用在提交阶段返回 HTTP 403；原 `AUTH` 分类不足以确认具体原因，不认定为 Key 错误或额度不足。
- 补充固定白名单原因：地区、IP、Key、权限、模型访问、组织核验和项目/组织访问。禁止保存或输出原始 error.message/code/details。
- 管理员后台任务页新增最近一次 API 失败的 HTTP 状态、固定 reason、时间；不包含密钥、提供商原始响应、用户或问题。
- 89/89 测试、类型检查、构建、manifest 与本地 workerd/D1/KV 冒烟通过；QQ 中文提示、Terra + high、后台及原生搜索保持不变。

## Terra + high 更新（2026-10-30）

- 增加官方 `gpt-6.1-terra`，默认模型与档位改为 Terra + high。/model 4 与完整 ID 均可选；原序号 1/2/3 保持不变。
- 已核对官方模型页面：支持 Responses API、high、原生 Web Search，输出上限 128000。
- 80/80 测试通过；类型检查、构建、manifest 一致性和真实本地 workerd/D1/KV 冒烟通过；新增 Terra 请求与序号回归。
- 尚未验证用户项目对 Terra 的真实 API 权限。此前 0.1.0 已安装，Gemini 已停用并保留数据；此记录保留首版验证结果如下。

# OpenAI 插件验证记录

日期：2026-10-30；版本：0.1.0；QFlareBot v0.6.1 / API v4。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 78/78：官方 Responses 请求/错误/引用 24；持久化后台与SDK聊天 20；历史回归 17；长文本投递回归 17 |
| `npm run sync` | 通过，官方 CLI 构建，插件名 openai，版本 0.1.0 |
| `npm run check:manifest` | 通过，根清单与构建一致 |
| `npm run test:workers` | 本地真实 workerd + D1 + KV：持久化、跨请求自动回复、并发幂等、reset 取消；同时校验官方原生搜索请求及真实引用渲染，外部 OpenAI/QQ 为本地替身 |
| `npm run test:install` | 官方无 node_modules 隔离安装构建通过，58738 字节，无第三方运行依赖，清单一致 |

覆盖默认后台、三个模型、max 推理、原生 auto/required 搜索和关闭开关、API 错误/额度/超时、manual 重定向、Key 请求/回答/日志脱敏、长中文分段、普通文本与命令过滤、queued/in_progress、Cron 租约与唯一约束、未知发送结果不自动重试、reset 竞态、60/5 分钟窗口、六轮历史及 TTL、用户/群/机器人隔离。

已核对官方 SDK 的插件独立 KV/D1 命名空间与 TTL 秒语义、消息事件/群 atMe、命令阻断优先级及现有后台投递路径。复用来源为 Gemini 插件 `1f633234aa75b240dab3b86e7a6794fa7fa2174e`，没有修改原仓库、QFlareBot 核心、sid、T2I 或线上配置。

尚未实际验证：用户 OpenAI Key 对三个模型的真实授权、项目额度及原生搜索权限、Cloudflare 边缘连接 OpenAI、真实 QQ 收取 OpenAI 自动回复。没有读取任何真实 Key，没有发起真实付费 OpenAI 推理/搜索，没有部署或替换线上 Gemini。实际安装后由管理员填写自己的 Key 并进行少量真实 QQ 验证。

开发依赖沿用现有构建工具；安装输出曾提示开发依赖的 3 项漏洞，未擅自更新官方工具链。`npm audit --omit=dev` 为 0，插件无第三方运行依赖，开发工具不进入产物。
