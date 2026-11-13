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

**边界：** 能确认错误发生在 `agy` 的 trajectory 序列化阶段，不能据此断言是账号额度耗尽，也不能单凭这一条日志确定是模型配置缺陷还是长系统提示/历史触发了预算问题。此次修复改善诊断，不声称修复了闭源 CLI 的零预算计算。

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
- 对 `maxMessageTokens must be positive, got 0` 返回明确但固定、安全的 500 消息，保留原始错误类别，不伪造 429 或登录失效。
- 静态兜底目录补齐已知 22 个原生模型条目，保持 Carbon/Hydrogen 的真实模型与 effort 路由。
- 不合并不同账号的权威模型列表，也不在插件中绕过 Magpie 私自读取其他账号凭据或切号。

## 验证与未完成边界

- 两个线上账号分别通过现有 `spawnAgy` 隔离边界，用 `gemini-3.8-flash-low` 完成原生 ACP 提问并回答 `OK`；原生 `session/set_model` 和 family + `thought_level` 路径均有成功样本。
- `bun x tsc --noEmit` 通过；本地 Bun `1.3.14` 与 `edge` 的 Bun `1.4.4` 均在隔离临时目录运行完整测试：**242 pass / 0 fail**（1432 个断言）。
- 回归测试覆盖编号日志、逐轮隔离、读取上限、真实/伪 429、真实登录错误、零预算错误及静态目录完整性，并通过 worker → SSE encoder 验证真实 HTTP 401/429/500 与登录失效响应头；也覆盖进程退出包装错误携带旧 stderr 的情况。
- 两轮交叉审查（`gpt-6.1-sol` 与 `gpt-6-astra`）提出的重复过滤与 RPC 登录错误来源混淆问题均已修复；复审未发现剩余可证明问题。
- 本次没有在生产账号上注入故障来验证自动切号；原生 Carbon 长对话错误也未宣称解决。
- 完整三阶段改善计划仍见 `improvement-and-fix-plan.md`；本次是优先处理的线上错误与路由问题，不代表 Phase 2/3 已完成。
