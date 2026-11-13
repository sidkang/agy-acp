# agy-acp

面向 [Magpie](https://usemagpie.ai) 与 [OpenCode](https://opencode.ai) 的多账号 **Antigravity CLI（`agy acp`）** 模型插件。

通过官方 `agy acp`（Agent Client Protocol）驱动本机 `agy` CLI，在 **`agy-acp`** Provider 下提供 `agy` 开放的 Gemini、Claude 与 GPT-OSS 系列模型；客户端工具通过本地回环 HTTP MCP 原样交由调用方执行。

## 与现有插件的区别

| 能力 | `agy-acp`（本插件） | `agy-cli`（`@magpie-community/opencode-agy-cli-auth`） | `antigravity`（`@magpie-community/opencode-antigravity-auth`） |
|---|---|---|---|
| 上游通道 | 本机 `agy acp` 进程池 | 本机 `agy acp` 进程池 | OAuth Token 直连 HTTP 接口 |
| 多账号池 | **支持**（独立目录凭证隔离 + 复用本机登录） | 不支持（`single: true`，受限于系统单钥匙串） | 支持 |
| 工具桥接 | 原生 Streamable-HTTP MCP（`127.0.0.1`） | 劫持 `PATH` 下 `nc` 命令转发 stdio | 协议层直接透传 |
| 会话与缓存 | 热进程粘性复用 + `session/resume` + WAL SQLite 逐 step 缓存结算 | 热进程池 + `session/resume` | 无状态 HTTP |

> 说明：同一 Google 账号在 `agy-acp`、`agy-cli` 与 `antigravity` 下共用同一份 Antigravity 订阅额度池。

## 环境要求

- **`agy` CLI** `>= 1.5.0`（已加入 `PATH`，或通过 `AGY_PATH` 指定路径）
- **Magpie** `>= 0.1.3900`

## 安装与登录

```sh
magpie plugin add github:sidkang/agy-acp
magpie plugin login agy-acp
```

模型调用格式为 `agy-acp/<模型>`（如 `agy-acp/gemini-3.8-flash`、`agy-acp/gemini-4-hydrogen`、`agy-acp/claude-sonnet-5-5`、`agy-acp/claude-opus-5-5`）。

### 两种登录方式（支持添加多个账号并发使用）

可执行多次 `magpie plugin login agy-acp`（或在 **Magpie › Providers › Antigravity ACP** 点击添加账号）：

1. **`Sign in isolated Google account (multi-account)`（推荐，多账号隔离）**：在 `$XDG_DATA_HOME/agy-acp/accounts/<uuid>` 下创建 `0700` 独立凭证目录，使用文件级 Token 存储，不读写系统 Keychain，也不影响终端里的默认 `agy` 登录态。打开输出的授权链接完成登录后，粘贴授权码或回调 URL 即可。
2. **`Adopt existing local agy login (host default)`（复用本机登录）**：直接复用终端 `agy` 当前已登录的账号。

查看各账号 5 小时 / 7 天额度窗口：

```sh
magpie quota agy-acp
```

## 配置项

### Provider 开关（Magpie › Providers › Antigravity ACP）

| 开关 | 默认值 | 说明 |
|---|---|---|
| `quota_routing` | `false` | 将 5 小时 / 周配额接入 Magpie 路由，单账号耗尽时自动切到其他账号 |
| `cloak_prompts` | `true` | 剥离旋转计费头并对触发上游伪 429 的第三方客户端标识句做零宽字符脱敏 |
| `minimal_agent` | `false` | 为隔离桥接 Agent 开启 `excludeDefaultComponents`，精简内置系统提示词开销 |
| `expose_thinking` | `false` | 将 ACP 思考摘要作为 Anthropic `thinking` 块返回 |

### 插件参数（`plugins.json` / Magpie › Plugins › Installed › Options）

```json
{
  "maxGlobalWorkers": 16,
  "maxPerAccountWorkers": 6,
  "idleTimeoutMs": 3600000
}
```

可通过环境变量 `AGY_PATH` 指定 `agy` 可执行文件路径，`AGY_ACP_DATA_DIR` 指定隔离账号存储根目录。与 Magpie 官方 Claude 桥接的设计对齐说明见 [docs/claude-bridge-parity.md](./docs/claude-bridge-parity.md)。

## 开发与测试

```sh
bun install
bun x tsc --noEmit
HOME=$(mktemp -d) bun test
```

## 致谢与协议

Fork 自 [`@magpie-community/opencode-agy-cli-auth`](https://github.com/magpie-community/plugins/tree/main/packages/agy-cli)（`DylanLIiii`、`gitxm`、`yce`）并以严格模式 TypeScript 重写。详见 [NOTICE.md](./NOTICE.md) 与 [LICENSE](./LICENSE)（MIT）。
