# Qoder 签到实现说明（源码依据 + 本机实测）

> 参考项目：[L0NE-6/Qoder-Daily](https://github.com/L0NE-6/Qoder-Daily)（`qoder_daily.py` 1249 行 / `qoder_login.py` 265 行，逐行阅读）  
> 本机环境：Qoder 0.4.11（`F:\Qoder`）、Qoder CN 0.4.11/0.4.4（`F:\Qoder CN`），均未在代码中硬编码  
> 结论全部来自源码 + 本机核对；无法确认的部分在第 8 节明确标注。

---

## 1. 一句话结论

Qoder 的"每日签到"**不是**签到接口，而是**活动领取**：

```
GET  /sash/api/v1/me/campaigns                      拉活动列表（必须带官方设备身份头）
  → 找 actionType=CLAIM_BENEFIT 且 claimStatus=CLAIMABLE 的每日活动
POST /sash/api/v1/me/campaigns/{campaignId}/claim   body {}  领取
  → status=CLAIMED / replayed / 409 ALREADY_CLAIMED 都表示"今天已经拿到"
```

它与 WorkBuddy 的差别是结构性的：

|      | WorkBuddy       | Qoder                                                             |
| ---- | --------------- | ----------------------------------------------------------------- |
| 机制   | 固定签到接口          | 活动（campaign）列表 + 领取                                               |
| 幂等   | 服务端按天去重，`10001` | `replayed` 标志、`409 ALREADY_CLAIMED`、`SAME_PERSON_ALREADY_CLAIMED` |
| 前置条件 | 仅需令牌            | 令牌 **+ 官方设备风控身份（UMID）**                                           |
| 状态查询 | 无独立接口           | 无独立接口（活动行 `claimStatus` 即状态）                                      |
| 时间窗口 | 无               | 每天 10:00（UTC+8）开窗，可能延迟下发                                          |



---

## 2. 区域常量（两个版本必须严格隔离）

|                | Qoder CN（国内版）                  | Qoder（国际版）                 |
| -------------- | ------------------------------ | -------------------------- |
| 接口基址           | `https://openapi.qoder.com.cn` | `https://openapi.qoder.sh` |
| 授权页            | `https://qoder.com.cn`         | `https://qoder.com`        |
| UMID 环境号       | `0`                            | `3`                        |
| 组件覆盖变量         | `QODERCN_RUNTIME_INFO`         | `QODER_RUNTIME_INFO`       |
| 官方 npm 包（组件来源） | `@qodercn-ai/qoderclicn`       | `@qoder-ai/qodercli`       |
| CLI 配置目录       | `~/.qoder-cn`                  | `~/.qoder`                 |

|                                                            |                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| 代码中 \`type QoderRegion = 'cn'                              | 'global'\`，API 基址、UMID 环境号、组件查找路径、令牌存储全部由 region 派生， |
| 并且**账号主键带 region 前缀**（`cn:uid` / `global:uid`），从数据结构上杜绝串区。 |                                                      |

---

## 3. 认证：设备码 + PKCE

来源：`qoder_login.py:121-161`、`qoder_daily.py:614-636`。

### 3.1 授权流程

```
1) verifier  = base64url(random(32))            // code_verifier
   challenge = base64url(sha256(verifier))      // S256
   nonce     = uuid4().hex
   machine_id= 本机稳定标识（首次生成后持久化）

2) 浏览器打开
   {web}/device/selectAccounts?challenge=&challenge_method=S256&machine_id=&nonce=

3) 轮询（每 2 秒，最长 300 秒）
   GET {openapi}/api/v1/deviceToken/poll?nonce=&verifier=&challenge_method=S256
   headers: Cosy-Version: 1.0.1, Cosy-ClientType: 5, User-Agent: qoder-local-proxy
   → 202 / 404 = 等待用户确认
   → 200 + token/access_token/device_token = 成功（同时可能返回 refresh_token、user_id）
   → payload.code ∉ {0, null} = 失败
```

**不涉及密码、验证码、MFA**：授权在用户自己的浏览器里完成，程序只轮询结果。

**如何唤起浏览器**（本实现的取舍）：
- Windows：`rundll32 url.dll,FileProtocolHandler <url>`（等价 ShellExecute 走协议处理器），
  失败再试 PowerShell 的 `Start-Process`，最后才退回 `explorer.exe`。
  早期版本直接 `explorer.exe <url>`，而资源管理器会把带 `&` / `%` 的链接当作**路径**解析，
  实际弹出的是文件管理器 —— 这是已修复的缺陷。
- macOS 用 `open`，Linux 用 `xdg-open`（再兜底 `gio open`）。
- 无论唤起成功与否，**链接都会先打印到终端**；`--no-open` 或 `QODER_LOGIN_NO_BROWSER=1` 可完全禁用唤起。

### 3.2 续期

```
POST {openapi}/api/v1/deviceToken/refresh      body {"refresh_token": "..."}
  ↑ refresh 以 jrt- 开头时改走 /api/v1/jobToken/refresh
headers: User-Agent: qoder-local-proxy
→ data.device_token / deviceToken / token / access_token  为新的 access
→ data.refresh_token / refreshToken 可能被轮换
```

**关键约束**：续期会轮换 refresh token，必须立刻落盘（`qoder/store.ts:updateTokens`），否则下次运行会失效。  
本模块在每次续期成功后立即写回 `qoder-state.json`（0600）。

令牌形态：access `dt-…` / `jt-…`，refresh `drt-…` / `jrt-…`，均为**不透明串**，无法本地解析过期时间，  
因此过期检测以服务端信号为准（见 5.2）。

---

## 4. 设备身份（UMID）

这是 Qoder 与 WorkBuddy 最大的实现差异：**没有官方设备身份，活动根本不会下发**。

来源：`qoder_daily.py:229-592`。

### 4.1 协议

```
runtime-info <env> --account-stdin
  env    : 0 = 国内版，3 = 国际版
  stdin  : {"account":"<uid>"}\n
  stdout : {"machineToken":"...","machineCode":"...","machineType":"...","vmInfo":{...}}
```

三个输出对应请求头 `Cosy-MachineToken` / `Cosy-MachineCode` / `Cosy-MachineType`。  
组件是**官方 Electron 客户端自带的二进制**（`<安装目录>/resources/umid/runtime-info.exe`），  
本模块只读取并执行它，不修改、不打包、不上传其输出。

### 4.2 组件定位顺序（本模块实现）

1. 环境变量：`QODERCN_RUNTIME_INFO` / `QODER_RUNTIME_INFO`（或通用 `QODER_UMID_PATH`）
2. 配置文件 `qoder.config.json` 的 `umidPath[region]`
3. 客户端安装目录：`<exe 目录>/resources/umid/runtime-info[.exe]`，以及 `.qoder-versions/<ver>/resources/...`
4. CLI 运行时缓存：`~/.qoder-cn/.bin/umid-*/`（国内版）、`~/.qoder/.bin/umid-*/`（国际版）
5. 数据目录：`<dataDir>/umid/<region>/runtime-info[.exe]`

任一步命中即停止；全部未命中时返回**尝试过的路径清单**，而不是伪造身份。  
本模块**不自动从 npm 下载组件**（参考实现会；我们默认关闭 `allowUmidDownload`，避免额外的联网与写文件行为）。

### 4.3 身份缓存

`getRiskIdentity()` 按 `region + uid` 缓存 **50 分钟**（与上游一致），过期或被清除后重新调用组件。  
`machineToken` 有时效，**不落盘**；`machineId` / `machineOs` / `machineHostname` / `machineCode` / `machineType` 会写入账号记录便于排障。

### 4.4 本机实测

| 项目             | 结果                                                        |
| -------------- | --------------------------------------------------------- |
| 国内版组件          | `F:\Qoder CN\resources\umid\runtime-info.exe`（source=app） |
| 国际版组件          | `F:\Qoder\resources\umid\runtime-info.exe`（source=app）    |
| 国内版身份          | 成功：machineToken 88 字符 / machineCode 18 / machineType 18   |
| 国际版身份          | 成功                                                        |
| `machineOs`    | `x86_64_win32`                                            |
| `Cosy-Version` | 取自 `build-manifest.json` → 国内版 0.4.4、国际版 0.4.11           |

> 注：组件内部会尝试 `wmic` / `reg` / `sc` 读取硬件信息。本机沙箱拦截了这几个程序，组件仍能返回 machineToken，  
> 但 `vmInfo.brand` 等字段可能降级。在正常（非沙箱）环境下不受影响。这一点属于**环境限制，不是实现缺陷**。

---

## 5. 接口清单

### 5.1 请求头

```
authorization: Bearer <access>
cosy-clienttype: 10
accept: application/json
accept-language: zh-CN
user-agent: Qoder
Cosy-Version: <客户端版本>
Cosy-MachineOS: x86_64_win32
Cosy-MachineId: <本机稳定标识>
Cosy-MachineHostname: <主机名>
Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType: <UMID 输出>
```

领取请求额外带 `content-type: application/json` 与 `origin: {base}`。

国内版在「HTTP 200 且活动表为空」时会用**最小鉴权四件套**再取一次：  
`authorization + cosy-clienttype + user-agent + content-type`（`qoder_daily.py:604-611, 703-716`）。  
国际版不做这个降级（`test_campaign_core.py:190-225` 明确固定了该行为）。

### 5.2 端点与语义

| 端点                                      | 方法   | 说明                                   |
| --------------------------------------- | ---- | ------------------------------------ |
| `/sash/api/v1/me/campaigns`             | GET  | 活动列表；**不带 `forceRefresh`**（官方客户端不发送） |
| `/sash/api/v1/me/campaigns/{id}/claim`  | POST | 领取，body `{}`                         |
| `/sash/api/v1/me/campaigns/{id}/reward` | GET  | 只读读取面值（本模块仅用于可选诊断）                   |
| `/api/v2/quota/usage`                   | GET  | 额度，用于领取前后核对                          |

活动行关键字段：`campaignId`/`id`、`campaignKey`、`actionType`（`CLAIM_BENEFIT`）、  
`claimStatus`（`CLAIMABLE` / `CLAIMED`）、`benefit.kind`（`CREDITS`）、`benefit.amount`。

### 5.3 领取结果判定矩阵（与上游测试用例逐条对齐）

| 响应                                                           | 判定                 | 是否算今日完成 |
| ------------------------------------------------------------ | ------------------ | ------- |
| `status ∈ {CLAIMED, GRANTED, SUCCESS}`，无 `replayed`          | `claimed`          | ✅       |
| `status=CLAIMED` + `replayed: true`                          | `already`          | ✅       |
| `result` 含 `ALREADY` / `REPLAYED`                            | `already`          | ✅       |
| HTTP 409 + `errorCode` 含 `ALREADY` / `REPLAYED`              | `already`          | ✅       |
| HTTP 409 + 其它冲突码                                             | `error`            | ❌       |
| `status=BLOCKED` 或 `failureCode=SAME_PERSON_ALREADY_CLAIMED` | `blocked`          | ❌       |
| `failureCode=REDEMPTION_CODE_OUT_OF_STOCK` 等已知失败码            | `error`（附可读文案）     | ❌       |
| HTTP 2xx 但无上述成功状态                                            | `error`（"上游未确认成功"） | ❌       |

### 5.4 鉴权错误 vs 额度错误

两者都可能是 401/403，必须分流（`qoder_daily.py:639-680`）：

| 特征                                          | 含义       | 处理                      |
| ------------------------------------------- | -------- | ----------------------- |
| `code=112` 或响应含 `pricingUrl`                | 额度耗尽     | 冷却 30 分钟，**不续期**        |
| `code=110` 或 `Billing daily count exceeded` | 当日计费次数上限 | 冷却至本地零点（60s–6h），**不续期** |
| 其它 401/403                                  | 会话失效     | 续期一次 → 重试一次             |
| body `code=105` / `10019901001`（HTTP 200）   | 会话失效     | 续期一次 → 重试一次             |

> 这一条在实现时踩过坑：最初的续期条件写成 `httpStatus === 403`，  
> 导致额度类 403 也去轮换 refresh token。已由测试 `额度类 403：标记 quota-exhausted，不触发续期` 锁定。

---

## 6. 每日窗口与重试

- 官方窗口：**每天北京时间 10:00 开启**，上游可能延迟到 11:00 前才下发活动。
- 参考实现策略：窗口内（`hour == 10`）若既无 `CLAIMABLE` 也无 `CLAIMED` 行，则每 600 秒重取一次，最多 6 次  
  （`QODER_WINDOW_RETRY_MAX` / `QODER_WINDOW_RETRY_GAP` 可调）。
- 本模块：同一策略，默认 `{enabled:true, max:6, gapMs:600000}`，可在 `qoder.config.json` 调整；  
  **窗口外不重试**（测试 `窗口外不重试` 锁定），因此不会出现"无限请求"。
- 调度层默认 10:05 触发（`checkTimes` 可配多个），启动时若已过点且未完成会补一次。

---

## 7. 本模块结构

```
qoder/
├── types.ts     区域、账号、活动行、记录类型
├── config.ts    区域常量、安装目录/UMID 定位、客户端版本、配置加载
├── store.ts     账号 + 令牌 + 记录（原子写 0600，轮换即写回）
├── accounts.ts  环境变量导入、账号筛选、脱敏摘要
├── auth.ts      设备码登录（PKCE）、轮询、续期
├── device.ts    UMID 组件调用、machineOs/hostname、50 分钟缓存
├── api.ts       请求头组装、campaigns/claim/reward/quota、结果判定、错误分流
├── campaign.ts  每日活动识别、Pro 排除、窗口判定（纯函数）
├── service.ts   单账号闭环 + 多账号批处理 + 幂等
├── scheduler.ts 每日调度 + 启动补偿 + pid 文件
├── cli.ts       login / accounts / status / run / all / dry-run / refresh / daemon
└── index.ts     装配与对外导出
```

复用的既有能力（未改动其行为）：  
`checkin/logger.ts`（脱敏与 JSONL）、`checkin/client.ts`（超时/重试/不跟随重定向）、  
`checkin/scheduler.ts` 的 `nextSlotAt` / `zonedParts`（时区计算）、`checkin/config.ts` 的数据目录。

---

## 8. 已验证 / 待验证

### 已在本机验证（不消耗签到机会）

| 项目                      | 证据                                             |
| ----------------------- | ---------------------------------------------- |
| 两区域 UMID 组件各自定位成功       | `findUmidComponent` → app 来源，路径互不相同            |
| 设备身份可生成                 | 两区域 `getRiskIdentity` 均返回三件套                   |
| 客户端版本读取                 | 国内版 0.4.4 / 国际版 0.4.11（来自 build-manifest）      |
| 授权端点可达                  | 两区域 poll 均返回 `pending`（202/404），说明 URL 与参数结构正确 |
| 判定矩阵 / 错误分流 / 区域隔离 / 幂等 | 91 个自动化测试（全部 mock fetch）                       |

### 仍待真实账号验证（需要你授权一次真实领取）

1. **真实 `campaigns` 响应结构**：本机没有 Qoder 令牌，未发起带凭据的真实请求。  
   当前解析兼容 `payload.campaigns` 与 `payload.data.campaigns`，字段名来自参考实现源码与测试。
2. **真实 `claim` 成功响应**：`status=CLAIMED` 之外的字段（`benefit.validity.days` 等）参考实现只做展示，本模块不依赖。
3. **额度增量验证**：`/api/v2/quota/usage` 的字段集合在各套餐下可能不同；本模块对未知结构返回 `null` 而不是 0。
4. **国际版实机**：组件与端点已验证，账号登录后的完整链路未跑。

> 需要真实验证时，执行 `npm run qoder:login -- --region cn` 授权一次，然后 `npm run qoder:status`  
> 与 `npm run qoder:dry-run`（只读，不领取）。真实领取必须由你显式执行 `npm run qoder:run`。

---

## 9. 与参考实现的取舍

| 维度      | Qoder-Daily             | 本模块                                      | 原因                         |
| ------- | ----------------------- | ---------------------------------------- | -------------------------- |
| 令牌来源    | 环境变量 + 本地 json（按令牌指纹索引） | 设备码登录 + 环境变量 + 手工导入，存 `qoder-state.json` | 免去每天手工搬运令牌                 |
| 组件自动下载  | 会从 npm 提取（sha512 校验）    | 默认关闭，仅定位                                 | 减少写盘与联网面；需要时可用配置开启（未实现下载器） |
| Pro 升级包 | 会尝试领取一次性 Pro 包          | **不实现**                                  | 与"每日积分"无关，且需额外探测请求         |
| 推送      | 多通道推送                   | 不实现                                      | 本项目只做本地日志                  |
| 额度回读    | 仅 Pro 用                 | 每日领取也回读，用于验证到账                           | 满足"验证领取结果"要求               |
| 重试      | 3 次请求重试 + 窗口重试          | 相同，并区分瞬时/永久错误                            | 更保守                        |
| 设备身份    | 支持三件套环境变量覆盖             | 相同                                       | 兼容高级用户                     |
