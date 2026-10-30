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
