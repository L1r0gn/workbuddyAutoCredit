# WorkBuddy 每日积分自动签到

独立实现的 WorkBuddy（国内版 / AI 国际版）每日积分自动签到模块。
**直接复用官方客户端的登录态**，通过官方积分接口完成"查询 → 领取 → 验证 → 缓存"的完整闭环。

- 不改官方客户端安装文件，不注入 UI，不上传任何凭据
- 多账号静默签到（各自用自己的 token，不切换客户端）
- 默认北京时间每天 10:05 检查，已领取则不发任何请求
- 完整的自动化测试（68 个用例）与机器可读的运行日志

> 技术来源说明：接口地址、判定规则、加密信封格式均通过对参考项目
> [WorkDaddy](https://github.com/babygoton/WorkDaddy) 源码的逐行阅读获得，并在本机真实账号上核对过。
> 详见 [docs/01-analysis.md](docs/01-analysis.md)。代码为独立重写，未复制参考项目源码。

---

## 1. 它是怎么工作的

```
本机登录凭据（可能被 AES-256-GCM 信封加密）
   → 需要时用 WorkBuddy.exe 自身的 Electron 私有绑定派生解密密钥
   → 得到 accessToken（只在内存中，不落盘、不进日志）
   → POST {令牌签发域}/billing/meter/daily-checkin   body: {}
   → 依据 code / msg 判定：code=0 领取成功；code=10001+「已签到」= 今日已完成
   → 查询领取前后积分做二次验证
   → 写入本地 state.json + JSONL 运行日志
   → 当天再次运行直接跳过（不发任何网络请求）
```

架构图：[docs/architecture.svg](docs/architecture.svg) / [docs/architecture.png](docs/architecture.png)

```
checkin/
├── cli.ts              命令行入口（status / run / all / dry-run / daemon）
├── index.ts            运行时装配与对外导出
├── scheduler.ts        时区调度（Asia/Shanghai）+ 退避重试 + pid 文件
├── checkin-service.ts  签到闭环、幂等保护、结果验证
├── credit-api.ts       官方积分查询 / 签到接口与结果判定
├── client.ts           HTTP 客户端（超时、错误分类、有限重试）
├── auth-manager.ts     凭据读取、信封解密、令牌有效性
├── account-manager.ts  账号发现与多账号去重
├── cdp.ts              CDP 发现 / 选页 / Runtime.evaluate（可选能力）
├── state-store.ts      本地状态（原子写 + 跨进程锁）
├── logger.ts           脱敏日志
├── config.ts           路径、profile、配置加载
└── types.ts            类型定义
scripts/key-probe.cjs   在客户端运行时内派生解密密钥（只读）
test/                   自动化测试
```

---

## 2. 快速开始

要求：**Node.js ≥ 20**（推荐 22），已安装并登录 WorkBuddy 客户端。

```bash
npm install        # 只装 typescript 与 @types/node
npm run build

# 1) 先看状态（只读：账号、凭据有效性、今日签到、积分）
npm run checkin:status

# 2) 模拟执行（不发领取请求）
npm run checkin:dry-run

# 3) 真正签到（当前登录账号）
npm run checkin:run

# 4) 所有账号
npm run checkin:all

# 5) 后台定时服务（默认 10:05）
npm run checkin:daemon
```

如果你的客户端不在默认安装目录（例如装在 `F:\WorkBuddy`），指定一次即可：

```bash
# 临时：环境变量
WORKBUDDY_EXE="F:/WorkBuddy/WorkBuddy.exe" npm run checkin:status

# 长期：写入配置（见第 4 节 workBuddyExe）
```

### 命令一览

| 命令 | 作用 | 是否改变服务端状态 |
|---|---|---|
| `npm run checkin:status` | 账号、凭据、今日签到状态、当前积分，附带 CDP 诊断 | 否 |
| `npm run checkin:run` | 当前登录账号签到 | **是**（幂等） |
| `npm run checkin:all` | 遍历所有账号签到 | **是**（幂等） |
| `npm run checkin:dry-run` | 模拟：只校验凭据与积分，不领取 | 否 |
| `npm run checkin:daemon` | 常驻定时服务 | 到点才会 |

常用参数：

```bash
--json              输出机器可读 JSON
--offline           不查询积分（只读本地记录）
--account <uid|标签|序号>   只处理指定账号
--force             忽略本地"今日已成功"记录，强制再确认一次（服务端仍按天去重）
--no-cdp            跳过 CDP 诊断
--dry-run           （daemon）只模拟不领取
```

`--account` 支持 uid、脱敏标签（`9b09****0e`）、昵称或 `1`/`2` 序号。

---

## 3. 输出示例（真实运行）

```
$ npm run checkin:status
运行配置：
  数据目录      C:\Users\<you>\AppData\Roaming\workbuddy-auto-checkin
  凭据目录      C:\Users\<you>\AppData\Local\CodeBuddyExtension\Data\Public\auth
  时区 / 检查点 Asia/Shanghai / 10:05
  客户端缺失时  skip
  令牌自动刷新  关闭

账号状态（2026-11-02，北京时间）
#  账号        昵称    客户端  当前  凭据    今日签到         积分
─  ──────────  ──────  ──────  ────  ──────  ───────────────  ────────
1  9b09****0e  L1r0gn  CN      是    有效    已完成(already)  8713.46
2  76d4****05  —       AI      是    不可用  无记录           查询失败

CDP：未连接（未发现 CDP 调试端口（客户端需以 --remote-debugging-port 启动））
```

```
$ npm run checkin:run
  9b09****0e  already        成功  code=10001  积分 8710.56 → 8710.56  验证=server-code
      服务端：今天已签到，请明天再来
      诊断：服务端表示今日已签到，未重复发放

合计 1：新领取 0，已签到 1，跳过 0，模拟 0，失败 0
```

再次运行（**零网络请求**）：

```
INFO 账号 9b09****0e 今日已确认签到，跳过所有请求
  9b09****0e  skipped        跳过  code=10001  ...  验证=local-record
```

---

## 4. 配置

可选文件 `checkin.config.json`（放在项目根目录或数据目录），全部字段都有默认值。
仓库里提供了模板 `checkin.config.example.json`；`checkin.config.json` 属于**本机配置**，已被 `.gitignore` 忽略。
本机已生成一份，其中把客户端路径固定为 `F:/WorkBuddy/WorkBuddy.exe`：


```json
{
  "timezone": "Asia/Shanghai",
  "checkTimes": ["10:05"],
  "clientMissing": "skip",
  "allowTokenRefresh": false,
  "requestTimeoutMs": 12000,
  "verifyDelayMs": 2500,
  "profiles": ["workbuddy-cn", "workbuddy-ai"],
  "retry": { "maxAttempts": 3, "baseDelayMs": 2000, "maxDelayMs": 60000 },
  "scanLegacyBackup": false,
  "workBuddyExe": {
    "workbuddy-cn": "F:/WorkBuddy/WorkBuddy.exe"
  },
  "verbose": true
}
```

| 字段 | 说明 |
|---|---|
| `checkTimes` | 每天检查的时间点（调度时区）。可写多个：`["10:05","20:30"]`，当天失败会在下一个点再试 |
| `clientMissing` | 客户端未运行时的行为：`skip`（默认，仍用本地凭据尝试）/ `launch`（带 `--remote-debugging-port` 拉起） |
| `allowTokenRefresh` | 是否允许用 refresh token 换新令牌。**默认关闭**：刷新可能旋转 refresh token，导致客户端下次自己刷新失败。开启后仅在本进程内存生效，绝不写回官方文件 |
| `verifyDelayMs` | 领取后等待多久再查积分做验证 |
| `retry` | 网络类故障的指数退避参数（超时/连接错误/5xx/429 才重试） |
| `scanLegacyBackup` | 是否把参考项目 WorkDaddy 的账号备份目录当作额外账号来源（只读） |
| `workBuddyExe` | 客户端可执行文件路径，用于解密凭据。装在非默认目录时**必须**配置，否则无法解密已加密的凭据 |

环境变量：

| 变量 | 作用 |
|---|---|
| `WORKBUDDY_EXE` / `WORKBUDDY_AI_EXE` | 覆盖客户端路径 |
| `WORKBUDDY_CHECKIN_DATA_DIR` | 覆盖数据目录（默认 `%APPDATA%\workbuddy-auto-checkin`） |
| `WORKBUDDY_CHECKIN_CONFIG` | 配置文件绝对路径 |

### 多账号

账号按"一个 uid 一个来源文件"识别，优先级：

1. **official**：官方客户端当前登录文件（`workbuddy-desktop.info` / `workbuddy-desktop-ai.info`）—— 即当前登录账号
2. **managed**：`<数据目录>\accounts\*.info` 里你自己放的凭据备份
3. **legacy-backup**：`%APPDATA%\WorkDaddy\accounts\*.info`（需 `scanLegacyBackup: true`）

同一 uid 出现多次会自动去重（保留优先级最高的一份），避免重复领取。
不同账号各自独立记录日志与结果，**单个账号失败不影响其它账号**。

> 说明：官方客户端的登录文件同一时刻只保存一个账号，所以"多账号"需要多份 `.info`。
> 本模块不会代替你去复制凭据——这属于敏感操作，交给用户自己决定。

---

## 5. Windows 后台运行

### 方式 A：常驻终端

```bash
npm run checkin:daemon
```

启动后会写 `daemon.pid`，重复启动会被拒绝（返回码 3）。`Ctrl+C` 优雅退出。

> Windows 上用任务管理器"结束任务"属于强杀，信号处理器不会执行，`daemon.pid` 可能残留；
> 下次启动会自动检测 pid 是否存活并接替，无需手工清理。

### 方式 B：开机自启（计划任务）

以管理员身份打开 PowerShell，把 `<项目路径>` 换成实际路径：

```powershell
$action  = New-ScheduledTaskAction -Execute "node.exe" `
           -Argument "dist\checkin\cli.js daemon" -WorkingDirectory "<项目路径>"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "WorkBuddyAutoCheckin" -Action $action -Trigger $trigger `
  -Description "WorkBuddy 每日积分自动签到" -RunLevel Limited
```

或者用 `nssm` / `pm2` 托管。日志在 `<数据目录>\run-log-YYYY-MM-DD.jsonl`。

### 方式 C：只跑一次（配合系统计划任务）

```powershell
& node.exe "dist\checkin\cli.js" all
```

把触发器设为每天 10:05 即可。这种方式不占常驻进程，缺点是错过时间点不会自动补。

---

## 6. 安全设计

| 约束 | 实现方式 |
|---|---|
| 不上传任何凭据 | 全代码只有 `codebuddy.cn` / `workbuddy.cn` / `codebuddy.ai` / `workbuddy.ai` 四个官方域，且必须有该令牌自己的 `iss` 才发请求（白名单 `ISSUER_HOST_MAP`） |
| Token 不进源代码 | 令牌只存在于进程内存，来自本机凭据文件 |
| 不关闭 TLS 校验 | 从不设置 `NODE_TLS_REJECT_UNAUTHORIZED`；请求层也不传 `rejectUnauthorized`。若外部环境已关闭，启动时会打 `warn` 提示 |
| 不伪造设备身份 | 不使用伪装的浏览器 UA，只发送本账号自身的 `x-user-id` / `x-domain` |
| 不绕过风控 | 无验证码/MFA 处理逻辑；凭据失效就停下并提示重新登录 |
| 不写官方文件 | 凭据文件只读；`allowTokenRefresh` 开启时新令牌也只在内存 |
| 幂等保护 | 进程内 inFlight 锁 + 本地已验证记录 + 服务端按天去重，三层 |
| 不误报成功 | 只有 `code=0`（且 HTTP 正常）或 `10001`+明确"已签到"文案才算完成；200 但无 code、HTML 响应、未知 code 一律判失败 |
| 未知响应保守处理 | 4xx/5xx/超时/未知 code → `unsupported` 或 `error`，附带诊断信息（含实际尝试的地址与响应 data 字段名），不猜测 |
| 日志脱敏 | 写盘前统一替换 JWT / `Bearer xxx` / 长 base64 / cookie，账号一律 `9b09****0e` 形式 |

日志会记录的字段（需求 6）：执行日期、账号（脱敏）、开始/结束时间、签到前积分、签到后积分、是否已领取、是否成功、失败原因。

---

## 7. 测试

```bash
npm test          # 编译 + 运行 68 个用例
npm run typecheck # 只做类型检查
```

覆盖场景与需求清单的对应关系：

| # | 场景 | 测试用例 |
|---|---|---|
| 1 | 未登录账号 | `未登录账号：不发任何领取请求` |
| 2 | 已领取账号 | `今日已签到（code=10001 + 已签到文案）` |
| 3 | 未领取账号 | `未领取账号：code=0 且积分增加` |
| 4 | 多账号 | `多账号：一个账号失败不影响其它账号` 等 2 例 |
| 5 | 网络断开 | `网络断开：重试后返回明确失败` |
| 6 | CDP 连接失败 | `端点全部未开放：connect 返回未连接 + 明确原因` 等 4 例 |
| 7 | Token 过期 | `令牌过期且未开启刷新`、`401 停止后续尝试` |
| 8 | 重复运行 | `重复运行：第二次命中本地记录`、`并发同一账号`、`--force` |
| 9 | 领取成功验证 | `code=0 但积分差额为 0`、`HTTP 200 但没有业务 code`、`HTML/空响应` |
| 10 | 客户端关闭/重启 | `runOnce：客户端未运行时仍完成签到`、`配置为 launch 时会拉起`、CDP 重连用例 |

测试全部使用可编程 `fetch`，**不接触真实账号**，也不会发出任何真实领取请求。

---

## 8. 已实现 / 未实现

### 已实现

- [x] 本机登录态自动读取（明文 / AES-256-GCM 信封两种形态）
- [x] 解密密钥派生（`WorkBuddy.exe` + `ELECTRON_RUN_AS_NODE`，只读）
- [x] 多账号发现、去重、身份核对（`--account` 选择）
- [x] 积分查询（`get-user-resource`，周期剩余字段优先）
- [x] 每日领取（`daily-checkin`），多域名 + 双版本路径兜底
- [x] 结果判定（成功 / 已签到 / 活动关闭 / 未授权 / 未知，五态）
- [x] 到账验证（积分差额优先，服务端 code 兜底，并标注验证依据）
- [x] 幂等三层保护 + `--force` 显式覆盖
- [x] 北京时间调度、启动补偿、有限次指数退避
- [x] 客户端缺失时的两种策略（跳过 / 拉起）
- [x] CDP 发现、严格归属判定、选页、页面就绪检查、断线处理
- [x] JSON 状态存储（原子写 + 0600 + 跨进程锁 + 90 天保留）
- [x] 脱敏 JSONL 运行日志
- [x] 5 个 CLI 命令 + JSON 输出
- [x] 68 个自动化测试

### 未实现 / 待验证

- [ ] **签到成功（`code=0`）时的响应 `data` 结构** —— 待验证。
      本机账号当天已签到，只能观测到 `10001` 分支；参考实现同样不解析成功响应的 `data`。
      因此本实现只用 `code===0` 判定成功，不展示"本次获得多少积分"。
      下次在未签到的日子首次运行后，日志里会留下 `data` 字段名，可据此再扩展。
- [ ] **`daily-checkin` 的独立"状态查询"接口** —— 参考实现与官方客户端都没有。
      本实现据实采用"本地记录 + 幂等领取返回值"判定当日状态，**没有编造任何 GET 接口**。
- [ ] **企业账号签到** —— 未验证。参考实现的企业分支只覆盖积分查询，签到走同一接口；
      本机无企业账号。失败时按 `unknown` 保守处理并输出诊断。
- [ ] **WorkBuddy AI 国际版实测** —— 代码与单测就绪，但本机未安装该客户端，
      无法派生解密密钥（密钥绑定在具体可执行文件内），因此实际登录态未跑通。
- [ ] 图形界面 —— 本模块只有 CLI（按需求）。
- [ ] SQLite 存储 —— 需求允许"JSON 或 SQLite"，当前实现 JSON，接口已隔离便于替换。
- [ ] 账号自动切换 —— 不实现。切换会改变官方客户端的登录态，风险高于收益；
      多账号通过各自的 `.info` 实现，不触碰当前登录状态。

---

## 9. 常见问题

**`未找到 WorkBuddy 可执行文件，无法解密凭据`**
客户端装在非默认目录。用 `WORKBUDDY_EXE` 或 `config.workBuddyExe` 指定 `WorkBuddy.exe` 的完整路径。
之所以需要它：新版客户端把凭据加密了，密钥只能由客户端进程自己的 Electron 私有绑定提供。

**`未发现 CDP 调试端口`**
客户端启动时没带 `--remote-debugging-port`。**这不影响签到**（签到走本地凭据 + HTTP），
CDP 只用于身份核对与页面就绪检查。需要时用如下命令重启客户端：

```bash
"F:/WorkBuddy/WorkBuddy.exe" --remote-debugging-port=9222
```

**`accessToken 已过期或即将过期`**
默认不自动刷新（避免影响客户端登录态）。请在客户端里正常使用/重新登录一次，
然后重跑；或显式开启 `allowTokenRefresh`（新令牌只在内存，不写回官方文件）。

**`今天已签到，请明天再来`（code=10001）**
这不是失败，是服务端确认今日已完成。记录里 `verified=true`、`verification=server-code`。

**积分差额为 0**
服务端可能异步入账，或奖励计入其它积分包。此时仍判成功（因为 `code=0` 是明确确认），
但验证依据降级为 `server-code`，诊断里会注明。

**同一天会不会领两次？**
不会。三层保护：同一进程内按 uid 串行、跨进程锁 + 本地已验证记录、服务端按天去重。

---

## 10. 免责声明

本模块仅在本机复用你**自己已登录的账号权限**执行官方客户端本身提供的签到功能，
不修改客户端、不绕过任何验证、不上传任何数据。
接口属于官方私有接口，可能随客户端版本变化而失效；失效时本模块会停止领取并给出诊断，不会猜测实现。

请遵守 WorkBuddy / CodeBuddy 的服务条款。因使用本工具产生的任何后果由使用者自行承担。
