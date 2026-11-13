# 500 / 429 与多账号未切换排查

排查日期：2026-11-13。修复版本：`agy-acp 0.1.1`。线上参考：`edge`，Magpie `0.1.3961`，`agy 1.5.8`。

## 已确认的线上证据

### 原生失败被插件隐藏成笼统 500

请求 `1794529492309`（20:12:02，`gemini-4-carbon` / medium）的原生 worker 日志连续记录：

```text
agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0
```

同一请求有 7 次尝试，全部落在账号 A；等待间隔为 1、2、2、4、8、16 秒。该请求约 1.96 MB 的请求体被反复发送，总上传约 13.7 MB。

插件使用 `--process-per-session` 时，前台进程写 `agy-acp.log`，真正执行的子进程写 `agy-acp.log.<PID>`。旧诊断只读前者，漏掉了上面的真实错误。

> 后续变更（`0.1.3` Phase 2）：桥接已改为直启单进程会话 worker（`agy acp --worker --disable-telemetry`，省去冗余前台进程，同时保留 `mcpCapabilities.http`）。`--worker` 仍将日志写入 `agy-acp.log.<PID>`，因此 `TurnLogWatch` 同时监听 `agy-acp.log` 与 `agy-acp.log.<PID>` 依然是必需能力。

**边界：** 能确认错误发生在 `agy` 的 trajectory 序列化阶段，不能据此断言是账号额度耗尽，也不能单凭这一条日志确定是模型配置缺陷还是长系统提示/历史触发了预算问题。此次修复改善诊断，不声称修复了闭源 CLI 的零预算计算。

### 零预算错误的实测触发条件（`0.1.4`）

在 `edge` 上用真实账号复现：`agy acp --worker --disable-telemetry`，每例新建独立会话，历史通过 `_meta.antigravity.systemPrompt.append` 注入 `_meta`，模型 `gemini-4-carbon` / `high`，用户消息固定为 `Reply with the single word OK.`。

| 注入的 append 体积 | 结果 |
| --- | --- |
| 200,000 字节 | 成功，`inputTokens 46,518` |
| 500,000 字节 | 成功，`inputTokens 113,188` |
| 720,000 字节（英文） | 成功，`inputTokens 162,071` |
| 760,000 字节（英文） | 失败：`serializing trajectory: no messages fit within the context token budget` |
| 780,000 / 786,000 / 790,000 / 1,000,000 / 1,200,000 字节 | 失败：`serializing trajectory: maxMessageTokens must be positive, got 0` |
| 720,000 字节（中文，240,000 字） | 成功，`inputTokens 137,721` |
| 760,002 字节（中文，253,334 字） | 失败 |

结论与边界：

- 触发条件是可独立复现的**大 append 块**，不是某个模型/effort 配置、MCP 3 分钟超时（无工具探针同样复现），也不是 `--process-per-session` → `--worker` 切换（两条路径都复现）。
- 边界随字节而不是随 token 移动：720,000 字节中文（137,721 token）通过，760,002 字节中文（约 145,000 token）失败；而 720,000 字节英文（162,071 token）通过。
- 单次 `session/prompt` 用户消息会在约 178 KB 处被静默截断（1,800,000 字符探针只计 44,603 input token），而 `systemPrompt.append` 不会被截断，所以超限直接变成硬失败。
- 热会话不受影响：同一会话后续回合大多命中缓存（实测 `cache 199,732 + new 3,573`），只有被迫冷重放时才需要重新注入整块历史。
- 未证明原生预算公式。`1,048,576 − 262,144 = 786,432` 与观测到的失败边界接近，但这是数值吻合，不是已验证的推导。
- 因此把插件的 append 历史预算降到 **512 KiB**（含系统提示词与工具说明之外的实际 append 文本），并在字节预算中扣除真实系统提示文本；这是有界缓解，不是对闭源 CLI 预算算法的修复。

### 旧 429 分类存在误判风险

旧代码对整段日志和整个 stderr 尾部使用 `/429|RESOURCE_EXHAUSTED|exhausted your quota|quota/i`：

- `quotaProject=` 是普通登录元数据，不是额度耗尽。
- 时间、PID、源码行号、端口等字段可能出现 `429`。
- 前一轮的限流日志、启动时临时的 “not logged in” 可能污染当前轮判断。

线上 20:05:08 的请求记录为 429；其当时的完整执行日志已不可用，**不能追溯证明这一次是真限流还是误判**。

### 第二个账号被模型列表排除

请求 `1794529492309` 的路由详情：

- `order` 只有账号 A。
- 账号 B 在 `left` 中，`unlisted: true`，模型为 `gemini-4-carbon`。
- 因而不是“第二个账号执行后也失败”，而是它根本未被尝试。

Magpie 按插件给出的每账号模型表筛选候选；`FellBack` 标记不会在 `pluginLists` 中自动放开该表。插件原来的 `STATIC_FALLBACK_MODELS` 缺少 Carbon、Hydrogen 和两个 Orchestrator，首次探测超出 1500 ms 快速等待预算时会返回这份不完整列表。已补齐这条确定的排除路径；历史请求当时具体用了哪一份模型快照未保留，不能把推断写成已复现事实。

## 本次改动

- 对前台和数字 PID 后缀日志做逐文件、逐轮快照，只读当前轮新增的有界尾部。
- 对 stderr 做逐轮增量提取，避免重用旧失败。
- 分类前剥离日志元数据，要求明确的限流/额度错误证据；不把任意 `quota`、数字 `429` 当成限流。
- 对两种 trajectory 序列化拒绝（`maxMessageTokens must be positive, got 0` 与 `no messages fit within the context token budget`）统一归类为 `context_budget`，返回明确但固定、安全的 500 消息，保留原始错误类别，不伪造 429 或登录失效。
- 冷重放注入的 `<prior_conversation_history>` 系统追加块默认上限从 `2 MiB` 降到 `512 KiB`（`AGY_BRIDGE_MAX_SYSTEM_HISTORY_BYTES` 可覆盖），并在预算中扣除实际系统提示文本，避免再次进入实测失败区间。
- 静态兜底目录补齐已知 22 个原生模型条目，保持 Carbon/Hydrogen 的真实模型与 effort 路由。
- 不合并不同账号的权威模型列表，也不在插件中绕过 Magpie 私自读取其他账号凭据或切号。

## 验证与未完成边界

- 两个线上账号分别通过现有 `spawnAgy` 隔离边界，用 `gemini-3.8-flash-low` 完成原生 ACP 提问并回答 `OK`；原生 `session/set_model` 和 family + `thought_level` 路径均有成功样本。
- `bun x tsc --noEmit` 通过；本地 Bun `1.3.14` 与 `edge` 的 Bun `1.4.4` 均在隔离临时目录运行完整测试：**242 pass / 0 fail**（1432 个断言）。
- 回归测试覆盖编号日志、逐轮隔离、读取上限、真实/伪 429、真实登录错误、零预算错误及静态目录完整性，并通过 worker → SSE encoder 验证真实 HTTP 401/429/500 与登录失效响应头；也覆盖进程退出包装错误携带旧 stderr 的情况。
- 两轮交叉审查（`gpt-6.1-sol` 与 `gpt-6-astra`）提出的重复过滤与 RPC 登录错误来源混淆问题均已修复；复审未发现剩余可证明问题。
- 本次没有在生产账号上注入故障来验证自动切号；原生 Carbon 长对话错误也未宣称解决。
- 完整三阶段改善计划仍见 `improvement-and-fix-plan.md`；本次是优先处理的线上错误与路由问题，不代表 Phase 2/3 已完成。
