# 每日积分自动签到（WorkBuddy + Qoder / Qoder CN）

两个平台的独立实现，共用一套日志、配置、存储与调度基础设施：

| 平台 | 机制 | 凭据来源 | 说明 |
|---|---|---|---|
| **WorkBuddy**（国内版 / AI 国际版） | 固定签到接口 | 本机官方客户端登录态（AES-256-GCM 信封） | [docs/01-analysis.md](docs/01-analysis.md) |
| **Qoder CN / Qoder**（国内版 / 国际版） | 活动（campaign）领取 | 设备码授权登录（PKCE）或环境变量令牌 | [docs/02-qoder.md](docs/02-qoder.md) |
| **统一入口** | 编排上述三个任务 | 复用各平台凭据 | [docs/03-unified.md](docs/03-unified.md) |

- 不改官方客户端安装文件，不注入 UI，不上传任何凭据
- 多账号独立执行，单个账号失败不影响其它账号
- 默认北京时间每天 10:05 检查，已完成则不发任何请求
- 完整的自动化测试（180 个用例）与机器可读的运行日志

> 技术来源：接口地址、判定规则、加密信封/设备身份协议，全部来自对参考项目
> [WorkDaddy](https://github.com/babygoton/WorkDaddy) 与 [Qoder-Daily](https://github.com/L0NE-6/Qoder-Daily)
> 源码的逐行阅读，并尽量在本机核对。代码为独立重写，未复制参考项目源码。
> 无法确认的部分在各自文档的「待验证」小节明确标注。

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

qoder/                  Qoder CN / Qoder 国际版（结构与 checkin/ 平行，复用其日志/客户端/时区工具）
├── cli.ts              login / accounts / status / run / all / dry-run / refresh / daemon
├── index.ts            运行时装配
├── scheduler.ts        每日调度 + 启动补偿 + pid 文件
├── service.ts          签到闭环、幂等、额度回读验证
├── api.ts              活动列表 / 领取 / 额度接口与结果判定
├── campaign.ts         每日活动识别、Pro 排除、窗口判定
├── auth.ts             设备码登录（PKCE）与令牌续期
├── device.ts           官方 UMID 组件调用与设备身份缓存
├── accounts.ts         环境变量导入、账号筛选
├── store.ts            账号 / 令牌 / 记录（原子写 0600）
├── config.ts           区域常量、组件定位、版本读取
└── types.ts            类型定义

unified/                统一入口（新增）：只做触发、隔离、汇总，不含任何平台逻辑
├── cli.ts              一条命令跑三个平台：run / status / dry-run / daemon
├── scheduler.ts        北京时间 10:05 触发 + 启动补偿 + 单实例互斥
├── runner.ts           串行执行、单平台超时与异常隔离、汇总
├── platforms.ts        三个适配器（唯一与平台耦合的地方）
└── types.ts            PlatformAdapter / PlatformOutcome 契约

scripts/key-probe.cjs   在客户端运行时内派生解密密钥（只读）
test/                   自动化测试（180 个用例）
```

---

## 2. 快速开始

要求：**Node.js ≥ 20**（推荐 22）。

### 2.1 一条命令跑完三个平台（推荐）

```bash
npm install
npm run build

npm run qoder:login -- --region cn       # 首次：Qoder 账号授权一次（有账号可跳过）
npm run qoder:login -- --region global   # 可选：国际版账号

npm run signin:status     # 三个平台总览（只读）
npm run signin            # 一次性执行全部签到
npm run signin:daemon     # 每天 10:05 自动执行
```

输出示例：

```
══ 全部签到结果（2026-11-03）══

[1/3] WorkBuddy（国内版 + AI 国际版）
  ✅ 完成｜账号 1｜新领取 1，不可用 1（未登录或未安装对应客户端）｜3.9s
     · 9b09****0e  checked-in  100

[2/3] Qoder CN 国内版
  ⏭  今日已全部完成，跳过（120ms，无网络请求）

[3/3] Qoder 国际版
  ○  没有 Qoder 国际版 账号

汇总：平台 3（完成 1｜部分 1｜失败 0｜跳过 1｜无账号 1｜异常 0）
```

常用参数：`--platform workbuddy|qoder-cn|qoder-global|qoder`、`--dry-run`、`--force`、`--json`。
结构、触发逻辑与调用关系见 [docs/03-unified.md](docs/03-unified.md)；
架构图见 [docs/architecture-unified.svg](docs/architecture-unified.svg)。

> 三个平台模块互相独立；统一入口只是外面的一层编排。想单独跑某个平台，继续用下面的命令。

### 2.2 WorkBuddy 单平台命令

```bash
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

统一入口（覆盖三个平台）：

| 命令 | 作用 | 是否改变服务端状态 |
|---|---|---|
| `npm run signin` | **一次性执行 WorkBuddy + Qoder CN + Qoder 国际版** | **是**（各平台幂等） |
| `npm run signin:status` | 三个平台总览（账号数、今日状态、最近结果） | 否 |
| `npm run signin:dry-run` | 三个平台全部模拟，不领取 | 否 |
| `npm run signin:daemon` | 统一定时服务（每天 10:05） | 到点才会 |

单平台命令（WorkBuddy）：

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
npm run signin:daemon     # 推荐：一套调度覆盖三个平台
npm run checkin:daemon    # 只跑 WorkBuddy（与统一调度互斥，只会有一套在跑）
npm run qoder:daemon      # 只跑 Qoder 两个区域
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

## 6. Qoder（CN 国内版 / 国际版）

Qoder 的「签到」实际是**活动领取**：拉活动列表 → 找可领取的每日活动 → 调用领取接口。
与 WorkBuddy 最大的差别是**必须带官方设备风控身份（UMID）**，否则活动根本不下发。
完整技术细节见 [docs/02-qoder.md](docs/02-qoder.md)。

### 6.1 授权登录（一次即可）

```bash
npm run qoder:login -- --region cn       # 国内版 Qoder CN
npm run qoder:login -- --region global   # 国际版 Qoder
```

命令会**先打印授权链接**，再尝试唤起默认浏览器；用目标账号确认后，程序轮询到令牌并保存到本机（0600）。
**不需要密码、验证码或 MFA**，也不需要每天重新登录（令牌会自动续期并落盘）。

```
开始 Qoder CN 国内版 设备授权登录（浏览器里确认一次即可，无需密码/验证码）

授权链接（有效期约 5 分钟）：
  https://qoder.com.cn/device/selectAccounts?challenge=...&challenge_method=S256&machine_id=...

已请求系统用默认浏览器打开（方式：rundll32）；若没看到页面，请手动打开上面的链接。
```

浏览器不会自动打开、或你不想让它自动打开时：

```bash
npm run qoder:login -- --region cn --no-open        # 只打印链接
QODER_LOGIN_NO_BROWSER=1 npm run qoder:login        # 环境变量方式，效果相同
```

> Windows 上用 `rundll32 url.dll,FileProtocolHandler` 唤起默认浏览器；
> 早期版本用 `explorer.exe <url>`，会把带 `&` 的链接当成文件夹路径，结果是弹出文件管理器。
> 现在 explorer 只作为最后兜底，并且**链接始终会打印出来**，不会出现"既没开浏览器又没有链接"的情况。

### 6.2 添加多个账号

三种方式可混用，程序按 `region + uid（或令牌指纹）` 去重：

```bash
# 方式一：再跑一次登录，换另一个账号确认（推荐）
npm run qoder:login -- --region cn --note 小号

# 方式二：手工写入已有令牌
npm run qoder:accounts -- add --region cn --access dt-xxxx --refresh drt-xxxx --note 主号

# 方式三：环境变量（兼容 Qoder-Daily 写法，多条换行或 & 分隔）
export QODER_TOKENS="主号|dt-xxx|drt-xxx"
export QODER_GLOBAL_TOKENS="intl|dt-yyy|drt-yyy|<uid 可选>"
```

查看与删除：

```bash
npm run qoder:accounts                 # 列出账号（令牌脱敏）
npm run qoder:accounts -- --json
npm run qoder:accounts -- remove --account 小号
```

> 国内版与国际版的令牌、设备身份、接口域名**完全隔离**：`QODER_TOKENS` 只进国内版，
> `QODER_GLOBAL_TOKENS` 只进国际版，账号主键带区域前缀，不会串区。

### 6.3 手动签到

```bash
npm run qoder:status                 # 只读：账号、设备身份、今日状态、额度
npm run qoder:dry-run                # 模拟：只查活动，不领取
npm run qoder:run                    # 执行（所有账号）
npm run qoder:run -- --region cn     # 只跑国内版
npm run qoder:run -- --account 主号   # 只跑指定账号（支持 id / 备注 / 序号）
npm run qoder:refresh                # 只续期令牌
```

参数：`--force`（忽略「今日已完成」记录再确认一次，服务端仍按天去重）、`--json`、`--offline`（不查额度）。

### 6.4 定时执行

```bash
npm run qoder:daemon            # 常驻，默认每天 10:05 检查
```

Windows 开机自启可用计划任务（把 WorkBuddy 的脚本换成 `dist\qoder\cli.js daemon`，
任务名换成 `QoderAutoCheckin` 即可，见第 5 节）。

调度语义：
- 默认 10:05（`checkTimes` 可配多个），启动时若已过点且未完成会补一次。
- 当日全部账号已确认 → 该时间点不发任何请求。
- 官方活动窗口 10:00 开启且可能延迟下发；**只有在 10 点这一小时内**才会按
  `windowRetry`（默认最多 6 次 / 间隔 10 分钟）重试，窗口外不重试。

### 6.5 查看日志

```
%APPDATA%\workbuddy-auto-checkin\run-log-YYYY-MM-DD.jsonl   结构化运行日志（JSONL）
%APPDATA%\workbuddy-auto-checkin\qoder-state.json           账号/令牌/记录（0600，勿外传）
```

每条记录包含：日期、区域、账号（脱敏）、结果、活动 ID、面值、领取前后额度、是否验证到账、耗时。

### 6.6 Qoder 配置

可选文件 `qoder.config.json`（项目根或数据目录），模板见 `qoder.config.example.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `checkTimes` | `["10:05"]` | 每日检查时间（北京时间），可写多个 |
| `regions` | `["cn","global"]` | 参与的区域 |
| `windowRetry` | `{enabled,max:6,gapMs:600000}` | 10 点窗口内的有限重试 |
| `retry` | `{maxAttempts:3,...}` | 请求级退避重试（仅瞬时错误） |
| `verifyDelayMs` | `2000` | 领取后等待多久回读额度 |
| `clientExe` | `{}` | 客户端路径，用于读取版本与定位 UMID 组件 |
| `umidPath` | `{}` | 显式指定 UMID 组件路径 |
| `allowUmidDownload` | `false` | 保留项：本实现**不**自动下载组件 |

环境变量见 [.env.example](.env.example)：`QODER_TOKENS`、`QODER_GLOBAL_TOKENS`、
`QODERCN_RUNTIME_INFO`、`QODER_RUNTIME_INFO`、`QODER_CHECKIN_DATA_DIR` 等。

### 6.7 Qoder 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `未找到 Qoder CN 的官方 UMID 组件（runtime-info）` | 没装对应客户端，或装在非默认目录 | 装客户端；或用 `QODERCN_RUNTIME_INFO` 指向 `resources/umid/runtime-info.exe` |
| `未发现可领取的每日活动` | 未到 10:00 窗口 / 已领过 / 缺设备身份 | 看诊断里的活动行；确认设备身份可用 |
| `领取被阻塞：同一设备身份下的其他账号已领取` | 同机多账号共用一个设备身份 | 上游限制，只能换设备或换天 |
| `额度已耗尽（112 / pricingUrl）` | 账号额度用完 | 冷却 30 分钟，**不是**登录问题，不会触发续期 |
| `登录状态失效` + `刷新令牌已失效或与地区不符` | 令牌失效或区域选错 | 重新 `qoder:login`；确认 `--region` 与账号地区一致 |
| `授权超时或未完成` | 浏览器里没确认 | 重跑登录，打开打印出的链接 |

---

## 7. 安全设计

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

## 8. 测试

```bash
npm test          # 编译 + 运行全部 180 个用例（WorkBuddy 68 + Qoder 91 + 统一层 21）
npm run typecheck # 只做类型检查

# 只跑其中一层
node --test "dist/test/qoder-*.test.js"
node --test "dist/test/checkin-*.test.js"
node --test "dist/test/unified-*.test.js"
```

### 8.1 WorkBuddy：覆盖场景与需求清单对应关系

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

### 8.2 Qoder：覆盖场景

| 场景 | 测试用例 |
|---|---|
| Token 获取（国内版 / 国际版） | `授权链接与轮询地址按区域生成`、`轮询：200 带 token 即成功` |
| 授权失败 / 超时 | `轮询：业务码非 0 报错`、`登录超时返回可读错误` |
| Token 自动刷新 | `续期：普通 refresh token…`、`jrt- 前缀走 jobToken`、`401 给出重新登录` |
| 设备身份生成 | `真实 UMID 组件可生成本机设备身份（国内版 / 国际版）`、`两个区域的覆盖变量互不串用` |
| 组件缺失 | `找不到组件时返回尝试过的路径清单`、`组件调用失败时给出可读错误` |
| Campaign 查询 | `活动行归一化`、`国内版空表 → 最小头复取`、`国际版不做复取` |
| 可领取 / 已领取判断 | `挑选可领取的每日活动`、`只有已领取行时 target 为空` |
| Credits 领取 | `领取请求：POST 到 …/claim`、`领取判定矩阵` |
| 已领取幂等 | `领取返回 409 ALREADY_CLAIMED → already`、`--force` + `replayed` |
| 额度 / 鉴权分流 | `额度类 403 不算登录失效`、`额度类 403 不触发续期` |
| 网络异常重试 | `网络异常：重试后返回失败，不伪造结果` |
| 多账号独立执行 | `多账号：一个失败不影响另一个` |
| 重复签到保护 | `重复运行：同一天只会真正领取一次`、`并发同一账号` |
| 定时任务 | `runForever：到点执行一次`、`启动补偿`、`已完成则不请求` |
| 区域隔离 | `区域隔离：国内版只请求 .cn，国际版只请求 .sh` |

### 8.3 统一入口：覆盖场景

| 场景 | 测试用例 |
|---|---|
| 顺序执行三个平台 | `按顺序执行三个平台并汇总` |
| 单平台异常隔离 | `单平台抛错不影响其它平台` |
| 单平台超时 | `超时：该平台记为 error，后续平台继续执行` |
| 今日已完成跳过 | `今日已完成 → 跳过且不调用平台` |
| 强制/模拟覆盖跳过 | `--force / --dry-run 时即使今日已完成也要执行` |
| 平台筛选 | `--platform 只跑指定平台`、`parsePlatformSelector：别名与非法值` |
| 汇总与退出码 | `汇总把各平台失败账号数相加`、`退出码：全部完成 0 / 部分 1 / 失败或异常 2` |
| 调度 | `allDone 只统计有账号的平台`、`shouldCatchUp`、`runForever 启动补偿` |
| 区域归属 | `Qoder 适配器国内版只看 cn 账号`、`某区域无账号时 hasAccounts=false` |
| 单实例互斥 | `pid 文件：写入 / 存活探测 / 清理 / 陈旧 pid` |

测试全部使用可编程 `fetch` 与假适配器，**不接触真实账号**，也不会发出任何真实领取请求。
唯一的真实调用是设备身份的组件执行（仅在装了对应客户端时运行，且是只读的本地进程）。

---

## 9. 已实现 / 未实现

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
- [x] 68 个 WorkBuddy 自动化测试

Qoder（新增）：

- [x] 设备码授权登录（PKCE S256），浏览器确认一次即可，免每日重登
- [x] 令牌自动续期（deviceToken / jobToken 两条路径），轮换后立即落盘
- [x] 官方 UMID 组件调用的设备身份，国内版 env=0 / 国际版 env=3，严格分区域
- [x] 活动列表查询（含国内版空表的最小头复取）
- [x] 每日活动识别 + Pro 升级包排除
- [x] 领取与结果判定（claimed / already / blocked / error 四态）
- [x] 额度回读验证到账（`/api/v2/quota/usage`）
- [x] 额度类 403（112/110）与鉴权失效分流，前者不触发续期
- [x] 三源账号（登录 / 手工导入 / 环境变量）+ 区域隔离去重
- [x] 10 点窗口内有限重试，窗口外不重试
- [x] 每日调度 + 启动补偿 + `--force` + 幂等（进程内 / 本地记录 / 服务端 replayed）
- [x] 8 个 Qoder CLI 命令 + JSON 输出 + 脱敏日志
- [x] 91 个 Qoder 自动化测试

统一入口（新增）：

- [x] 一条命令 `npm run signin` 依次执行三个平台
- [x] `signin:status` / `signin:dry-run` / `signin:daemon` 三个配套入口
- [x] 平台适配器契约：新增平台只需实现 4 个成员，不改编排层
- [x] 单平台超时（默认 20 分钟）与异常隔离，一个平台挂了不影响其它
- [x] 今日已完成整平台跳过（零网络请求）
- [x] `--platform` 任意组合筛选、`--json` 机器可读、退出码区分 0/1/2/3
- [x] 双向 pid 互斥：统一调度与平台 daemon 不会同时运行
- [x] 21 个统一层自动化测试

### 未实现 / 待验证

- [x] **签到成功（`code=0`）的响应结构** —— 已实测（2026-11-03 00:00 北京时间）：
      `HTTP 200 {"code":0,"msg":"OK"}`，积分 8703.09 → 8803.09（+100），`verification=credits-delta`。
      响应体**不含**奖励明细，奖励只能靠领取前后积分差额确认；本实现已按此实现双重判定。
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

Qoder 相关：

- [ ] **真实账号的完整领取链路** —— 待验证。本机已确认两区域 UMID 组件可用、授权端点可达，
      但没有 Qoder 令牌，未发起带凭据的真实请求。执行 `npm run qoder:login` 后可自行验证。
- [ ] **国际版实机签到** —— 组件与端点已验证，账号登录后的链路未跑。
- [ ] **Pro 升级包领取** —— 不实现。参考实现会额外探测并领取一次性 Pro 包，与"每日积分"无关，
      且会引入额外请求。需要时可参照 `docs/02-qoder.md` 自行扩展。
- [ ] **UMID 组件自动下载** —— 不实现。参考实现会从 npm 提取并校验 sha512；
      本实现只使用本机客户端自带组件，避免额外联网与写文件（配置项 `allowUmidDownload` 为保留位）。
- [ ] 推送通知（PushPlus / Bark / 企微 / 钉钉）—— 不实现，本项目只做本地日志。

---

## 10. WorkBuddy 常见问题

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

## 11. 免责声明

本模块仅在本机复用你**自己已登录的账号权限**执行官方客户端本身提供的签到功能，
不修改客户端、不绕过任何验证、不上传任何数据。
接口属于官方私有接口，可能随客户端版本变化而失效；失效时本模块会停止领取并给出诊断，不会猜测实现。

请遵守 WorkBuddy / CodeBuddy 的服务条款。因使用本工具产生的任何后果由使用者自行承担。
