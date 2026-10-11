# 验证记录

## 0.6.1 适用版本标记

日期：2026-10-11。

- `peerDependencies` 由精确 `0.1.5-rc.1` 放宽为 `0.1.5-rc.1 || 0.1.5-rc.2`，两个版本都能通过宿主的安装与 profile 启动兼容检查；README 顶部新增“适用 DSH 版本”一节。
- 本地 `npm test`：23 项通过，0 失败（全部使用模拟响应，无网络、无密钥）。
- 与 DSH `0.2.0-rc.2` 的差异已核对，确认本版本尚未适配：宿主端整个 0.2.0 包树中不再存在 `settings.installSection`（设置接入改为 `SettingsForms.configure`），Models 页给外部插件的座位为 `settings.models.provider-card`（按 `settingsNs` 键入），而本版本的 `settings.models.provider-editor` 兼容补丁仅在 `0.1.5-rc.1`/`0.1.5-rc.2` 上生效且宿主已移入 `app.asar`。在 0.2.0 上安装需要版本豁免，设置区与自定义配置表单不会生效。

## 0.4.0 可选 provider 生命周期

- 安装插件不再强制注册 ClinePass 路由。Models 页提供“添加 ClinePass”入口，添加后才创建配置并注册模型路由。
- 配置行默认收起，点击编辑展开；删除确认后清除 provider 配置并撤销模型路由，保留凭据供重新添加时使用。
- 18 项测试通过，包括未配置、启用、停用的原生路由注册测试。
- 真实 Chrome 验证：默认不存在、添加、收起、刷新后仍收起、编辑、取消删除、确认删除、刷新后重新添加均通过。最终恢复到未添加状态，未写入密钥。
- 已安装 0.4.0 并重启本机 DSH web（18089）。截图：`.cache/gui-collapsed.png`。

## 0.3.0 Models provider 更新

- 配置入口调整为“设置 → 模型 → ClinePass”，注册原生 provider、模型发现接口及 `settings.models.provider-card` 卡片。
- 主流程为 API Key → 获取模型列表 → 勾选并保存；其他参数放入默认折叠的高级配置。
- 后端 17 项测试通过；真实 Chrome 验证 Models 卡片、公开目录获取、全选/取消全选、保存模型、刷新持久化、高级参数校验及恢复默认均通过。
- GUI 测试前确认无用户配置，测试后恢复默认；没有写入密钥或调用订阅推理。
- 已安装 0.3.0 并重启本机 web profile（18089 端口）。

## 0.2.0 GUI 更新

- 按 DSH 官方 settings card 扩展实现浏览器端配置卡片，入口为“设置 → 插件 → 插件配置 → ClinePass 订阅”。
- Chrome 无头浏览器在真实本机 DSH 中验证：卡片加载、密码框、路由必填校验、模型添加/删除、放弃修改、保存超时、刷新后读取持久化值、恢复默认，全部通过。
- 保存测试前确认此命名空间没有用户配置；测试结束已恢复默认，未填写或更改实际密钥。
- 后端 16 项测试通过。真实订阅推理和上游锁定仍未验证。
- GUI 截图保存在 `.cache/gui-settings.png`。

## 0.1.0 初版

日期：2026-09-15。宿主：Windows npm 全局安装的 `@deepseek-ai/dsh 0.1.5-rc.1`。

| 检查 | 结果 |
| --- | --- |
| TypeScript 编译 | 通过 |
| `npm test` | 16 项通过，0 失败；全部使用模拟响应 |
| `npm run smoke` | 通过；使用实际安装的 DSH/Cordis，验证 bundle 合成、模型注册和卸载 |
| Cline 公共模型目录 | 成功获取 15 个 cline-pass/ 模型，不使用密钥或额度 |
| `npm pack --cache .cache/npm` | 成功生成 dsh-plugin-cline-pass-0.1.0.tgz；包含编译文件、bundle、示例及脚本 |
| 真实订阅推理 | 未执行，按用户要求留待配置密钥后验证 |
| 指定上游是否生效 | 未验证，功能标记为 experimental-pin |
| 用户 web profile 安装 / GUI 配置 | 未执行；仅在隔离的内存宿主中验证加载 |

测试覆盖订阅路由限制、配置校验、稳定会话标识、缓存字段缺失/异常、目录过滤、SSE 分片和 UTF-8、多工具交错、思考数据往返、HTTP 限流、取消、错误脱敏、断流拒绝、准备调用配置快照及原生生命周期。

此记录不证明真实模型的工具调用兼容性、账号权益、缓存命中率或上游固定能力。真实测试脚本见 README。
# 0.5.2 — native Provider dropdown and editor (2026-09-15)

- Installed 0.5.2 in the web profile and restarted the local DSH service.
- Registered dormant `cline-pass` under `llm-cline-pass.profile`; native Models owns add/edit/delete and collapsed state. No separate add button.
- Installed the version-checked Models compatibility patch (v3), with original backup. It adds a keyed editor slot and alphabetically sorts dormant providers. Current host needs this patch; an upstream upgrade requires compatibility review.
- Fixed keyed registration (`options.key`), verified the editor appears when selecting `cline-pass`.
- 18 offline tests and the installed-host lifecycle smoke test pass.
- Browser regression passed against the installed package: option name and alphabetical neighbors (`cerebras`, `cline-pass`, `cloudflare-ai-gateway`), one API key field, public model discovery, model and timeout persistence after reload, cancel, apply, collapsed reload, edit, cancel deletion, delete and re-add.
- No API key or inference used. Public catalog requests only. Test-created profile removed; existing providers untouched.
# 0.5.3 — native copy and styling (2026-09-15)

- Reuses the host's Models CSS module, `EditorFooter`, `ModelListEditor` and translations via compatibility patch v4. No copied hashed CSS or separate visual theme.
- API-key placeholder, Customized settings disclosure, primary Apply/保存 button, catalog rows and searchable model picker now match native providers. Removed the extra instruction header, credential status line and nested border.
- Installed 0.5.3 and restarted DSH. Browser style check passed: input and save button classes equal the native anthropic editor; disclosure initially collapsed; model discovery, native picker and search work without browser errors.
- Existing user configuration detected: the browser check cancelled every draft; no provider, model, settings or credential writes. Only public catalog reads, no inference.
# 0.6.0 — commandcode provider (2026-09-15)

- Added optional `commandcode` at `llm-cline-pass.commandcode`, sharing the native Models editor and public model discovery flow.
- Reuses DSH PiAiAdapter with per-model protocol dispatch: Claude → Anthropic Messages; other models → OpenAI Chat Completions. The Anthropic SDK appends `/v1`, so its base URL is normalized to avoid `/v1/v1/messages`.
- 21 tests pass: previous ClinePass checks, Command Code catalog validation, optional lifecycle, and local HTTP/SSE tests verifying endpoint selection, auth and completed text responses for both protocols. No real inference requests.
- Installed 0.6.0 in the web profile and restarted. Migrated 69 existing models and the credential reference; checked all unrelated settings against the backup and they match exactly. Backup retained in the DSH home as `settings.yaml.before-commandcode-1789462084502`.
- Browser check passed on the installed commandcode provider: native styles, key status, default collapsed settings, public catalog, searchable model picker and cancellation. GUI validation made no settings/credential writes.
- Subscription entitlement and live inference remain unverified; this release declares text input and does not add image or selectable reasoning support.
# 0.6.1 — renamed DSH Provider Extensions (2026-09-15)

- Renamed npm package, browser module identity, request attribution and documentation to `dsh-provider-extensions` / DSH Provider Extensions.
- Removed the old package installation and installed the new package in the web profile, retaining the internal settings namespace and both provider configurations.
- Installed-host smoke check passed for both providers. DSH restarted under the new package.
