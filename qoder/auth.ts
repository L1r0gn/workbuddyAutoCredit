/**
 * 认证层：设备码授权登录（PKCE）+ 令牌续期。
 *
 * 协议来源（Qoder-Daily `qoder_login.py` / `qoder_daily.py`，本机核对）：
 *   1. 生成 code_verifier（32 字节随机 → base64url），challenge = base64url(sha256(verifier))
 *   2. 打开 {web}/device/selectAccounts?challenge&challenge_method=S256&machine_id&nonce
 *   3. 轮询 {openapi}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256
 *      202 / 404 表示等待用户确认；200 且带 token 表示授权完成
 *   4. 续期 POST {openapi}/api/v1/deviceToken/refresh
 *      （refresh 以 jrt- 开头时改走 /api/v1/jobToken/refresh）
 *
 * 安全：令牌只在内存与 0600 的本机存储之间流转，绝不写日志、不上传第三方。
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import { REGIONS } from './config';
import { redactText } from '../checkin/logger';
import type { QoderRegion, QoderTokens } from './types';

const AUTH_POLL_PATH = '/api/v1/deviceToken/poll';
const DEVICE_REFRESH_PATH = '/api/v1/deviceToken/refresh';
const JOB_REFRESH_PATH = '/api/v1/jobToken/refresh';
const DEVICE_LOGIN_PATH = '/device/selectAccounts';
const POLL_HEADERS = {
  'Cosy-Version': '1.0.1',
  'Cosy-ClientType': '5',
  'User-Agent': 'qoder-local-proxy',
};

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export interface DeviceLoginHandle {
  region: QoderRegion;
  authUrl: string;
  pollUrl: string;
  verifier: string;
  nonce: string;
  createdAt: number;
}

/** 第一步：生成授权链接与轮询地址。 */
export function startDeviceLogin(region: QoderRegion, machineId: string): DeviceLoginHandle {
  const profile = REGIONS[region];
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const authUrl = `${profile.web}${DEVICE_LOGIN_PATH}?${new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    machine_id: machineId,
    nonce,
  }).toString()}`;
  const pollUrl = `${profile.base}${AUTH_POLL_PATH}?${new URLSearchParams({
    nonce,
    verifier,
    challenge_method: 'S256',
  }).toString()}`;
  return { region, authUrl, pollUrl, verifier, nonce, createdAt: Date.now() };
}

export interface PollOutcome {
  status: 'pending' | 'success' | 'error';
  tokens?: QoderTokens;
  uid?: string;
  error?: string;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/** 轮询一次。 */
export async function pollDeviceLoginOnce(
  handle: DeviceLoginHandle,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PollOutcome> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(handle.pollUrl, {
      method: 'GET',
      headers: POLL_HEADERS,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
    });
  } catch (error) {
    return { status: 'error', error: `授权轮询请求失败：${redactText(error, 160)}` };
  }
  if (response.status === 202 || response.status === 404) return { status: 'pending' };

  let payload: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (response.status >= 400) {
    const message = firstText(payload.message, payload.errorMessage, payload.msg);
    return {
      status: 'error',
      error: `授权轮询失败（HTTP ${response.status}）${message ? `：${message}` : ''}`,
    };
  }

  const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
  const token = firstText(data.token, data.access_token, data.device_token);
  if (!token) {
    const code = payload.code;
    if (code !== undefined && code !== null && code !== 0 && code !== '0') {
      return { status: 'error', error: `授权失败（code=${String(code)}）：${firstText(payload.msg, payload.message)}` };
    }
    return { status: 'pending' };
  }
  return {
    status: 'success',
    tokens: {
      access: token,
      refresh: firstText(data.refresh_token, data.refreshToken),
      updatedAt: Date.now(),
    },
    uid: firstText(data.user_id, data.userId),
  };
}

/**
 * 各平台的"用默认浏览器打开"启动计划（按可靠性排序）。
 *
 * Windows 原先用 `explorer.exe <url>`，它走的是资源管理器的路径解析：
 * 授权链接带 `&`、`%` 等字符时会被当成文件夹路径，结果弹出**文件管理器**而不是浏览器。
 * 现在优先 `rundll32 url.dll,FileProtocolHandler`（等价 ShellExecute 走协议处理器），
 * 其次 PowerShell 的 Start-Process，最后才退回 explorer。
 */
export function browserLaunchPlan(
  platform: NodeJS.Platform,
  url: string,
): Array<{ method: string; command: string; args: string[] }> {
  if (platform === 'win32') {
    return [
      { method: 'rundll32', command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
      {
        method: 'powershell',
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`],
      },
      { method: 'explorer', command: 'explorer.exe', args: [url] },
    ];
  }
  if (platform === 'darwin') {
    return [{ method: 'open', command: 'open', args: [url] }];
  }
  return [
    { method: 'xdg-open', command: 'xdg-open', args: [url] },
    { method: 'gio', command: 'gio', args: ['open', url] },
  ];
}

export interface OpenResult {
  opened: boolean;
  /** 实际生效的启动方式 */
  method: string | null;
  /** 全部尝试都失败时的原因（已脱敏） */
  error: string | null;
}

/** 启动一个进程并等待它真的被系统接受（GUI 程序不会回报是否成功弹窗）。 */
function launchOnce(command: string, args: string[], timeoutMs = 800): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { ok: boolean; error: string | null }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (error) {
      return done({ ok: false, error: redactText(error, 120) });
    }
    child.once('spawn', () => {
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      done({ ok: true, error: null });
    });
    child.once('error', (error) => {
      done({ ok: false, error: redactText(error, 120) });
    });
    const timer = setTimeout(() => {
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      // 超时未报错：命令已发出，只是没有回执
      done({ ok: true, error: null });
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  });
}

/**
 * 在默认浏览器打开授权页。
 * 失败不致命：调用方必须始终把链接打印出来，让用户可以手动打开。
 */
export async function openInBrowser(
  url: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<OpenResult> {
  const env = options.env || process.env;
  if (String(env.QODER_LOGIN_NO_BROWSER || '').trim() === '1') {
    return { opened: false, method: null, error: '已通过 QODER_LOGIN_NO_BROWSER=1 禁用自动打开' };
  }
  const errors: string[] = [];
  for (const attempt of browserLaunchPlan(options.platform || process.platform, url)) {
    const result = await launchOnce(attempt.command, attempt.args);
    if (result.ok) return { opened: true, method: attempt.method, error: null };
    errors.push(`${attempt.method}: ${result.error || '启动失败'}`);
  }
  return { opened: false, method: null, error: errors.join('；') || '没有可用的启动方式' };
}

export interface LoginOptions {
  fetchImpl?: typeof fetch;
  /** 总超时（毫秒），默认 300 秒，与上游一致 */
  timeoutMs?: number;
  intervalMs?: number;
  /** 测试注入 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (attempt: number) => void;
  /** 拿到授权链接后的回调（必须在轮询之前调用，保证用户总能看到链接） */
  onAuthUrl?: (url: string) => void;
  /** 自定义"打开浏览器"实现；返回 false 表示没能打开，但不影响登录继续等待 */
  openBrowser?: (url: string) => boolean | OpenResult | Promise<boolean | OpenResult>;
}

export interface DeviceLoginResult {
  ok: boolean;
  tokens?: QoderTokens;
  uid?: string;
  error?: string;
  authUrl: string;
  /** 是否成功唤起浏览器 */
  browserOpened: boolean;
  browserError: string | null;
}

/**
 * 完整设备码登录：打印/打开授权页 → 轮询直到用户确认或超时。
 * 不处理验证码 / MFA —— 授权页由用户自己在浏览器完成。
 */
export async function loginWithDeviceFlow(
  region: QoderRegion,
  machineId: string,
  options: LoginOptions = {},
): Promise<DeviceLoginResult> {
  const handle = startDeviceLogin(region, machineId);
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const opener = options.openBrowser || openInBrowser;

  // 先回调链接（调用方负责打印），再尝试唤起浏览器：
  // 即使唤起失败，用户手里也已经有链接可用。
  options.onAuthUrl?.(handle.authUrl);

  let browserOpened = false;
  let browserError: string | null = null;
  try {
    const raw = await opener(handle.authUrl);
    if (typeof raw === 'boolean') {
      browserOpened = raw;
      if (!raw) browserError = '浏览器未能自动打开';
    } else {
      browserOpened = raw.opened;
      browserError = raw.error;
    }
  } catch (error) {
    browserOpened = false;
    browserError = redactText(error, 160);
  }

  const deadline = now() + (options.timeoutMs ?? 300_000);
  const interval = options.intervalMs ?? 2000;
  let attempt = 0;
  while (now() < deadline) {
    await sleep(interval);
    attempt += 1;
    options.onPoll?.(attempt);
    const outcome = await pollDeviceLoginOnce(handle, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (outcome.status === 'success' && outcome.tokens) {
      return { ok: true, tokens: outcome.tokens, uid: outcome.uid, authUrl: handle.authUrl, browserOpened, browserError };
    }
    if (outcome.status === 'error') {
      return { ok: false, error: outcome.error, authUrl: handle.authUrl, browserOpened, browserError };
    }
  }
  return {
    ok: false,
    error: '授权超时或未完成，请重新运行',
    authUrl: handle.authUrl,
    browserOpened,
    browserError,
  };
}

/** 令牌是否明显过期（Qoder 令牌是 dt-/jt- 前缀的不透明串，无 exp 可解，只能靠服务端判定）。 */
export function looksLikeAccessToken(value: string): boolean {
  const token = String(value || '').trim();
  if (!token) return false;
  return token.startsWith('dt-') || token.startsWith('jt-') || token.startsWith('eyJ') || token.length > 40;
}

export interface RefreshOutcome {
  ok: boolean;
  tokens: QoderTokens;
  error: string | null;
}

/**
 * 续期。
 * 注意：上游可能轮换 refresh_token，调用方必须把返回值落盘（store.updateTokens）。
 */
export async function refreshTokens(
  region: QoderRegion,
  tokens: QoderTokens,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<RefreshOutcome> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const refresh = String(tokens.refresh || '').trim();
  if (!refresh) return { ok: false, tokens, error: '账号没有 refresh_token，无法续期' };

  const path = refresh.startsWith('jrt-') ? JOB_REFRESH_PATH : DEVICE_REFRESH_PATH;
  const url = `${REGIONS[region].base}${path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'User-Agent': 'qoder-local-proxy', 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
    });
  } catch (error) {
    return { ok: false, tokens, error: `续期请求失败：${redactText(error, 160)}` };
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, tokens, error: '刷新令牌已失效或与地区不符，请重新登录' };
  }
  if (!response.ok) {
    return { ok: false, tokens, error: `续期失败（HTTP ${response.status}）${firstText(payload.message, payload.msg) ? `：${firstText(payload.message, payload.msg)}` : ''}` };
  }

  const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
  const access = firstText(data.device_token, data.deviceToken, data.token, data.access_token);
  if (!access) {
    return { ok: false, tokens, error: `续期响应缺少 access token（HTTP ${response.status}）` };
  }
  return {
    ok: true,
    tokens: {
      access,
      refresh: firstText(data.refresh_token, data.refreshToken) || refresh,
      updatedAt: (options.now || Date.now)(),
    },
    error: null,
  };
}
