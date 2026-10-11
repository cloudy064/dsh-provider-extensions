# DSH Provider Extensions

为 DeepSeek Harness 扩展模型提供方，当前支持 `cline-pass` 和 `commandcode`。

包名为 `dsh-provider-extensions`（原 `dsh-plugin-cline-pass`）。从旧包升级时先卸载旧安装项再安装新包，避免重复注册 Provider。为兼容已有配置，内部设置命名空间仍保留 `llm-cline-pass`，配置和密钥无需迁移。

## 适用 DSH 版本

本版本（0.7.0）适用于 **DSH `0.2.0-rc.2`**，`peerDependencies` 已按该版本声明。

DSH `0.2.0` 重写了设置与 Models 页的插件接口：宿主端设置接入由 `installSection` 改为 `SettingsForms.configure`，Models 页给外部插件的座位由补丁出来的 `settings.models.provider-editor` 改为按 `settingsNs` 键入的 `settings.models.provider-card`。0.7.0 已完成适配：

- 宿主端只使用 0.2.0 的接入方式（`ctx.inject(['settings'], …)` + `configure({ auto: false }, ctx.fiber)`，设置命名空间取 profile entry id）。
- 配置表单由插件自己的 `Config` schema 提供，需要实时更新的字段用 volatile schema 声明，写入后由 Loader 直接提交进运行中的配置引用。
- 客户端卡片自带样式与文案，注册进 `settings.models.provider-card`，不再依赖宿主 Models 页的内部组件或插槽补丁。

**使用 DSH `0.1.5-rc.1` / `0.1.5-rc.2` 的用户请停留在 0.6.1。** 0.7.0 不再声明也不再验证 0.1.5 支持。仓库里的 `scripts/install-models-compat.mjs` 只对 0.1.5-rc.1/rc.2 生效，0.2.0 上无法运行（宿主已在 `app.asar` 内）也不再需要；它已不再随包发布。

## Command Code

从 0.6.0 起也提供 `commandcode`，与 `cline-pass` 共用 Models 页的提供方行、添加/删除流程与本插件的编辑卡片。API 密钥存于独立的 `COMMANDCODE_API_KEY` 引用，模型可在卡片的 **获取可用模型** 中查询和选择。

配置存于 `llm-cline-pass.commandcode`，使用官方 Provider API。Claude 模型自动使用 Anthropic Messages，其他模型使用 OpenAI Chat Completions；复用宿主 PiAiAdapter 的流式、工具调用和历史转换。该版本只声明文本输入，不新增视觉或推理强度选项。不把 ClinePass 的实验性上游路由参数发给 Command Code。

已有 `llm-pi-ai.providers.commandcode` 可在停止 DSH 后运行 `node scripts/migrate-commandcode.mjs` 迁移。脚本备份 settings.yaml，保留模型和密钥引用，移除旧配置以避免同名路由冲突；遇到自定义连接字段会停止而不会丢弃字段。密钥本身不读取、不复制。

参考：[官方 Provider API](https://commandcode.ai/docs/provider)及[协议分流说明](https://commandcode.ai/blog/command-code-provider-api)。模型目录为公开接口，不能证明账号额度或模型访问权限。测试使用本地模拟服务，没有发送真实推理请求。

为 DeepSeek Harness 添加 ClinePass 订阅模型。已针对 `@deepseek-ai/dsh 0.2.0-rc.2` 开发并在真实宿主上验证挂载与设置表单。

**订阅推理与上游固定尚未进行真实账户验证。** `sticky` 和 `experimental-pin` 发送路由参数，不代表 ClinePass 服务端一定执行。此版本不会显示“锁定成功”，也不会自动改走其他账号、模型或按量计费路由。

## 安装

在此项目目录执行：

```powershell
npm ci --ignore-scripts
npm test
npm run smoke
npm pack
dsh plugin --profile web add ./dsh-provider-extensions-0.7.0.tgz
```

安装命令会修改 DSH 的 web profile。安装后重启 DSH。0.2.0 的 Models 页已为仓库外插件声明 `settings.models.provider-card` 座位，本插件的卡片直接注册进该座位，**不需要任何宿主补丁**；提供方目录、添加、折叠和删除仍由宿主管理。发布包包含编译结果；请安装 tgz，勿直接链接开发目录。

在 Models 的添加提供方下拉菜单中选择 **cline-pass**，填写 Cline API Key。密钥保存到宿主凭据存储，无需设置环境变量；也兼容启动环境中的 `CLINEPASS_API_KEY`。账号需有有效订阅。本版不包含 OAuth 登录。

卸载：`dsh plugin --profile web remove dsh-provider-extensions`，然后重启 DSH。

已有 `llm-pi-ai.providers.commandcode` 自定义配置时，插件保留原生配置入口和路由，不再用自己的同名条目遮蔽它。0.2.0 上宿主的 pi-ai 目录本身就会列出该自定义路由，插件据此放弃 `commandcode` 路由的注册，不迁移或改写配置和密钥。

## 配置

推荐使用 **设置 → 模型（Models）→ 添加提供方 → cline-pass**，通过 GUI 配置：

安装后不会自动创建 provider。通过宿主的 Provider 下拉菜单选择 `cline-pass`，填写密钥和模型后点击 **应用**。取消不保存配置或密钥。已有配置默认收起，使用宿主的 **编辑** 和 **删除**；删除移除 profile 及模型路由，凭据处理以宿主确认框为准。默认 `CLINEPASS_API_KEY` 为独立引用，会保留以便重新添加。

本版本的卡片由插件自己渲染（自带样式与中英文文案），不再复用宿主 Models 编辑器的内部组件，因此字段布局与 0.6.1 略有不同；字段本身与语义保持一致：

- **API 密钥**：密码输入框，留空保留已有密钥，点击 **应用** 后写入凭据存储。
- **模型列表**：可直接添加/删除行，并编辑模型 ID、显示名称、上下文容量与输出上限。
- **获取可用模型**：向宿主已注册的模型发现接口查询公开目录，返回可勾选列表（支持搜索、全选/取消全选），选中后写入草稿，已有行的自定义值保留；不写入密钥、不校验订阅权益、不消耗推理额度。
- **路由策略**：默认路由、会话黏性或实验性单上游限制；选后者时出现上游标识输入框。
- **请求超时 / 诊断日志**：数字输入框与开关，保存后对后续请求生效。
- **应用 / 取消 / 恢复默认设置**：编辑暂存到点击应用；恢复默认只更新草稿，不删除已保存的 API 密钥。

文件示例 [examples/settings.yaml](examples/settings.yaml) 是 0.1.5 时代的 `settings.yaml` 片段，仅供旧版参考。0.2.0 的设置存储在 profile 的 `cordis.patch.yml`，命名空间为 profile entry id `llm-cline-pass`，可选提供方存于 `profile`（commandcode 存于 `commandcode`），下表字段均位于其中。旧版顶层配置仍供适配器兼容，GUI 使用 profile 地址。模型 provider ID 为 `cline-pass`。

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
npm run test:mount
npm run smoke
```

单元与集成测试使用模拟响应，无密钥、无网络、无订阅消耗。

`npm run test:mount` 是真实的 0.2.0 挂载测试：它从一份解出来的 `@deepseek-ai/dsh 0.2.0-rc.2` 运行时（`host-runtime`）启动一个临时 profile，把本插件的构建产物作为 profile entry 插入，然后断言插件激活、两条目录条目指向自己的设置命名空间、`commandcode` 默认休眠、设置表单已发布且接受写入、卸载后全部撤销。运行时不存在时该测试自行跳过，不影响 `npm test`；准备方式见 [VALIDATION.md](VALIDATION.md)。

smoke 从本机 npm 安装位置加载真正的 Cordis/DSH 服务，验证 bundle 合成、插件挂载、模型枚举和卸载，不启动或修改用户 profile。非标准安装可使用：

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
- 0.2.0 设置接入：`ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))`；设置命名空间取 `ctx.fiber.entry.options.id`；需要实时更新的配置字段在 `Config` schema 上声明为 volatile，写入由 Loader 提交进运行中的配置引用（`src/config.ts`、`src/index.ts`）。
- 浏览器端通过 `ctx.configForms.get(ns)` 取得设置表单句柄（`subscribe`/`getSnapshot`/`mutate`），通过 `ctx.remote.credentials` 读写密钥，通过 `ctx.remote.llm.discoverModels(ns, request)` 获取模型目录；卡片注册进 `settings.models.provider-card`，key 为 `llm-cline-pass`（`src/client.js`）。
- 流式处理 UTF-8/SSE 分片、交错工具调用、取消、错误和终止标记；保存 reasoning_details 的 replay envelope。
- [Cline API 文档](https://github.com/cline/cline/blob/main/docs/api/chat-completions.mdx)
- [Cline 公开模型目录](https://api.cline.bot/api/v1/ai/cline/recommended-models)
- [DSH 订阅插件参考](https://github.com/V1ki/dsh-plugin-subscriptions)
- [DSH 官方：Models 扩展接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-models/README.md)：通过 `registerConfigurableProviders` 注册候选项，`settings.models.provider-card` 座位渲染适配器卡片，`settings.mutate` 写入表单，`llm.discoverModels` 获取模型目录。
- [OpenRouter 路由参数](https://openrouter.ai/docs/guides/routing/provider-selection)与[会话黏性](https://openrouter.ai/docs/guides/best-practices/prompt-caching)：仅作候选协议参考，不是 ClinePass 能力承诺。
