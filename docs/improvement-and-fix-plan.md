# `agy-acp` 架构审查、Claude 桥接对照与完整改善修复计划

> 生成时间：2026-11-13  
> 综合来源：
> 1. **上一轮迭代方案复盘核对**（已完成落地的 6 项基线能力 + 2 项顺延遗留项并入）；
> 2. **`agy 1.5.8` 线上进程/存储实测与 Magpie 官方 `claude_subscription`**（`yetone/magpie/internal/gateway/claude_*.go`）逐模块对照；
> 3. **`codex/gpt-6-astra:high` 全量源码只读架构与缺陷审查**（覆盖 `src/` 全部 12,251 行代码与 Magpie `internal/plugin/host.js` 宿主协议契约）。

---

## 零、上一轮迭代方案状态核对（Baseline Continuity）

### 已在 `381f9eb4` / `20896be0` 完成并上线 `edge` 的项目
- [x] **超长对话冷重放（有界 append 预算）**：`session/prompt` 保留最近 `112 KiB`，更早历史溢出至 `_meta.antigravity.systemPrompt.append`（`<prior_conversation_history>`）。`0.1.4` 起 append 上限由 `2 MiB` 降到 `512 KiB`：线上实测 `agy 1.5.8` 在 760,000 字节报 `no messages fit within the context token budget`、780,000 字节及以上报 `maxMessageTokens must be positive, got 0`，原预算会稳定撞进该区间。超限时丢弃最早整条消息并写入省略标记。
- [x] **跨重启持久化 `session/resume` 索引**：`$AGY_ACP_DATA_DIR/parked-sessions.json`（`0600` 纯 SHA-256 摘要零明文，推进前先失效旧检查点）。
- [x] **首轮动态会话 ID 漂移热认领 + 并发扩容**：`adoptAwaitingToolWorker` 按挂起 `toolu_*` ID 原位重绑 + `18 / 36 / 36` 并发参数。
- [x] **Session Header 双兼容**：`x-agy-session-id` + `x-magpie-session`（`ALT_SESSION_ID_HEADER`）兜底。
- [x] **Usage 套餐徽章与倍率**：`loadCodeAssist` 查询并缓存 1h 订阅档位（`Google AI Ultra` / `Pro` + `5x` / `20x`）。
- [x] **基础 48h 磁盘 GC + 跨机禁写 `<appDataDir>/brain` + SQLite WAL `3×25ms` 微退避 + 非流式 JSON 纯 `thinking` 空块兜底 + 更新 `claude-bridge-parity.md` + GitHub Actions CI 全绿**。

### 上一轮方案中尚未实施、现正式并入本计划的顺延项
- [ ] **[CARRY-1] 多模态 PDF 文档（`type: "document"`, `application/pdf`）透传探测与打通**：`agy 1.5.8` `initialize` 已声明 `promptCapabilities.embeddedContext: true`，需实测 `session/prompt` 的 `resource`（`blob` + `mimeType: "application/pdf"`）是否被上游原生解析；若支持则在 `src/protocol/anthropic.ts` 与 `coordinator.ts` 放开 PDF Base64 透传（当前直接 `400` 拒绝）。
- [ ] **[CARRY-2] 发布与社区合入流水线（Release Workflow）**：补充 GitHub Actions Tag Release / 包校验流水线与发布脚本，对齐 npm 发布及 `magpie-community/plugins` 准入规范。

---

## 一、`agy` vs Magpie `claude` 会话存储与运行机制对照纪要

| 维度 | `agy` 原生存储 + `agy-acp` 桥接 | Claude Code + Magpie `claude_subscription` | 差距与优化切入点 |
| :--- | :--- | :--- | :--- |
| **进程模型与单会话内存** | `worker.ts` 传了 `--process-per-session`，导致每会话拉起 **2 个 Go 进程**（前端 `~138 MiB` + `--worker` `~210–250 MiB`，合计 **350–388 MiB RSS**）。`agy 1.5.8` 实测：`--process-per-session` 换成 `--worker --disable-telemetry` 后为 **单进程**（0 个子进程，回合内 `~212 MiB`、`session/resume` 后 `~175 MiB`）。注意**不能**只去掉 `--process-per-session`：裸 `--stdio` 前台不复现 `mcpCapabilities.http`，会静默丢弃 `session/new` 的 HTTP `mcpServers`，调用方工具永远到不了模型。 | 1 个会话 1 个 `claude` 进程（约 `86–112 MiB` 匿名内存），并由 `claude_rss.go` 监控单进程树 RSS，超限（主机内存 1/8，保底 1 GiB）在回合结束后自动搁置并换新进程。 | **`--process-per-session` → `--worker --disable-telemetry`**；补齐回合后单 Worker RSS 水位检查与自动搁置换新。 |
| **并发满载调度策略** | `GlobalScheduler.ensureCapacity` 无空闲可淘汰 Worker 时 **0ms 立即抛 `503 overloaded_error`**。 | `claude_room.go`（`claudeRoom`）提供有界等待队列（默认最多等 `2m`，绑定请求 `ctx.Done()`），任一槽位释放即刻唤醒接棒；同时支持按 Linux `/proc/meminfo` + cgroup `memory.max` 自动推算内存安全上限。 | **将瞬时硬 `503` 改为有界 FIFO 排队等位（Wait-for-Room）**，彻底平滑突发 subagent 扇出峰值。 |
| **原生磁盘存储与 GC** | 强制写入 `<account>/.gemini/antigravity-cli/`：<br/>• `conversations/<id>.db`（WAL SQLite）<br/>• `conversation_summaries.db`（含 FTS5 全文索引，`edge` 上 34 个会话已达 **21.7 MiB**）<br/>• `brain/<id>/`、`implicit/*.pb`、`annotations/*.pbtxt`、`log/*.log`、`crashes/` | `-p` 默认 `--no-session-persistence` 零落盘；搁置会话写单文件 `<sid>.jsonl`，用完或超 1h 即删。 | 现有 48h GC 已覆盖 `conversations/*.db*`、`brain/*`、`log/*.log`，**需补齐 `annotations/`、`implicit/`、`crashes/` 清理及 `conversation_summaries.db` 孤儿 FTS 记录回收与日志体积上限**。 |
| **跨重启热恢复 (`shelf`)** | 内存 `parkedSessions`（6h TTL）+ 磁盘 `parked-sessions.json`（`0600` 纯 SHA-256 摘要，终态实时写 + 推进前先失效）。 | 内存 `b.shelf` + 退出时写 `claude-shelf.json`（下次读取后立即删除）。 | 需修复 **多恢复源账本错绑（Bug #3）** 与 **多宿主并发写 `parked-sessions.json` 无文件锁（Bug #10）**；并可增加内容哈希二级索引支持无 Session Header 客户端。 |
| **历史改写与大图容错** | `isPrefixMatch` 对历史图片字节严格比对；内联大图原样透传 Base64。 | `claude_lost_media.go` 容忍客户端剥离早期历史图片而不打断热会话；`claude_images.go` 对 `>2000px` 或 `>5MiB` 内联图自动缩放重压。 | 增加 **`lostMedia` 前缀容错匹配** 与 **超限图片缩放兜底**。 |
| **结构化输出与文本工具兜底** | 提示词级 JSON Schema 约束；未拦截纯文本伪 XML 工具调用。 | `claude_tui_schema.go` 注册虚拟 MCP 工具 `StructuredOutput` + JSON Schema 实时校验重调闭环；`claude_text_calls.go` 流式拦截伪文本 `<tool_call>`。 | 按需引入 `StructuredOutput` MCP 校验回路与伪文本工具调用拦截。 |

---

## 二、`codex/gpt-6-astra` 架构与代码缺陷审查清单

### A. 具体代码缺陷（按严重度排序）

- [ ] **[HIGH-1] 未消费 SSE 响应被取消时导致会话死锁与 Worker 永久 Pin 住**（`src/protocol/anthropic.ts:1599–1634`）
  - **触发路径**：`await encodeAnthropicSseResponse(...)` 返回 `Response` 后，在首次 `pull()` 之前调用 `body.cancel()` 或触发 `signal` 中断（Magpie 宿主 `internal/plugin/host.js` 的 `record.unconsumedBody` 在下游提前断开时正是如此操作）。
  - **影响**：`PeekedTurnSource` 已预启动协调器生成器，但 `ownsSource` 仅在首次 `pull()` 时置 `true`；`cancel()` 因 `!ownsSource` 直接返回，不调用 `source.close()`，导致协调器生成器永久挂起在 `yield`，`sessionLocks` 与 `worker.pinned = true` 永不释放。
  - **修复方案**：将 `source` 所有权与预取生命周期显式绑定到 `finalized` 选定的正式 `Response`（占位 twin 标记为 detached），确保即使从未 `pull()`，`body.cancel()` 与 `signal` 中断也会关闭 `source` 并执行协调器 `finally`。

- [ ] **[HIGH-2] 流式/JSON 编码器遇到 `error` 事件提前退出，绕过协调器的故障 Worker 淘汰逻辑**（`src/sessions/coordinator.ts:1894–1900, 1965–1973, 2166–2172`）
  - **触发路径**：有状态会话（Fresh / Warm / AwaitingTools）产出 `{ type: "error" }` 事件。
  - **影响**：SSE `pumpTurnEvents` 与 `collectAnthropicJsonResponse` 在收到 `error` 后立即终止并调用 `iterator.return()`，生成器直接跳入 `finally`，绕过了 `for await` 循环**之后**的 `if (sawError) { ... worker.close("turn_error") }`。故障 Worker 留在活跃池中（且原生库可能已写入半截失败轮次，与 `committedMessages` 失步）。
  - **修复方案**：将 `sawError`（以及未正常 `finish` 的半截中断收尾）移入三处执行路径的 `finally` 块统一淘汰清理。

- [ ] **[HIGH-3] 持久化恢复（`persisted`）在内存中残留不兼容 `parked` 条目时错绑旧账本**（`src/sessions/coordinator.ts:1745–1808`）
  - **触发路径**：同一 `sessionKey` 下存在旧的、前缀不兼容的内存 `parked` 条目 A；随后分叉对话 B 落盘到 `persisted` 并在 Worker 退出后触发恢复。选择阶段跳过了不兼容的 `parked`、选中了 `persisted`，但启动后 `if (worker.resumedFromShelf && parked)` 仅检查 `parked` 非空，把 A 的旧账本和 `appliedSystemHistorySeed` 赋给了 B 的 Worker。
  - **影响**：若 A 的旧账本长于 B，`req.messages.slice(worker.committedMessages.length)` 为空，用户最新指令被静默吞掉。
  - **修复方案**：用单一判别联合类型 `resumeSource: { kind: "memory", entry } | { kind: "persisted", entry } | null` 贯穿选择与恢复后绑定；同时当内存 `parked` 前缀已不兼容新请求时主动剔除陈旧内存条目。

- [x] **[MED-4] 下游慢消费时 Worker `AsyncEventQueue` 无上限缓冲 + SSE 心跳无视背压**（`src/runtime/worker.ts:118–135, 703–776`；`src/protocol/anthropic.ts:1313–1321`）
  - 已在 Phase 2 修复：16 MiB 上限、超限清空并以 `502` 结束回合并关闭 Worker；心跳仅在 `desiredSize > 0` 或存在 pull credit 时写入。
  - **影响**：客户端读完首帧后卡住时，SSE 虽停止拉取，但 ACP stdout 持续 `queue.push()` 无限堆积内存，且 15s 心跳帧无视 `desiredSize` 持续写入。
  - **修复方案**：为单回合 `AsyncEventQueue` 增加字节上限（如 `16 MiB`），超限主动报错回收该回合；SSE 心跳仅在 `desiredSize > 0` 时写入。

- [ ] **[MED-5] `withAccountProvisionLock` 文件锁获取失败会导致该账号内存锁永久死锁**（`src/accounts/auth.ts:139–159`）
  - **影响**：`acquireAccountFileLock(accountRef)` 位于 `try/finally` 之外；一旦文件锁超时或抛错，`releaseMem()` 永不执行，当前进程后续对该账号的一切登录/导入操作永久挂死。
  - **修复方案**：将 `acquireAccountFileLock` 移入 `try` 内部，在 `finally` 中安全释放 `releaseFile?.()` 与 `releaseMem()`。

- [ ] **[MED-6] `steer` 工具提交屏障超时关闭 Worker 后吞掉异常，未触发重放恢复**（`src/runtime/worker.ts:1572–1574, 1660–1666`）
  - **影响**：`waitForActiveToolCallsCommit(5_000)` 超时时内部已调用 `await this.close(...)`，外层 `catch {}` 吞掉异常后继续在已关闭连接上发 `session/cancel` 与新 prompt，向用户抛连接已关闭错误而非走已有的 `SteerReplayNeededError` 无感重放。
  - **修复方案**：在该 `catch` 分支直接抛出 `new SteerReplayNeededError(...)`，交由协调器既有重放分支处理。

- [ ] **[MED-7] `disable_parallel_tool_use: true` 时迟到兄弟工具调用被一次性全量放行**（`src/mcp/broker.ts:259–269`）
  - **影响**：模型连续发起 ≥3 个工具调用时，第 1 个单独返回，但 `deliverToolResults` 将 `queuedUnexposed` 中剩余 2+ 个调用一次性全部提升为 `exposedPending`，违背串行工具调用契约。
  - **修复方案**：当 `this.disableParallelToolUse` 为真时，每次仅从 `queuedUnexposed` `shift()` 提升 1 个调用。

- [ ] **[MED-8] 热会话复用与搁置恢复未校验 `X-Magpie-Work-Dir` 变更**（`src/sessions/coordinator.ts:1225–1252, 1568–1578, 1697–1707`）
  - **影响**：会话中途切换工作目录时，仍复用旧 `--add-dir` 与旧工作目录消歧系统提示词。
  - **修复方案**：在热会话复用、`parked` 恢复、`persisted` 恢复判定中加入归一化 `workDir` 相等性检查。

- [ ] **[MED-9] 工具兼容性与持久化摘要忽略了 `tool.description` 变更**（`src/sessions/coordinator.ts:176–198, 854–883`）
  - **影响**：客户端动态更新工具描述（例如权限范围、可用技能列表注入在 description 中）而名称与参数 Schema 未变时，热会话不会更新 `broker.setTools()`，持久化恢复也会误命中旧描述。
  - **修复方案**：在 `isToolSetCompatible` 与 `computeToolsDigests` 中纳入 `tool.description ?? ""`。

- [ ] **[MED-10] 多进程共享数据目录时 `parked-sessions.json` 缺少文件锁与增量合并**（`src/sessions/coordinator.ts:1090–1162`）
  - **影响**：两个宿主进程并发运行（如 Magpie 与独立测试/CLI 共用目录）时，全量缓存覆盖写可能丢失对方的写入，甚至复活已被另一进程 `invalidate` 的旧检查点。
  - **修复方案**：读写 `parked-sessions.json` 时加轻量文件锁，锁内按最新磁盘快照应用单键 `upsert` / `delete` 增量事务。

- [ ] **[MED-11] 终端 OAuth 登录（`agy acp --login`）打印出授权链接后丢失取消与超时清理权**（`src/accounts/auth.ts:1484–1524`）
  - **影响**：检测到 URL 后即清除了启动定时器与 `signal` 监听并置 `settled = true`；若用户放弃登录不填回调码，`agy acp --login` 子进程与临时隔离目录泄漏。
  - **修复方案**：引入覆盖整个登录会话生命周期（含等待用户输入授权码阶段，如 10 分钟总上限）的统一幂等 `disposeFlow()` 与 `AbortSignal` 绑定。

- [ ] **[LOW-12] 正常完成的请求未移除外层 `init.signal` 转发监听器**（`src/index.ts:292–295`）
  - **影响**：若调用方复用长生命周期 `AbortSignal` 发送多次请求，监听器与闭包持续累积。
  - **修复方案**：JSON 模式在 `finally` 中无条件移除；SSE 模式在流正常结束或取消的收尾回调中无条件移除。

---

### B. 架构演进与模块化瘦身项（Deep Modules 重构）

- [ ] **[ARCH-1] 拆分上帝类 `src/sessions/coordinator.ts`（当前 2,269 行）**
  - 将纯函数与独立状态存储拆出为深模块，使协调器只保留「会话锁 + 路由状态机决策」：
    1. `src/sessions/ledger.ts`：消息规范化（`canonicalPartsForLedger`）、前缀匹配（含 `lostMedia` 容错）、工具集/工作目录兼容性与统一 SHA-256 摘要计算（内存与磁盘共用同一套表示，消除双份逻辑漂移）；
    2. `src/sessions/prompt-render.ts`：冷/热消息渲染、112 KiB 预算裁剪与 `<prior_conversation_history>` 溢出规划；
    3. `src/sessions/shelf-store.ts`：统一管理内存温架（`parkedSessions`）与带文件锁增量更新的持久化索引（`parked-sessions.json`），对外只暴露 `park()`, `invalidate()`, `resolveResume()`。

- [ ] **[ARCH-2] 收敛 `AgySessionWorker` 回合状态与独立 Usage 结算器（当前 1,724 行）**
  - 提取 `src/runtime/turn-context.ts`（封装单次 HTTP 回合的 `AsyncEventQueue`、`promptSeq`、取消抑制标志与收尾钩子）和 `src/usage/tracker.ts`（封装 SQLite WAL 游标推进与微退避读取），消除散布在 Worker 内的十余个松散布尔/计数器字段。
  - 移除 `coordinator.ts` 中对 `scheduler.onBeforeEvictIdle` 的 `(scheduler as any)` 强转覆写，统一走正式接口或 Worker 淘汰钩子；将 `worker.pinned` 改为幂等租约函数 `pin(): () => void`。

- [ ] **[ARCH-3] 收敛 `encodeAnthropicSseResponse` 双流所有权模型**
  - 将 `PeekedTurnSource` 的执行所有权与兼容层同步占位 `Response` 解耦，保证无论调用方走 `await encodeAnthropicSseResponse(...)` 还是同步读取、无论是否拉取过首帧，流关闭/异常均确定性触发单次 `source.close()`。

- [ ] **[ARCH-4] 统一 `src/accounts/auth.ts` 交互式登录生命周期与组合超时信号**
  - 抽取统一的 `combineSignals(callerSignal, timeoutMs)` 与幂等 `createLoginSessionDisposer()`，统一浏览器回调流与终端授权码流的超时、取消、子进程回收和临时目录回滚。

---

## 三、分阶段执行计划（Execution Plan）

### Phase 1：高优正确性 Bug 清零（阻塞性 / 数据一致性修复）
1. 修复 **HIGH-1**（`anthropic.ts` 未读 SSE 流取消泄漏锁与 Pin）与 **LOW-12**（`index.ts` 外层 `AbortSignal` 监听器的完整解绑）。
2. 修复 **HIGH-2**（`coordinator.ts` 三处有状态路径在 `finally` 中确保 `sawError` 及异常中断 Worker 退役）。
3. 修复 **HIGH-3**（`coordinator.ts` 区分 `memory` vs `persisted` 恢复源，剔除失效 `parked` 条目，杜绝错绑账本）。
4. 修复 **MED-5**（`auth.ts` `withAccountProvisionLock` 死锁）、**MED-6**（`worker.ts` `steer` 屏障超时转 `SteerReplayNeededError`）、**MED-7**（`broker.ts` 串行工具逐个放行）、**MED-8 & MED-9**（`workDir` 与 `tool.description` 纳入复用/恢复校验）、**MED-11**（终端登录全周期清理）。
5. **验证门禁**：为上述每一条缺陷补齐针对性回归单测（未读流取消、编码器遇错退役、双恢复源竞争、3 个串行迟到工具调用、文件锁超时恢复等），全量跑通 `tsc --noEmit` 与 `bun test`。

### Phase 2：进程瘦身、排队等位调度与存储治理（对标 Magpie `claude` 核心收益）
1. **单进程模式切换**:`worker.ts` 已把 `--process-per-session` 换成 `--worker --disable-telemetry`。`agy 1.5.8` 线上实测：`--worker` 单进程 **0 个子进程**（回合内 `~212 MiB`、`session/resume` 后 `~175 MiB`），且保留 `mcpCapabilities.http`、`--add-dir`、`_meta.antigravity.systemPrompt.append` 与 `session/resume`。实测反证：去掉 `--process-per-session` 但**不加** `--worker` 时，前台 `initialize` 不返回 `mcpCapabilities.http`，`session/prompt` 里模型会回答工具不存在（HTTP MCP 工具竞会被静默丢弃）；加上 `--worker` 后同一 prompt 正常返回 `tool_use`。日志侧读取 `agy-acp.log` 与 `agy-acp.log.<pid>` 两类的逻辑不变（单进程下后者不存在，读取为空）。
2. **Scheduler 有界排队（Wait-for-Room）+ RSS 超限换新**:
   - `GlobalScheduler` 新增 `waitTimeoutMs`（默认 `60s`，`0` 恢复立即 `503`）与 `maxWaiters`（默认 `128`）;按 FIFO 排队，槽位释放/Worker 转 `IDLE`/`unpin`/`unregister`/reap 任一事件均唤醒等待者，且不跨等待持锁（账号 A 满额不阻塞账号 B）。
   - 新增 `src/runtime/rss.ts`（Linux `/proc` 遍历、其他 Unix 单次 `ps` 快照，`/proc` 不可用回退 `statm`），`AgySessionWorker.getRssBytes()` 在非 Linux 上 10s 内复用样本。`SessionCoordinator` 在干净结束的回合后若 `IDLE` Worker 超过 `maxWorkerRssBytes`（默认 `1 GiB`，`0` 关闭，可调 `AGY_BRIDGE_MAX_WORKER_RSS_MB`）则先 `parkSession` 再退役，下轮走 `session/resume` 无损续接。
3. **全面存储与缓冲治理**:
   - 修复 **MED-4**：单回合 `AsyncEventQueue` 16 MiB 上限（超限清空并以 `502` 结束该回合，触发 Worker 回收），`AsyncEventQueue` 不再计入直接交给读者的条目；SSE 心跳仅在 `desiredSize > 0` 或仍有 pull credit 时写入。
   - `sweepStaleAccountStorage` 扩展：`annotations/`、`implicit/`、`crashes/`、根 `cli.log`（超龄删除或尾部截断）、`log/` 目录字节上限（默认 32 MiB，优先删最旧），并回收 `conversation_summaries.db` 中不存在对应 `conversations/<id>.db` 的 summary / FTS5 / parent 行（`busy_timeout=50`、`BEGIN IMMEDIATE`、乐观跳过）；不存在该库时绝不创建。
   - `quota.ts` 与 `catalog.ts` 内存缓存惰性清理：配额缓存按 TTL 清理并上限 128 条；目录缓存保留真实列表 24h（避免探测失败退回更窄的模型集而让账号被 `unlisted` 排除），上限 128 条。
   - 验证：`bun x tsc --noEmit` 通过；隔离环境完整测试 **263 pass / 0 fail**（含 `test/runtime-phase2.test.ts`、`test/storage-gc.test.ts`），并对新增逻辑做过变异校验（去掉唤醒/上限/回收后对应测试失败）。
   - 未覆盖：SSE 心跳背压分支与 `rs` 进程树采样只在无真实 `agy` 的沙箱中审阅，未做长时线上观测。


### Phase 3：模块化架构解耦与高阶协议增强
1. **模块化重构（ARCH-1 ~ ARCH-4）**：将 `coordinator.ts` 拆分为 `ledger.ts` + `prompt-render.ts` + `shelf-store.ts`（顺带落地 **MED-10** `parked-sessions.json` 文件锁增量事务），收敛 `worker.ts` 的 `turn-context.ts` 与 `usage/tracker.ts`。
2. **缓存与多模态体验增强（对标 Claude 桥接）**：
   - 在 `ledger.ts` 支持 **`lostMedia` 历史图片剥离容错匹配**（客户端清理旧轮次大图不断热会话）与 **内容哈希二级会话寻址**；
   - 增加超限内联图片（`>2000px` / `>5 MiB`）自动缩放兜底；
   - **并入上一轮顺延项 CARRY-1**：实测 `agy acp` `embeddedContext` 对 `application/pdf` Base64 `resource` 的原生支持，若支持则打通 Anthropic `document` PDF 输入；
   - 可选增强：引入虚拟 MCP `StructuredOutput` 校验重试闭环与伪文本 `<tool_call>` 流式拦截。
3. **发布与工程化收尾（并入上一轮顺延项 CARRY-2）**：
   - 补齐 Release Tag CI 工作流、版本号一致性校验与发布前打包检查，支持一键发版及向 `magpie-community/plugins` 提 PR。
