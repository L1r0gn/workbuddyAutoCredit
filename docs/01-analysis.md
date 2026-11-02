# WorkDaddy「WorkBuddy 每日积分自动签到」源码分析报告

> 分析对象：`https://github.com/babygoton/WorkDaddy`（main 分支，commit `2fd29e4`，AGPL-3.0）
> 分析方式：完整阅读 `scripts/` 下 68 个 JS 文件中对签到链路有实际影响的部分，
> **全部结论以源码为唯一依据**，并在本机真实账号上逐条核对（核对结果见第 5 节）。
> 术语：文中"参考实现"指 WorkDaddy，"本实现"指本仓库 `checkin/` 模块。

---

## 1. 结论摘要

参考实现的签到并不是"模拟点击签到按钮"，也不是"只用本地缓存假装签到"，而是：

```
读取本机登录凭据（可能被 AES-256-GCM 信封加密）
   → 用客户端自己的 Electron 私有绑定派生解密密钥
   → 拿到 accessToken
   → POST https://<令牌签发域>/billing/meter/daily-checkin   body: {}
   → 用 code / msg 判定结果（code=0 成功；code=10001 + "已签到"= 今日已完成）
   → 写 JSON 缓存 + SQLite 记录（profile_id, uid, date 唯一）
   → 当天再次运行直接跳过，不发请求
```

**七个关键事实**（每一项都在源码中有明确出处）：

| # | 事实 | 源码位置 |
|---|---|---|
| 1 | 领取接口是 `POST /billing/meter/daily-checkin`，请求体为 `{}` | `scripts/checkin-result.js:5`、`scripts/daemon.js:4495-4540` |
| 2 | **不存在**"仅查询签到状态"的 GET 接口；状态由"本地记录 + 领取响应"共同判定 | 全仓库仅 `checkin-result.js:5` 出现该路径，无 GET 调用 |
| 3 | 成功判定必须 `code === 0` 且 HTTP 正常；`code=10001` 只有文案明确表示"已签到"才算完成 | `scripts/checkin-result.js:25-32` |
| 4 | 凭据来自本机官方登录文件，加密时用 `ELECTRON_RUN_AS_NODE=1` 启动客户端读取私有绑定派生密钥 | `scripts/lib.js:48-61, 174-199` |
| 5 | 多账号靠"每个账号一份 `.info` 备份"，签到用各账号 token **不切换客户端** | `scripts/builtin/automations/daily-account-checkin.json:17-19` |
| 6 | 积分查询是另一个接口：`POST /v2/billing/meter/get-user-resource` | `scripts/daemon.js:9713-9773` |
| 7 | 幂等有三层：内存 `checkinClaims`、JSON 缓存、SQLite 唯一键 | `scripts/daemon.js:4543-4551, 3579, 4562-4575` |

---

## 2. 参考项目结构定位

仓库根目录没有 `package.json`，是**纯 Node.js 脚本 + Electron 打包**的项目（`scripts/*.js` 通过 `require` 互相引用，`scripts/daemon.js` 712 KB 是本地 HTTP 服务主体）。

与签到相关的文件（按重要性排序）：

| 文件 | 作用 |
|---|---|
| `scripts/checkin-result.js` (60 行) | 签到接口路径常量、结果分类、令牌签发域解析 —— **整条链路的判定核心** |
| `scripts/daemon.js` | `dailyCheckin()` / `performAccountCheckin()` / `claimDailyForUid()` / `fetchResource()` / `fetchCredits()` / CDP 客户端 / 本地 HTTP API |
| `scripts/lib.js` | 凭据解密（`wdCompat*` 系列）、`listAccounts()`、平台路径 |
| `scripts/credit-resource-queries.js` | 积分查询请求体构造 |
| `scripts/credit-usage-store.js` | SQLite 存储（含 `daily_checkin_records` 表） |
| `scripts/token-refresh.js` | refresh token 换新 access token |
| `scripts/cdp-targets.js` | CDP target 归属判定与选页 |
| `scripts/profiles.js` | 四个客户端的凭据路径 / API 域名 / 能力开关 |
| `scripts/builtin/automations/daily-account-checkin.json` | 内置"循环账号静默签到"任务定义 |
| `scripts/automation.js` | 自动化引擎，`account.checkin` 操作的实现与文档 |
| `test/checkin-result.test.js` | 判定逻辑的官方测试（证明 10001 的语义） |

---

## 3. 关键技术链路

### 3.1 客户端发现与 CDP

参考实现用 CDP **只做两件事**：注入右下角面板 UI、感知登录/账号切换事件。
**签到本身不走 CDP**——它直接读本地凭据文件发 HTTP 请求。这一点非常关键，直接决定了本实现可以不强依赖 CDP。

**发现端点** `findCdpEndpoint()`（`daemon.js:2091-2129`）：

1. 候选端口：profile 绑定时为 `[CDP_PORT_HINT, 端口文件记录值]`；未绑定时为 `cdpPortCandidates()`（9222 起）。
2. 对每个端口并发 `GET /json/version` 与 `GET /json/list`（1.5 s 超时）。
3. 归属判定：`/workbuddy|codebuddy/i.test(version.Browser + User-Agent)`，且 `targets.some(isWorkBuddyCdpTarget)`。
4. Linux 例外：Electron 的 `Browser` 字段恒为 `Chrome/xxx`，因此额外接受"页面 URL 命中当前 profile 安装目录"作为归属证据（`targetsBelongToProfile`，`daemon.js:2138-2156`）。

**选页** `getPageTarget()`（`daemon.js:2164-2168`）→ `selectPageTarget()`（`cdp-targets.js:163-182`）：

- 先用 `isTargetForProfile()` 严格过滤（`cdp-targets.js:93-156`）：
  - Windows 官方安装目录：`/WorkBuddy/resources/app.asar`、`/WorkBuddyAI/resources/app.asar`
  - 登录域名：`workbuddy.ai` / `workbuddy.cn` / `codebuddy.cn` / `codebuddy.ai`
  - 自定义安装目录：`file:` 页面路径必须落在所选可执行文件目录内（`winPath.relative` 判定）
  - 无强信号时**禁止**只靠标题匹配（`cdp-targets.js:154`：只有显式 `WBSWITCH_PROFILE` 时才允许标题兜底）
- 再按窗口类型打分：`windowAppId=settings` = 20（最差），`accountSnapshot`/`locale=` = 0（最优），其它 = 10。

**连接** `connectCdp()`（`daemon.js:2291-2369`）：

```js
new WebSocket(target.webSocketDebuggerUrl)     // Node 22 全局 WebSocket，老版本回落内置 ws
ws.onopen = () => { cdpSend('Page.enable'); cdpSend('Network.enable'); cdpSend('Runtime.enable'); }
ws.onclose = () => { cdp.connected = false; }  // 注释：5 秒后重连（由外层循环驱动）
```

**命令发送** `cdpSend()`（`daemon.js:2260-2275`）：自增 `id` → `pending` Map 挂起 → 收到同 id 帧时 resolve/reject；若错误信息含 `inactive`（窗口失焦导致 lifecycle 非 active），先 `Page.setWebLifecycleState{state:'active'}` 再重试一次。

**Runtime.evaluate 的三种实际用法**：

| 用途 | 代码 |
|---|---|
| 页面就绪检查 | `cdpSend('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })`（`daemon.js:2376`、`3561`） |
| 注入面板 | 把 `inject.js` 全文作为表达式执行（`injectWidget()`，`daemon.js:4599+`） |
| 通知面板刷新 | `window.dispatchEvent(new CustomEvent('workdaddy:accounts-updated'))`（`daemon.js:4227`） |

> 注意：这些 `Runtime.evaluate` **不参与签到判定**，签到结果完全由 HTTP 响应决定。

**客户端重启带 CDP** `relaunchWorkBuddy()`（`daemon.js:3376-3452`）：
Windows/Linux 直接 `spawn(exe, ['--remote-debugging-port=<port>', '--inspect=...'])`，`windowsHide:false`（否则主窗口会隐藏启动）。**只加启动参数，不改安装文件**。

### 3.2 登录态与账号凭证

**凭据文件路径**（`profiles.js` + `platform.js`）：

```
Windows : %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
Windows : %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info
macOS   : ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/...
Linux   : $XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth/...
```

文件结构（明文形态）：

```jsonc
{
  "account": { "uid": "...", "nickname": "...", "phoneNumber": "...", "type": "..." },
  "auth": {
    "accessToken": "...",        // WorkBuddy 5.8+ 可能是 $wbEncrypted 信封
    "refreshToken": "...",
    "expiresAt": 1808196375817,  // 毫秒
    "refreshExpiresAt": ...,
    "lastRefreshTime": ...,
    "domain": "workbuddy.cn"
  },
  "accounts": [ ... ]
}
```

**加密信封与密钥派生**（`lib.js:40-61, 174-240`）——这是参考实现里最硬的一段逆向成果：

1. 信封形态：`{ "$wbEncrypted": 1, "envelope": "<base64 of JSON>" }`，
   内层 JSON 为 `{ suite: 1, keyId, nonce, authTag, ciphertext }`。
2. 密钥来源：以 `ELECTRON_RUN_AS_NODE=1` 启动 WorkBuddy 可执行文件执行同一份 `lib.js`，
   命中 `--wd-compat-print-key` 分支后调用 **Electron 私有绑定**：

   ```js
   const binding = process._linkedBinding('electron_browser_workbuddy_storage');
   const payload = JSON.parse(binding.loggerGet());
   const key = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
   process.stdout.write(`WD_COMPAT_KEY ${key.toString('base64')}\n`);
   ```

   密钥只走 stdout 管道，不落盘、不写日志。
3. 解密：`aes-256-gcm`，AAD 构帧（`lib.js:201-209`）：

   ```
   "WB-AAD\0" | 0x01 | lp("WBEV1") | lp("sym-v1") | u32(suite) | lp(keyId) | 0x02 | 0x00 | 0x00
   其中 lp(s) = u32be(byteLength) | utf8(s)
   ```

4. 失败语义：解密失败时保留原值、不抛错，UI 显示 `(已加密)`；取钥失败后 60 s 内不重试。

**令牌有效性 / 刷新**（`token-refresh.js`）：
`shouldRefreshAccessToken()` 在"过期或 24 h 内到期"时返回 true；刷新是
`POST {apiHost}/v2/plugin/auth/token/refresh`，refresh token 放在 **`X-Refresh-Token` 请求头**（不是 body），
body 为 `{}`，返回可能是 camelCase 或 snake_case，两者都要兼容（`token-refresh.js:38-99`）。
刷新成功后会**重新加密并写回账号备份文件**（`daemon.js:4374-4393`），因此必须"先确认能重新加密，再发刷新请求"（`daemon.js:4433-4442`），否则会丢失轮换后的 refresh token。

### 3.3 账号枚举与多账号

- 账号即"每 uid 一份备份文件"：`path.join(DATA_DIR, 'accounts', '<uid>.info')`（`daemon.js:7772-7778`，uid 需匹配 `^[A-Za-z0-9_-]{1,128}$`）。
- 枚举：`listAccounts(dataDir)`（`lib.js:1751-1806`）扫描 `*.info`，逐个解密取 `nickname / phone / uin / expiresAt`，按 `lastRefreshTime` 倒序。
- 备份来源：`backupAuthFile()`（`lib.js:1635`）在登录/刷新时把当前凭据复制进 accounts 目录；`backupCurrent()` 兜底扫描。
- **多账号签到不切换客户端**：内置任务显式写了 `"switch": false`（`daily-account-checkin.json:18`），
  因为 `account.checkin` 用的是"循环上下文账号的 token"，而不是当前登录态。

### 3.4 积分查询接口

`fetchCredits()`（`daemon.js:9915-9971`）按账号类型分流：

| 账号类型 | 接口 |
|---|---|
| 企业（`account.enterpriseId` 非空 或 `type ∈ ENTERPRISE_EDITIONS`） | `robustFetchEnterpriseResource()` → `get-enterprise-user-usage` |
| 个人 | `robustFetchResource(accessToken, buildCreditResourceBody(), 'all-resources')` |

个人账号请求（`daemon.js:9713-9729`）：

```
POST {PROFILE.apiHost}/v2/billing/meter/get-user-resource
headers: accept, content-type, x-client-platform: web, origin, referer: {host}/profile/plans-usage,
         authorization: Bearer <token>, user-agent: <Chrome UA>
body:    { PageNumber:1, PageSize:100, ProductCode:'p_tcaca', Status:[0,3],
           PackageEndTimeRangeBegin:'YYYY-MM-DD HH:mm:ss', PackageEndTimeRangeEnd:(now+101y) }
```

响应解析（`daemon.js:9746-9772`）按 `data.Response.Data.Accounts[]` 累加，
字段优先级 `CycleCapacityRemainPrecise > CycleCapacityRemain > CapacityRemainPrecise > CapacityRemain`
（原因写在注释里：月度包用完时 `CapacityRemainPrecise` 仍是满额，必须用周期剩余）。
`robustFetchResource()`（`daemon.js:9883-9906`）最多重试 3 次，但 `count===0` 与 401 行为不同：401 不重试而是抛带 `expired` 标记的错误。

### 3.5 每日签到（真正的领取动作）

`dailyCheckin(accessToken, account)`（`daemon.js:4495-4540`）——**唯一会改变服务端状态的函数**：

```js
const endpoints = checkinEndpointsForToken(accessToken, PROFILE);   // 见下
for (const url of endpoints) {
  const origin = new URL(url).origin;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-client-platform': 'web',
      origin,
      referer: origin + '/profile/plans-usage',
      authorization: 'Bearer ' + accessToken,
      'x-user-id': String(account.uid || ''),
      'x-domain': String(account.domain || ''),
      'user-agent': 'Mozilla/5.0 (Macintosh; ...) Chrome/151.0.0.0 Safari/537.36',
    },
    body: '{}',                                   // 空对象，无签名、无时间戳、无 nonce
    signal: AbortSignal.timeout(12000),
  });
  const classified = classifyCheckinResult({ httpOk: r.ok, code: o.code, message });
  // 兜底顺序：401 记下继续；4xx(非404) 或 2xx 直接返回；404 换下一个地址
}
```

**地址解析** `checkinEndpointsForToken()`（`checkin-result.js:47-57`）：

1. 解 JWT payload 的 `iss`，取 origin；
2. 只在白名单内映射（`ISSUER_HOST_MAP`，`checkin-result.js:6-11`）：`www.workbuddy.ai / www.workbuddy.cn / www.codebuddy.cn / www.codebuddy.ai` —— **防令牌外发到未知域**；
3. 命中则只用该域；未命中才回落到 `PROFILE.apiHost`，国内版再补 `www.codebuddy.cn`、`www.workbuddy.cn`；
4. 每个域尝试 `/billing/meter/daily-checkin` 和 `/v2/billing/meter/daily-checkin` 两个版本。

**结果判定** `classifyCheckinResult()`（`checkin-result.js:25-32`）：

```js
const inactive = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/i.test(text);
const already  = code === 10001 && !inactive && /已签到|已领取|已经.*(?:签到|领取)|重复签到|already/i.test(text);
const ok       = !inactive && ((code === 0 && httpOk) || already);
```

源码注释明确解释了为什么"只看 HTTP 200"不够：网关可能返回空或非 JSON 的 200。
官方测试 `test/checkin-result.test.js` 进一步固定了语义：

- `{httpOk:true, code:undefined, message:'OK'}` → **不是**成功
- `{httpOk:true, code:10001, message:'请求成功'}` → **不是**成功（10001 必须配"已签到"文案）
- `{httpOk:false, code:10001, message:'今天已签到，请明天再来'}` → **是**成功（真实场景：HTTP 400 + 10001）

### 3.6 幂等与状态缓存

单账号签到入口 `claimDailyForUid(uid)`（`daemon.js:4543-4551`）：

```js
const checkinClaims = new Map();                       // ① 进程内并发折叠
if (checkinClaims.has(uid)) return checkinClaims.get(uid);
const promise = performAccountCheckin(uid).finally(() => checkinClaims.delete(uid));
```

`performAccountCheckin(uid)`（`daemon.js:4553-4596`）的判定顺序：

1. **SQLite**：`CREDIT_USAGE_STORE.getDailyCheckin(uid, today)`，命中 `ok && verified` → 直接 `{skipped:true}`（不发请求）。
2. **JSON 缓存**：`DATA_DIR/checkin-cache.json`，命中且 `ok` → 返回 `skipped`，并**顺手把旧缓存迁移进 SQLite**（`daemon.js:4567-4575`）。
3. 取凭据：`refreshAccountBackupToken(uid)` → `wdCompatAuthToken(auth)`；缺失则 `{ok:false, reason:'no-accessToken'}`。
4. `dailyCheckin()` 发请求。
5. 写回缓存（`saveCheckinCache`，合并而非覆盖，避免并发任务互相踩掉）+ 成功时写 SQLite。

存储结构：

- JSON：`{ "<uid>": { date, ok, already, inactive, code, message, at, verified } }`（`daemon.js:4585-4587`）
- SQLite `daily_checkin_records`（`credit-usage-store.js:89-103`）：
  `PRIMARY KEY (profile_id, uid, checkin_date)`，字段 `checked_at / response_code / message`。
  读取时把 `response_code === 10001` 还原成 `already`（`credit-usage-store.js:286-295`）。

面板展示用 `checkinDisplayValue(record, today)`（`lib.js:568-571`）：只认 `record.date === today && record.ok`。

### 3.7 调度

签到以"内置自动化任务"的形式存在（`daily-account-checkin.json`）：

```json
"trigger": { "type": "clientLoaded", "types": ["clientLoaded","panelOpened"], "oncePerNavigation": true },
"schedule": { "type": "interval", "minutes": 60 },
"steps": [ { "op": "account.forEach", "accounts": "all", "switch": false,
             "steps": [ { "op": "logic.catch", "steps": [
               { "op": "account.checkin", "saveAs": "checkin" },
               { "op": "logic.if", "condition": {"left":"{{vars.checkin.skipped}}","operator":"falsy"},
                 "then": [{ "op": "logic.delay", "ms": 250 }] },
               { "op": "logic.assert", "condition": {"left":"{{vars.checkin.ok}}","operator":"truthy"},
                 "message": "该账号签到未成功，请检查登录状态或签到活动" } ] } ] } ]
```

要点：

- 触发 = 客户端加载/打开面板 + 每 60 分钟一次（**不是**固定 10:05）。
- `logic.catch` 包住单账号，保证一个账号失败不影响其它账号。
- 未 `skipped` 时延迟 250 ms 再处理下一个账号（限速）。
- `automation.js:977-983` 是 `account.checkin` 的执行体：
  ```js
  const account = ctx.account || await options.currentAccount();
  const result = await options.accountCheckin(account);   // = daemon 的 claimDailyForUid
  ```
- 调度表达式支持 `interval / daily / weekly / monthly / once`，**使用电脑本地时区**（`automation.js:180-185`），
  错过不补跑。
- 面板还有一个手动同步入口：`POST /api/accounts/checkin-sync`（`daemon.js:10809-10827`），仅允许当前账号，
  注释写明"官方签到接口是幂等的，对在 WorkDaddy 之外完成的签到会返回 already"。

### 3.8 日志与错误处理

- 运行日志：`appendRunLog()` 写入自动化运行日志（`daemon.js:4226` 记 `account:checkin:skipped|success|failed`）。
- 守护进程日志：`DATA_DIR/daemon.log`；`wd-compat` 前缀记录取钥/解密失败。
- 敏感信息：解密失败只记字段名（`wdCompatLog('解密失败 ' + k)`），`redactDiagnosticText()` 统一裁剪外部错误。
- 401 特判：刷新与积分都先判 401 再解析 JSON，避免把 HTML 登录页报成"解析失败"。
- 接口不兼容时：返回 `ok:false`，绝不把未知响应当成功（见 3.5 判定表）。

---

## 4. 调用关系

```
[触发]
  builtin/automations/daily-account-checkin.json
    └─ automation.js:977  account.checkin
         └─ daemon.js:4223  runDeps.accountCheckin
              └─ daemon.js:4544  claimDailyForUid(uid)
                   │  ├─ checkinClaims 并发折叠
                   │  └─ daemon.js:4553 performAccountCheckin(uid)
                   │        ├─ credit-usage-store.js:274 getDailyCheckin ──┐ 命中→ skipped
                   │        ├─ daemon.js:4261 loadCheckinCache ───────────┘ 命中→ skipped + 迁移
                   │        ├─ daemon.js:4365 refreshAccountBackupToken
                   │        │     └─ daemon.js:4395 performAccountTokenRefresh
                   │        │          └─ token-refresh.js:38 refreshAuthToken
                   │        ├─ lib.js:81  wdCompatAuthToken(auth)
                   │        ├─ daemon.js:4495 dailyCheckin(token, account)
                   │        │     ├─ checkin-result.js:47 checkinEndpointsForToken
                   │        │     └─ checkin-result.js:25 classifyCheckinResult
                   │        ├─ daemon.js:4268 saveCheckinCache
                   │        └─ credit-usage-store.js:325 saveDailyCheckin
                   └─ daemon.js:4226 appendRunLog

[凭据解密]
  lib.js:1751 listAccounts → lib.js:219 wdCompatDecryptAuthJson
    └─ lib.js:229 wdCompatOpenEnvelope(env, wdCompatStaticKey())
         └─ lib.js:174 wdCompatStaticKey
              └─ spawn(WorkBuddy.exe, [lib.js, '--wd-compat-print-key'], {ELECTRON_RUN_AS_NODE:'1'})
                   └─ process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()

[查询积分]
  daemon.js:9915 fetchCredits → daemon.js:9883 robustFetchResource → daemon.js:9713 fetchResource
    └─ POST /v2/billing/meter/get-user-resource  (body: credit-resource-queries.js:8)

[CDP（与签到解耦）]
  daemon.js:2291 connectCdp → daemon.js:2091 findCdpEndpoint → daemon.js:2164 getPageTarget
    └─ cdp-targets.js:163 selectPageTarget → cdp-targets.js:93 isTargetForProfile
```

---

## 5. 真实接口核对（本机实测）

测试账号：WorkBuddy 国内版，`uid 9b09…`，令牌签发域 `https://www.workbuddy.cn/auth/realms/copilot`。

| 项目 | 源码声明 | 本机实测 | 结论 |
|---|---|---|---|
| 凭据加密 | `auth.accessToken` 可能是 `$wbEncrypted` 信封 | 实际为信封（内层 `suite:1, keyId:"9127dea1b44020a7"`） | ✅ 一致 |
| 密钥派生 | `loggerGet()` → `atRestSecretKey` → SHA-256 | 成功取得 32 字节密钥，解密出合法 JWT | ✅ 可用 |
| 积分查询 | `POST /v2/billing/meter/get-user-resource` | `HTTP 200, code:0`，29 个 Account，合计 8717.55 | ✅ 一致 |
| 签到接口 | `POST /billing/meter/daily-checkin`，body `{}` | `HTTP 400, code:10001, msg:"今天已签到，请明天再来"` | ✅ 路径存在且语义一致 |
| 判定 | 400 + 10001 + "已签到" → 完成 | 按源码判定为 `ok:true, already:true` | ✅ 一致 |
| 幂等 | 重复请求不重复发放 | 签到前后积分均为 8710.56，`delta=0` | ✅ 一致 |
| 是否存在状态查询接口 | 无 | 全仓库搜索 `daily-checkin` 仅 1 处（`checkin-result.js:5`），无 GET | ⚠️ 确认"没有"，见 6.1 |

---

## 6. 未能确认的部分（明确标记为待验证，不猜测实现）

### 6.1 签到成功（code=0）时的响应体结构 —— 待验证

本机账号当天已签到，只能观测到 `10001` 分支。参考实现本身**也不解析成功响应的 `data`**
（`dailyCheckin` 只返回 `{...classified, status, url}`），说明其作者同样没有依赖成功响应的字段。
因此：

- 本实现的成功判定**只用 `code === 0`**，不读取 `data` 里的奖励字段；
- 若未来需要展示"本次奖励多少积分"，必须先在一个真正未签到的日子抓一次 `code=0` 响应，再落地解析；
- 本实现会把成功响应的 `data` 字段名记进诊断日志（不含值），便于下次验证时确认结构。

### 6.2 "查询当天签到状态"的官方 GET 接口 —— 不存在

需求里写的"查询当天签到状态"在参考实现中**没有对应接口**。它是这样实现的：

1. 先查本地已验证记录（SQLite → JSON 缓存），命中则不发请求；
2. 未命中就直接调用领取接口，由服务端返回 `code=0`（首次）或 `10001 + 已签到`（重复）。

即"状态查询"= 本地记录 + 幂等领取的返回值。本实现严格照此办理，**不编造任何状态查询地址**。

### 6.3 企业账号（enterprise）的签到行为 —— 未验证

`fetchCredits()` 有企业分支，但 `dailyCheckin()` 没有企业专属逻辑，即企业账号走同一个签到接口。
参考实现没有企业账号测试用例，本机也没有企业账号，故：**本实现保留同一路径，但不宣称对企业账号可用**，
失败时按 `unknown` 保守处理并输出诊断。

### 6.4 国际版账号 —— 代码路径就绪，未实测

`workbuddy-desktop-ai.info` 在本机确实存在且已加密，但本机**没有安装 WorkBuddy AI 客户端**，
无法派生解密密钥（密钥绑定在具体可执行文件里），因此本实现的国际版路径只做了代码与单测覆盖，
实测标记为待验证。这也是本实现把"取钥失败"做成可读诊断而不是抛异常的原因。

### 6.5 请求头是否全部必需 —— 部分未验证

`x-user-id`、`x-domain`、`user-agent` 三个头参考实现都带，但没有证据表明它们是必需的。
本实现保留 `x-user-id`/`x-domain`（都是本账号自身的真实值，不是伪造），
但**不使用伪装的 Chrome UA**，改为 Node 默认 UA —— 实测签到接口对这个差异不敏感（同样返回 10001）。

---

## 7. 参考实现的做法 vs 本实现的设计取舍

| 维度 | 参考实现 | 本实现 | 取舍理由 |
|---|---|---|---|
| 触发时间 | 每 60 分钟 + 客户端加载/打开面板 | 默认每天 10:05（可配多个时间点）+ 启动补偿 | 需求指定 10:05；补一次避免关机错过 |
| 时区 | 电脑本地时区 | `Asia/Shanghai` 显式计算（含跨天推算） | 需求指定 |
| 凭据写回 | 刷新后重新加密写回账号备份 | **只读官方文件**，刷新仅在内存生效且默认关闭 | 旋转 refresh token 可能让客户端掉登录 |
| 多账号 | 账号备份目录 + `account.forEach` | 官方文件 + 可选备份目录，按 uid 去重 | 不复制用户凭据，减少敏感面 |
| 状态存储 | JSON 缓存 + SQLite | 单个 JSON（原子写 + 跨进程锁） | 需求允许"JSON 或 SQLite"；单实现更易验证 |
| 成功判定 | code=0，或 10001+已签到文案 | 完全相同（实现更严格：另判 401/403） | 保守优先 |
| 接口失败 | 逐域名兜底 | 相同；额外区分 404/405 才换地址 | 避免把 401 当地址错误重试 |
| 加密凭据 | 支持 | 支持（自己实现解密，不调用参考项目代码） | 保证独立复现 |

---

## 8. 对"复现"边界的说明

- 本实现**没有**复制 WorkDaddy 的任何源代码；解密构帧、接口地址、判定规则属于"接口协议事实"，
  按 AGPL-3.0 项目的公开实现进行了独立重写，并在本机做了行为核对。
- 本实现**没有**包含：面板 UI 注入、账号切换、会话迁移、主题、自动化引擎等 WorkDaddy 的其它功能。
- 本实现**没有**：绕过登录、伪造设备指纹、关闭 TLS 校验、处理验证码/MFA、上传任何凭据。
