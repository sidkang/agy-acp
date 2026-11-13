# 与 Magpie 官方 Claude 订阅桥接（`claude_subscription`）对齐说明

本文记录 `agy-acp` 与 Magpie 官方内置 Claude Code CLI 桥接（`yetone/magpie/internal/gateway/claude_subscription.go`）在系统提示词、工具隔离、冷却回收及协议边界上的对照与实现结论。

---

## 1. 是否禁用底层 CLI 自带 System Prompt（双模式支持）

| 维度 | Magpie 官方 `claude_subscription` | `agy-acp` 实现 |
|---|---|---|
| 开关名称与默认值 | `ClaudeLeanPrompt`（默认 **`false` 关闭**） | `minimal_agent`（默认 **`false` 关闭**） |
| **保留原生提示词（默认）** | 保留 Claude Code 内置系统提示词（约 ~1.1K tokens），上游看到的请求形态与真人交互式运行一致 | 隔离 Agent 配置 `excludeDefaultComponents: false`，保留 `agy` 原生组件（约 ~8.4K tokens，第 2 步起 86%~90% 走 Prompt Cache 命中），保持完整原生请求指纹 |
| **精简/禁用原生提示词（开启）** | 传 `--system-prompt-file` 替换内置系统提示词，仅保留最小身份头与调用方提示词 | 设 `excludeDefaultComponents: true`，剥离 `agy` 内置组件，仅剩桥接的一行工具说明 + 调用方提示词（首步系统提示词降至 ~500 tokens） |
| **动态切换隔离** | `run.lean != req.leanPrompt` 时拒绝复用旧进程，立即重建会话 | `worker.minimalAgent !== requestedMinimalAgent` 时立即关闭旧 Worker 并跳过异构冷会话缓存，按新模式重建 |

---

## 2. 不禁用原生 Prompt 时，如何注入客户端自身的 System Prompt

在不关闭底层原生提示词（默认模式）下，需要同时解决 **Prompt Cache 共享**、**双工作目录环境冲突** 与 **第三方客户端特征风控** 三个问题：

1. **原生系统级追加（不污染首条 User 消息）**：
   - 官方 `claude_subscription` 使用 `--append-system-prompt-file` 将调用方指令挂在原生系统提示词之后（放在首条消息里会导致跨会话无法复用系统提示词缓存，`#2432`）。
   - `agy-acp` 在 `session/new` 与 `session/resume` 中通过 ACP 原生扩展 `_meta.antigravity.systemPrompt.append` 注入处理后的系统提示词；仅当旧版 `agy` 不支持 `append` 能力时，才回退为首条消息开头的 `<external_system_instructions>...</external_system_instructions>` 包裹块。
2. **工作目录与运行环境消歧（防止模型乱猜路径）**：
   - 桥接进程运行在临时空沙盒目录（`$TMPDIR/agy-magpie-ws-*`），原生提示词中的工作目录是临时目录，而工具实际在客户端宿主目录执行。
   - 对齐 `claude_subscription` 的 `envElsewhereLeanNote`：当请求携带 `X-Magpie-Work-Dir` 时，自动在系统指令末尾追加环境消歧说明，明确告知模型所有工具均在调用方描述的目录与系统环境中执行，无需探测核实。
3. **动态噪声剥离与提示词脱敏（`src/protocol/cloak.ts`）**：
   - 剥离每轮变化的 `x-anthropic-billing-header`（`cch=...`）及 `<system-reminder>` 内的动态时钟行，防止热会话被误判为提示词变更而断连；
   - 对触发 Antigravity 上游伪 `429` 拒绝的第三方客户端特征行（Claude Code / Claude Agent SDK / Codex / Hermes / oh-my-pi RFC 2119）自动插入零宽空格；
   - 对 DeepSeek Harness 的 `@` 路径段落做同义改写（对齐 `#1028`，避免 `gemini-4-argon` 跳过思考浅层秒回）；
   - 会话中途出现的 `role: system / developer` 消息统一转为 `<system-reminder>` 用户块，保持多轮热会话不断开。

---

## 3. 冷却回收时长、内存上限与孤儿进程防护

| 参数 / 机制 | Magpie 官方 `claude_subscription` | `agy-acp` 实现 |
|---|---|---|
| **热空闲超时（`idleTimeoutMs`）** | **`1 小时`**（`idleLongest = time.Hour`，对齐 1h Prompt Cache 窗口，`#463`） | **`1 小时`**（`3,600,000 ms`，可在插件 Options 覆盖） |
| **每账号热进程上限** | `idleMost = 6` | `maxPerAccountWorkers = 6`（全局上限 `maxGlobalWorkers = 16`） |
| **挂起工具等待超时** | `parkLongest = 5m`（最多保留 `parkedMost = 16`） | `awaitingToolTimeoutMs = 10m`（客户端中断未交 `tool_result` 自动回收） |
| **冷会话架（`parkedSessions`）** | 落盘会话供 `--resume` 续接 | 内存仅存轻量索引供 `session/resume`：**TTL 6 小时 + 最多 32 条 + 单会话 ≤ 4 MiB + 总预算 ≤ 16 MiB**（超大图会话冷却后立即释放堆内存） |
| **孤儿进程与临时目录清理** | `proc.StartTree`（Unix Session / Windows Job）整树回收 + 启动清扫超时临时目录 | 1. `detached: false` 保持在 Magpie `StartTree` 进程组内，宿主遭 `SIGKILL` 时随组一并回收；<br>2. 单 Worker 关闭时按父子 PID 树自底向上清理后代进程；<br>3. 同时监听 `process.once("exit")` / `SIGINT` / `SIGTERM`（覆盖 `host.js` `stdin` 关闭时的 `process.exit(0)`），连短命 `/usage`、`models` 探测子进程与临时目录一并同步回收；<br>4. 临时目录写入 `.owner-pid`，启动及每分钟巡检自动清扫死进程遗留目录。 |

---

## 4. `agy` 原生内置工具的四重封禁

确保模型 100% 只能发起客户端声明的工具调用，绝不在桥接机本地执行任何内置文件或终端操作：

1. **独立 Agent Manifest 清空内置工具（`src/runtime/worker.ts`）**：每次在 `0700` 空临时目录生成 `.agents/agents/magpie-bridge/agent.md`，显式声明：
   - `tools: []`：清空 `agy` 全部内置工具（`read_file`、`write_file`、`edit`、`run_shell_command`、`grep`、`glob`、`web_fetch`、`google_web_search`、`save_memory` 等）；会话级 `mcpServers: [{ name: "magpie", type: "http", url }]` 独立挂载，仅暴露客户端工具；
   - `subagent: false`：禁用内置子代理派生；
   - `inheritMcp: false` & `inheritCustomizations: false`：彻底隔离宿主机用户全局配置的 MCP、Skills 与 Hooks。
2. **ACP 客户端能力硬关闭**：`initialize` 显式上报 `fs: { readTextFile: false, writeTextFile: false }, terminal: false`。
3. **权限请求兜底拒绝（`src/runtime/acp-connection.ts`）**：任何 `session/request_permission` 请求一律自动选择 `reject/deny`（无拒绝项则返回 `cancelled`）。
4. **物理目录隔离**：`agy` 进程的 `cwd` 始终锁定在空临时目录 `$TMPDIR/agy-magpie-ws-*`，绝不在用户真实工作目录启动。

---

## 5. 其他已对齐的细节与后续可扩展项

### 已完成对齐项
- **`tool_choice` 缓存稳定性**：与 `claude_subscription`（`TestClaudeToolChoiceNoneKeepsTheTools`）一致，`tool_choice: none / tool / any` 时保持 `tools/list` 工具目录不变以保护 Prompt Cache 前缀，在 Broker 层做调用拦截与约束提醒。
- **子代理与标题旁路请求隔离**：识别 `X-Magpie-Subagent` 独立分桶；客户端发来的无工具标题生成 / 摘要旁路请求自动走无状态短会话，绝不挤占或踢掉正在热运行的工具主会话。
- **Pi / Claude Code 交互边界恢复**：支持工具执行中途 `steer` 打断（带 `promptSeq` 纪元隔离与取消超时自动重放）、`followUp` 续跑、工具后自动 `/compact` 压缩重开，以及 112 KiB 预算下保头保尾裁剪 `<conversation>`。
- **结构化输出（`output_config.format` / `response_format`）**：支持 `json_schema` 与 `json_object` 格式约束注入（兼容 Claude Code Prompt Hooks）。
- **WAL SQLite 逐 Step 用量与缓存读取**：通过只读 URI（Checkpointed WAL 自动走 `?immutable=1`）读取 `gen_metadata`，在 `tool_use` 与 `end_turn` 每一步精确上报 `input_tokens`、`output_tokens` 与 `cache_read_input_tokens`。

### 后续可选演进项
- **重启后跨进程持久化会话映射（可选）**：当前 `parkedSessions` 保存在插件宿主内存中（Magpie 不重启即可在 6 小时内无缝 `session/resume`）；若未来希望 Magpie 彻底重启后仍能 `session/resume` 旧会话，可参考 `agy-cli` 在 `$AGY_ACP_DATA_DIR` 落盘一份只存 `sessionId + SHA256(system/history)`（不含正文）的轻量索引文件。
