# agy-acp

基于 Google 官方 **Antigravity CLI（`agy`）** 原生 ACP 通道构建的 [Magpie](https://github.com/yetone/magpie) 多账号模型 Provider 插件。

装好后，Claude Code、OpenCode、Pi、Codex 等任意客户端经由 Magpie 调用 `agy-acp/<模型>`，底层通过官方 `agy acp` 进程完成请求，工具调用通过标准本地回环 HTTP MCP 交由调用方原生执行。

---

## 来源与 Fork 说明

本项目基于 [`magpie-community/plugins/packages/agy-cli`](https://github.com/magpie-community/plugins/tree/main/packages/agy-cli)（`@magpie-community/opencode-agy-cli-auth`，上游源自 `DylanLIiii/opencode-antigravity-bridge` 及 `gitxm`、`yce` 的贡献，MIT 协议）Fork 并采用严格模式 TypeScript 进行模块化重构，同时参考了 `yetone/magpie` 官方内置 Claude Code 订阅桥接（`claude_subscription`）的会话亲和与工具所有权设计。

相比上游 `agy-cli`，`agy-acp` 主要做了以下架构升级：

- **支持多账号并发与自动切号（`single: false`）**：不再受限于全局单钥匙串账号。除一键复用本机默认 `agy` 登录外，支持添加任意多个独立隔离的 Google 账号——每个账号分配独立 `0700` 目录并启用 `agy` 文件级凭证存储，互不抢占 Keychain / SecretService。
- **原生 Streamable-HTTP MCP（移除 `nc` PATH 劫持）**：直接通过 ACP `session/new` 的标准 `mcpServers` 注册单会话 256-bit Token 鉴权的本地回环 HTTP MCP 服务（`http://127.0.0.1:<port>/mcp/<token>`），彻底告别替换子进程 `PATH` 中 `nc` 命令的非公开拨号方式。
- **真实会话亲和（`chat.headers` + 消息账本）**：接入 Magpie 的 `chat.headers`（`sessionID`）与 `x-magpie-effort`，按 `账号 + 会话 ID` 精确隔离并复用热会话，解决相同开场白对话互相冲突的问题。
- **可参与路由调度的配额窗口**：解析每个账号的 `agy -p /usage --output-format json`（`Gemini` 与 `Claude & GPT` 的 5 小时 / 7 天窗口），支持开启配额路由开关让 Magpie 在单账号额度耗尽时自动切换到其他账号。
- **Anthropic Messages 协议严格对齐**：修复省略 `stream` 时误返回 SSE、流前错误状态码丢失、非流式提示词拒绝误返回 `502` 等兼容性问题；保留并强类型化了上游完整的 Gemini JSON Schema / RE2 正则清洗管线（含根级 `oneOf`/`anyOf`/`allOf` 折叠）。

---

## 环境要求

- **Antigravity CLI（`agy`）**：`>= 1.5.0`（已在 `1.5.7` 实测验证）。
- **Magpie**：`>= 0.1.3900`（支持多账号 Provider 插件与 `chat.headers`）。

---

## 安装

```bash
magpie plugin add /path/to/agy-acp
```

安装后 Provider ID 为 **`agy-acp`**，模型名格式为 `agy-acp/<模型>`（例如 `agy-acp/gemini-3.8-flash`、`agy-acp/gemini-4-hydrogen`、`agy-acp/claude-opus-5-5`、`agy-acp/claude-sonnet-5-5`）。

---

## 多账号登录与使用

在 Magpie 的 **Providers** 页面找到 `Antigravity ACP`（`agy-acp`），或通过命令行执行：

```bash
magpie plugin login agy-acp
```

提供两种登录方式（可重复添加多个账号同时并发使用）：

1. **`Sign in isolated Google account (multi-account)`（推荐，多账号隔离）**
   - 为该槽位创建独立隔离目录（默认位于 `$XDG_DATA_HOME/agy-acp/accounts/<uuid>`），调用 `agy acp --login` 生成登录链接。
   - 在浏览器完成 Google 授权后，将页面显示的授权码（或完整回调 URL）粘贴回 Magpie 即可。凭据独立保存在该账号私有目录中，不影响终端或其他槽位的登录态。
2. **`Adopt existing local agy login (host default)`（复用本机默认登录）**
   - 如果你已经在终端运行 `agy` 登录过，直接一键接入本机当前登录账号，无需再次授权。

### 查看多账号额度

```bash
magpie quota agy-acp
magpie quota agy-acp --json
```

---

## Provider 开关（Magpie UI `auth.options`）

在 Magpie 的 `agy-acp` Provider 页面可直接切换以下开关：

| 开关 Key | 默认值 | 说明 |
|---|---|---|
| `quota_routing` | `false` | **按配额自动多账号路由**：开启后将 5 小时 / 7 天配额窗口标记为活跃（`aside: false`），某个账号对应模型池耗尽时由 Magpie 自动路由到其他已登录账号。 |
| `cloak_prompts` | `true` | **自动脱敏第三方客户端提示词**：剥离旋转计费头（`x-anthropic-billing-header`）并对 Claude Code / Codex / oh-my-pi 等会触发上游伪 429 拒绝的固定标识句插入零宽空格。 |
| `minimal_agent` | `false` | **精简内置系统提示词**：在临时隔离桥接 Agent 中开启 `excludeDefaultComponents: true`，大幅减少每次请求的内置提示词 Token 开销（内置读写/终端工具无论开关与否始终强制禁用）。 |
| `expose_thinking` | `false` | **输出思考摘要块**：将 ACP 返回的思考摘要编码为 Anthropic `thinking` 内容块输出。 |

---

## 环境变量（可选）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AGY_PATH` | 按 `PATH` 自动查找 | 指定 `agy` 可执行文件路径 |
| `AGY_ACP_DATA_DIR` | `$XDG_DATA_HOME/agy-acp` | 插件隔离账号数据与防弹窗垫片根目录 |
| `AGY_BRIDGE_MAX_PROCS` | `16` | 全局活跃/挂起 `agy acp` 会话进程上限 |
| `AGY_MAGPIE_QUOTA_ROUTING` | `false` | 环境变量方式覆盖 `quota_routing` 初始默认值 |
| `AGY_MAGPIE_CLOAK_PROMPTS` | `true` | 环境变量方式覆盖 `cloak_prompts` 初始默认值 |
| `AGY_MAGPIE_MINIMAL_AGENT` | `false` | 环境变量方式覆盖 `minimal_agent` 初始默认值 |
| `AGY_MAGPIE_EXPOSE_THINKING` | `false` | 环境变量方式覆盖 `expose_thinking` 初始默认值 |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | `true` | 默认禁止插件子进程并发自动更新二进制 |

---

## 开发与测试

```bash
bun install
bun x tsc --noEmit
bun test
```

## License

MIT — 详见 [LICENSE](./LICENSE)（保留上游 `DylanLIiii`、`gitxm`、`yce` 版权声明）。
