# 复用来源与许可

本插件按 MIT 发布，保留本仓库 LICENSE 和 licenses 中的上游许可。

- 复用 [a3212457037-design/qflarebot-plugin-gemini](https://github.com/a3212457037-design/qflarebot-plugin-gemini/tree/1f633234aa75b240dab3b86e7a6794fa7fa2174e) 的 SDK 聊天入口、KV 六轮历史、分段投递、会话模型偏好、D1 后台任务状态机及相应测试/脚本。新编写 OpenAI Responses REST 适配、原生 Web Search 引用解析、配置与文档；未复制 Tavily 客户端或 Gemini 协议客户端。
- 官方模板和 SDK 契约依据 QFlareBot v0.6.1，提交 `d143732abd6312e21f55edc2d3e6220563f06be8`。模板/SDK MIT 许可见 `licenses/QFlareBot-template-MIT.txt`。框架运行时代码只在本地开发测试中导入，不打包到插件。
- 原 Gemini 插件部分网络安全辅助逻辑曾由 `clown145/qflarebot-plugin-llm`（提交 `94f0f1f444b5980eb738d77492760ab412855682`，MIT）改编，继续保留其版权与 `licenses/qflarebot-plugin-llm-MIT.txt`。
- 开发工具只用于构建测试，没有运行时第三方依赖。官方 OpenAI REST 接口为本次适配依据，不包含或移植 OpenAI SDK 实现。
