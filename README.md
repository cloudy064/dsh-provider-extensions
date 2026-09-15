# DSH Provider Extensions

为 DeepSeek Harness 扩展模型提供方，当前支持 `cline-pass` 和 `commandcode`。

包名为 `dsh-provider-extensions`（原 `dsh-plugin-cline-pass`）。从旧包升级时先卸载旧安装项再安装新包，避免重复注册 Provider。为兼容已有配置，内部设置命名空间仍保留 `llm-cline-pass`，配置和密钥无需迁移。

## Command Code

从 0.6.0 起也提供 `commandcode`，与 `cline-pass` 共用原生 Models 配置界面、字母排序及增删流程。API 密钥存于独立的 `COMMANDCODE_API_KEY` 引用，模型可在“自定义设置 → 获取可用模型”中查询和选择。

配置存于 `llm-cline-pass.commandcode`，使用官方 Provider API。Claude 模型自动使用 Anthropic Messages，其他模型使用 OpenAI Chat Completions；复用宿主 PiAiAdapter 的流式、工具调用和历史转换。该版本只声明文本输入，不新增视觉或推理强度选项。不把 ClinePass 的实验性上游路由参数发给 Command Code。

已有 `llm-pi-ai.providers.commandcode` 可在停止 DSH 后运行 `node scripts/migrate-commandcode.mjs` 迁移。脚本备份 settings.yaml，保留模型和密钥引用，移除旧配置以避免同名路由冲突；遇到自定义连接字段会停止而不会丢弃字段。密钥本身不读取、不复制。

参考：[官方 Provider API](https://commandcode.ai/docs/provider)及[协议分流说明](https://commandcode.ai/blog/command-code-provider-api)。模型目录为公开接口，不能证明账号额度或模型访问权限。测试使用本地模拟服务，没有发送真实推理请求。

为 DeepSeek Harness 添加 ClinePass 订阅模型。已针对本机 npm 安装的 `@deepseek-ai/dsh 0.1.5-rc.1` 开发。

**订阅推理与上游固定尚未进行真实账户验证。** `sticky` 和 `experimental-pin` 发送路由参数，不代表 ClinePass 服务端一定执行。此版本不会显示“锁定成功”，也不会自动改走其他账号、模型或按量计费路由。

## 安装

在此项目目录执行：

```powershell
npm ci --ignore-scripts
npm test
npm run smoke
node scripts/install-models-compat.mjs
npm pack
dsh plugin --profile web add ./dsh-provider-extensions-0.6.1.tgz
```

安装命令会修改 DSH 的 web profile。安装后重启 DSH。当前 DSH 0.1.5-rc.1 的 Models 编辑器没有替换接口，兼容脚本为它补充 `settings.models.provider-editor` 插槽，仅接管本插件表单；提供方目录、添加、折叠和删除仍由宿主管理。脚本检查版本与源码结构，原文件备份为 `client.js.cline-pass-original`；宿主升级后需要重新核对兼容性。发布包包含编译结果；请安装 tgz，勿直接链接开发目录。

通过 Git 插件管理器安装时，构建步骤不会自动运行宿主兼容脚本。添加列表的字母排序和自定义编辑表单都由该脚本提供；安装后需执行一次，支持 Models `0.1.5-rc.1` / `0.1.5-rc.2`，宿主升级后需重新应用。Linux 默认 web 配置可运行：

```sh
node ~/.dsh/profiles/web/node_modules/dsh-provider-extensions/scripts/install-models-compat.mjs
```

自定义配置可把 Profile 目录作为参数传入；脚本从该目录解析宿主模块，校验源码结构后才修改，并保留原文件备份。应用后刷新 Harness 页面。

在 Models 的添加提供方下拉菜单中选择 **cline-pass**，填写 Cline API Key。密钥保存到宿主凭据存储，无需设置环境变量；也兼容启动环境中的 `CLINEPASS_API_KEY`。账号需有有效订阅。本版不包含 OAuth 登录。

卸载：`dsh plugin --profile web remove dsh-provider-extensions`，然后重启 DSH。

已有 `llm-pi-ai.providers.commandcode` 自定义配置时，插件保留原生配置入口和路由，不再用自己的同名条目遮蔽它。旧版宿主缺少自定义目录条目时，补充指向原配置的条目；不迁移或改写配置和密钥。

## 配置

推荐使用 **设置 → 模型（Models）→ 添加提供方 → cline-pass**，通过 GUI 配置：

安装后不会自动创建 provider。通过宿主的 Provider 下拉菜单选择 `cline-pass`，填写密钥和模型后点击 **应用**。取消不保存配置或密钥。已有配置默认收起，使用宿主的 **编辑** 和 **删除**；删除移除 profile 及模型路由，凭据处理以宿主确认框为准。默认 `CLINEPASS_API_KEY` 为独立引用，会保留以便重新添加。

- **API Key**：密码输入框，留空保留已有密钥，点击应用保存。
- **自定义设置 → 获取可用模型**：复用宿主模型选择弹窗，支持搜索、勾选和添加所选。查询公开目录，不写入密钥、不校验订阅权益、不消耗推理额度。中文界面点击“保存”，英文界面点击“Apply”提交。
- **自定义设置 → 路由策略**：默认折叠；选择默认路由、会话黏性或实验性单上游限制；选后者时出现上游标识输入框。
- **模型列表**：默认自动读取官方目录；可添加/删除模型，并编辑名称、上下文容量及输出上限。
- **应用 / 取消 / 恢复默认配置**：编辑暂存到点击应用；恢复默认只更新草稿，不删除 API Key。
- **超时和诊断**：数字输入框与开关，保存后对后续请求生效。

文件示例 [examples/settings.yaml](examples/settings.yaml) 仅供高级用法；设置命名空间为 `llm-cline-pass`，可选提供方存于 `profile`，下表字段均位于其中。旧版顶层配置仍供适配器兼容，GUI 使用 profile 地址。模型 provider ID 为 `cline-pass`。

| 配置 | 默认值 | 行为 |
| --- | --- | --- |
| `apiKeyEnv` | `CLINEPASS_API_KEY` | DSH 凭据引用，逐次请求读取 |
| `models` | `[]` | 从官方 recommended-models 接口的 clinePass 字段读取；也可手动配置模型及上下文/输出限制 |
| `routing` | `sticky` | `default` 不加路由字段；`sticky` 发送稳定会话 ID；`experimental-pin` 额外发送单上游限制 |
| `upstream` | 未设置 | experimental-pin 必填，使用实际上游 slug |
| `timeoutMs` | `300000` | 单次 HTTP 请求的总时限，包含流式读取 |
| `diagnostics` | `false` | 输出 token 统计、耗时、请求哈希和路由观察值 |

所有模型 ID 必须使用 `cline-pass/` 前缀；拒绝普通模型 ID。目录获取失败会明确报错，可配置手动列表；不会混入免费或按量计费模型。目录是公开推荐列表，不能证明当前账号的订阅权益。

模型目录不含可核验的数值上下文限制，因此插件不从描述文字推测它。需要控制压缩阈值/输出上限时，使用 `models[].contextWindow` 和 `models[].maxTokens`。当前支持文本、工具调用与思考内容，不声明视觉支持；未由 DSH 转成文本的图片/文件块会明确拒绝。

设置对后续调用生效；已准备的调用保留其配置快照。会话标识从 DSH sessionId 确定性生成，重试保持一致；标题和压缩请求使用各自的标识。没有 sessionId 时不伪造全局共用标识。

`experimental-pin` 的请求字段为：

```json
{"provider":{"only":["EXACT_UPSTREAM_SLUG"],"allow_fallbacks":false}}
```

这是实验性约束请求。插件无法在不开放上游控制的服务端上强制固定，也无法阻止服务端内部切换实例。明确的服务端失败会报错，不会删除限制后偷偷重试。仅 429 和 HTTP 5xx 交给 DSH 以最多两次的策略重试；中途断流不自动重放。

## 验证

```powershell
npm test
npm run smoke
```

单元与集成测试使用模拟响应，无密钥、无网络、无订阅消耗。smoke 从本机 npm 安装位置加载真正的 Cordis/DSH 服务，验证 bundle 合成、插件挂载、模型枚举和卸载，不启动或修改用户 profile。非标准安装可使用：

```powershell
npm run smoke -- C:\path\to\node_modules\@deepseek-ai\dsh
```

公开目录验证（联网但不使用密钥或额度）：

```powershell
npm run probe -- --catalog
```

以后配置好本地环境变量 `CLINEPASS_API_KEY` 后，可运行真实订阅测试：

```powershell
npm run probe -- --live --model cline-pass/deepseek-v4-flash
npm run probe -- --live --model cline-pass/deepseek-v4-flash --upstream EXACT_UPSTREAM_SLUG
```

不传 `--live` 不会发送推理请求。默认对照最多 5 次；指定上游时最多 7 次，均消耗订阅额度。发送固定的合成文本，不读取项目内容。测试默认路由两次、黏性路由两次、指定上游两次（如配置），最后使用不存在的上游做负对照。遇到认证、订阅或限流错误提前停止。

结果写入 gitignored `reports/`。不存在的上游仍成功，说明请求的 allowlist 未被强制执行；失败本身也不足以证明锁定成功。必须结合默认请求成功、服务端明确提供的上游标识和重复实验判断。`observedUpstream` 只记录返回的 `provider` 字段，不用模型名或 system_fingerprint 猜测上游；`routingVerified` 始终为 false。

缓存命中用 DSH 的 `cacheReadTokens` 展示，`inputTokens` 已扣除缓存读取，避免重复统计；服务端没给缓存计数就保留未知。诊断还包括首 token 延迟、总耗时以及消息/工具定义的 SHA-256 哈希，不保存密钥、提示词、生成文本或原始错误体。多轮消息哈希变化是正常现象，不能单凭它判断前缀缓存失效。

## 实现与参考

- 原生 `LlmAdapter`，通过 `ctx.llm.registerAdapter()` 挂载，使用宿主凭据和设置服务。
- 流式处理 UTF-8/SSE 分片、交错工具调用、取消、错误和终止标记；保存 reasoning_details 的 replay envelope。
- [Cline API 文档](https://github.com/cline/cline/blob/main/docs/api/chat-completions.mdx)
- [Cline 公开模型目录](https://api.cline.bot/api/v1/ai/cline/recommended-models)
- [DSH 订阅插件参考](https://github.com/V1ki/dsh-plugin-subscriptions)
- [DSH 官方：Models 扩展接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-models/README.md)：通过 `registerConfigurableProviders` 注册候选项，兼容补丁提供专用表单插槽，`settingsScope` 保存配置，`llm.discoverModels` 获取模型目录。
- [OpenRouter 路由参数](https://openrouter.ai/docs/guides/routing/provider-selection)与[会话黏性](https://openrouter.ai/docs/guides/best-practices/prompt-caching)：仅作候选协议参考，不是 ClinePass 能力承诺。
