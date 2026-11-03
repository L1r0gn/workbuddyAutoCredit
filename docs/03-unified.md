# 统一入口：一个指令跑完三个签到任务

> 目标：WorkBuddy、Qoder CN、Qoder 国际版三套功能**各自独立**，但用户只需要记住一条命令。
> 架构图：[architecture-unified.svg](architecture-unified.svg) / [architecture-unified.png](architecture-unified.png)

---

## 1. 整体结构

```
┌───────────────────────────────────────────────────────────┐
│ unified/  编排层（新增，~900 行）                          │
│   cli.ts        参数解析、人类可读输出、退出码              │
│   scheduler.ts  北京时间 10:05 触发、启动补偿、单实例 pid   │
│   runner.ts     串行执行、超时/异常隔离、汇总               │
│   platforms.ts  三个适配器（唯一与平台耦合的地方）          │
│   types.ts      PlatformAdapter / PlatformOutcome 契约      │
└───────────────┬───────────────┬───────────────┬───────────┘
                │ 单向依赖（只往下）              │
      ┌─────────▼──────┐ ┌──────▼────────┐ ┌────▼─────────────┐
      │ checkin/        │ │ qoder/        │ │ qoder/           │
      │ WorkBuddy       │ │ region=cn     │ │ region=global    │
      │ （原有，未改）  │ │ （原有，未改）│ │ （同一份代码）   │
      └─────────────────┘ └───────────────┘ └──────────────────┘
```

三条硬约束：

1. **单向依赖**：`unified/ → checkin/ 、unified/ → qoder/`，平台模块**完全不知道**统一入口存在。
   删掉 `unified/` 目录，两个平台照常工作。
2. **零复制**：编排层不复制任何签到逻辑，只调用各平台自己的 `Scheduler.runOnce()`。
   因此 WorkBuddy 的 CDP 诊断、多域名兜底、幂等三层，Qoder 的窗口重试、额度回读、区域隔离，行为一字未变。
3. **契约唯一**：平台与编排层之间只有一个接口 `PlatformAdapter`（4 个成员），
   新增平台只需实现它，不需要改 runner / scheduler / cli。

```ts
interface PlatformAdapter {
  meta: { id; label; hint };
  hasAccounts(): boolean;          // 有没有可执行账号（决定是否参与"今日是否完成"）
  doneToday(date: string): boolean; // 今日是否已全部完成（整批跳过用）
  run(opts: { dryRun?; force? }): Promise<PlatformOutcome>;
}
```

---

## 2. 统一指令的触发逻辑

### 2.1 命令与脚本

| 指令 | 行为 |
|---|---|
| `npm run signin` | **一次性执行三个任务**（默认入口） |
| `npm run signin:status` | 三个平台总览（只读，不发领取请求） |
| `npm run signin:dry-run` | 三个平台全部模拟，不调用任何领取接口 |
| `npm run signin:daemon` | 统一定时服务，每天 10:05 北京时间 |

参数：`--platform <id>`（可重复，`workbuddy` / `qoder-cn` / `qoder-global` / `qoder` / `all`）、
`--dry-run`、`--force`、`--json`、`--timeout <秒>`。

### 2.2 一次性执行的时序

```
用户 → cli.ts
  1. 解析参数，决定要跑哪些平台（--platform 过滤；qoder 会展开成 cn + global）
  2. 装配 runtime：WorkBuddy 一份、Qoder 一份（各自独立 store / logger / config）
  3. 包装成 3 个适配器，顺序固定：WorkBuddy → Qoder CN → Qoder 国际版
  ↓
scheduler.runOnce({dryRun, force})
  4. 打印 run.start 事件（平台清单、日期、是否模拟）
  ↓
runner.runAll()
  5. for 每个适配器（串行）：
     a. 若非 dry-run 且非 force，且 adapter.doneToday(今天) → 直接记 skipped，不发任何请求
     b. 否则 adapter.run()，整体加超时（默认 20 分钟）
     c. try/catch：抛错或超时 → 该平台记 error，继续下一个平台
  6. 汇总成 UnifiedResult
  ↓
cli.ts
  7. 打印每个平台的明细 + 总账
  8. 退出码：0 全部完成 / 1 部分失败 / 2 有平台失败或异常 / 3 有平台无账号
```

### 2.3 定时执行的时序

```
npm run signin:daemon
  1. 检查单实例：unified-daemon.pid 存活则拒绝（返回 3）
  2. 检查冲突：daemon.pid / qoder-daemon.pid 存活则拒绝
     （统一调度已覆盖三个平台，同时开会让同一天跑两轮）
  3. 启动补偿：今天已过 10:05 且仍有平台未完成 → 立即跑一次
  4. 循环：
       算出下一个 10:05（Asia/Shanghai，可配多个时间点）
       sleep 到点
       若今天已跑过且所有平台都完成 → 跳过本轮（不发请求）
       否则 runOnce()
```

**互斥是双向的**：`checkin:daemon` 与 `qoder:daemon` 启动时也会检查 `unified-daemon.pid`，
发现统一调度在跑就拒绝启动。所以任何时刻只会有一套调度在工作。

### 2.4 为什么是串行

- 三个平台会发真实请求，串行便于日志按平台分段阅读，也避免同一瞬间打三个不同域名；
- Qoder 的 10 点窗口重试可能持续数分钟，并行收益有限；
- 平台内部本来就是按账号串行，再加一层并行收益不大、风险更高（限流、误判）。

---

## 3. 模块间调用关系

### 3.1 一次 `npm run signin` 的实际调用链

```
compat: npm run signin
  → dist/unified/cli.js  main()
      → createUnifiedRuntime()                     unified/index.ts
          ├─ createRuntime()          checkin/index.ts      （WorkBuddy 运行时）
          ├─ createQoderRuntime()     qoder/index.ts        （Qoder 运行时）
          └─ createAllAdapters()      unified/platforms.ts
                ├─ createWorkBuddyAdapter(runtime)
                └─ createQoderAdapter(runtime, 'cn' | 'global')
      → UnifiedScheduler.runOnce()                 unified/scheduler.ts
          → runAll(adapters)                       unified/runner.ts
              ├─ adapter.doneToday(date)           各自 store 查今日记录
              └─ adapter.run({dryRun, force})
                    ├─ WorkBuddyScheduler.runOnce()    checkin/scheduler.ts
                    │     → CheckinService.checkinAll() checkin/checkin-service.ts
                    │         → claimDailyCheckin()     checkin/credit-api.ts
                    │         → fetchCredits()          checkin/credit-api.ts
                    │         → StateStore.saveRecord() checkin/state-store.ts
                    └─ QoderScheduler.runOnce()        qoder/scheduler.ts
                          → QoderService.checkinAll()  qoder/service.ts
                              → getRiskIdentity()      qoder/device.ts   （UMID 组件）
                              → fetchCampaigns()       qoder/api.ts
                              → claimCampaign()        qoder/api.ts
                              → fetchQuotaTotal()      qoder/api.ts
                              → refreshTokens()        qoder/auth.ts     （仅在 401/105 时）
          → summarize() → UnifiedResult
```

### 3.2 数据归属（谁写哪里）

| 数据 | 写入方 | 位置 |
|---|---|---|
| WorkBuddy 签到记录 | `checkin/state-store.ts` | `<dataDir>/state.json` |
| Qoder 账号 + 令牌 + 记录 | `qoder/store.ts` | `<dataDir>/qoder-state.json`（0600） |
| 运行日志 | `checkin/logger.ts`（两个平台共用） | `<dataDir>/run-log-YYYY-MM-DD.jsonl` |
| 调度 pid | 各自的 pid 类 | `daemon.pid` / `qoder-daemon.pid` / `unified-daemon.pid` |

`<dataDir>` 默认 `%APPDATA%\workbuddy-auto-checkin`。编排层**不写任何业务数据**，只写日志与自己的 pid。

### 3.3 配置来源

| 配置 | 文件 | 统一入口怎么用 |
|---|---|---|
| WorkBuddy | `checkin.config.json` | 时区与检查点以它为准 |
| Qoder | `qoder.config.json` | 数据目录跟随 WorkBuddy；检查点被统一调度覆盖 |
| 两者检查点不一致 | — | 启动时打印警告（`configWarning`），按 WorkBuddy 的时间执行 |

这样设计的原因：统一入口只能有一个"到点"概念，否则同一进程内两套时间线会互相干扰。

---

## 4. 隔离与容错

| 场景 | 行为 |
|---|---|
| 某平台抛异常 | 该平台 `status=error`，其余平台继续 |
| 某平台超时（默认 20 分钟） | 记 `error` + "执行超时"，其余平台继续；迟到的结果被丢弃 |
| 某平台无账号 | `status=norun`，不影响其它平台；退出码 3 提示配置缺失 |
| 今日已完成 | 整平台 `skipped`，**零网络请求** |
| 某账号凭据失效 | 平台内记为"不可用"，与"程序失败"分开计数（`unavailable`） |
| 同时开了平台 daemon | 双向互斥，后启动者拒绝（返回 3） |
| 同一天被触发多次 | 各平台自身的幂等层拦截（本地记录 + 服务端去重） |

---

## 5. 输出与退出码

```
══ 全部签到结果（2026-11-03）══

[1/3] WorkBuddy（国内版 + AI 国际版）
  ⏭  今日已全部完成，跳过（146ms，无网络请求）

[2/3] Qoder CN 国内版
  ○  没有 Qoder CN 国内版 账号

[3/3] Qoder 国际版
  ○  没有 Qoder 国际版 账号

汇总：平台 3（完成 0｜部分 0｜失败 0｜跳过 1｜无账号 2｜异常 0）
      账号 0，新领取 0，已领取 0，跳过 0，失败 0
      总耗时 0.2s
```

`--json` 输出 `UnifiedResult`（含每个平台的 `records`），适合接监控或再加工。

退出码：

| 码 | 含义 |
|---|---|
| 0 | 全部完成（含"今日已领取""跳过"） |
| 1 | 有平台部分失败 |
| 2 | 有平台整体失败或编排异常 |
| 3 | 有平台没有可用账号（配置问题） |

---

## 6. 测试覆盖（21 个用例）

| 关注点 | 用例 |
|---|---|
| 顺序 | `按顺序执行三个平台并汇总` |
| 异常隔离 | `单平台抛错不影响其它平台`、`超时：该平台记为 error，后续继续` |
| 跳过 | `今日已完成 → 跳过且不调用平台`、`--force/--dry-run 时仍执行` |
| 参数 | `--platform 只跑指定平台`、`parsePlatformSelector：别名与非法值` |
| 汇总/退出码 | `汇总把各平台失败账号数相加`、`退出码：0/1/2/3` |
| 调度 | `allDone 只统计有账号的平台`、`shouldCatchUp`、`runForever 启动补偿` |
| 账号归属 | `Qoder 适配器国内版只看 cn 账号`、`某区域无账号时 hasAccounts=false` |
| 互斥 | `pid 文件写入/存活探测/陈旧 pid` |

全部使用假适配器与临时目录，不发真实请求。

---

## 7. 开发期发现并修复的缺陷

1. **超时计时器被 `unref()`**：当被等待的 Promise 不产生任何 I/O（例如整批卡住、无网络活动）时，
   事件循环会先空闲退出，超时永远不会触发，`runAll` 挂死。
   测试 `超时：该平台记为 error，后续平台继续执行` 暴露了它 —— 已去掉 `unref()`。
   影响面：不仅是测试，真实运行中"整批无 I/O 的卡死"同样会漏掉超时。

2. **平台 daemon 互斥是单向的**：最初只有统一调度检查平台 pid，反过来没有。
   用户若先开统一调度、再开平台 daemon，就会出现两套调度。
   已在 `checkin/cli.ts` 与 `qoder/cli.ts` 的 daemon 命令补上对 `unified-daemon.pid` 的检查。

3. **"不可用账号"与"程序失败"混在一起报**：WorkBuddy 的 AI 国际版在本机没装客户端，
   每天都让汇总显示"部分完成 1 个失败"。现在两者分开计数，
   输出为"失败 1（其中不可用 1）"，用户一眼能判断该不该管。
