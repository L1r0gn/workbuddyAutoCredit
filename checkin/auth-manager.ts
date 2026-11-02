/**
 * 凭据层：读取官方登录文件、解密信封、判断令牌有效性。
 *
 * 安全设计：
 * 1. 只读官方文件。本模块从不写回 `workbuddy-desktop*.info`，避免破坏客户端登录态。
 * 2. 明文令牌只在进程内存中存在，不落盘、不进日志、不回显。
 * 3. 解密密钥通过客户端进程的私有绑定派生，不写文件、不缓存到磁盘。
 * 4. 令牌过期时默认不自作主张刷新（旋转 refresh token 可能让客户端掉登录），
 *    仅在显式开启 allowTokenRefresh 时于内存中换新。
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findWorkBuddyExe, PROFILES } from './config';
import { redactText } from './logger';
import type { ProfileId, WbAccountInfo, WbAuthCredentials } from './types';

/** 凭据文件里的加密信封标记。 */
interface WbEnvelope {
  $wbEncrypted: 1;
  envelope: string;
}

interface EnvelopeBody {
  suite: number;
  keyId: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

/** 解密后的凭据文件结构（只列出使用到的字段）。 */
export interface AuthFileContent {
  raw: Record<string, unknown>;
  account: WbAccountInfo | null;
  credentials: WbAuthCredentials | null;
  /** 解密失败/令牌缺失时的原因，便于诊断 */
  credentialError: string | null;
  /** 文件里出现过加密信封 */
  encrypted: boolean;
}

const KEY_CACHE_TTL_MS = 10 * 60 * 1000;
interface KeyCacheEntry {
  key: Buffer | null;
  at: number;
  error: string | null;
}
const keyCache = new Map<string, KeyCacheEntry>();

function isEnvelope(value: unknown): value is WbEnvelope {
  const v = value as Partial<WbEnvelope> | null;
  return !!v && typeof v === 'object' && v.$wbEncrypted === 1 && typeof v.envelope === 'string';
}

/**
 * 信封 AAD 的构帧方式（与客户端实现一致，已实机验证）：
 *   "WB-AAD\0" | 0x01 | lp("WBEV1") | lp("sym-v1") | u32(suite) | lp(keyId) | 0x02 | 0x00 | 0x00
 * 其中 lp(s) = u32be(len) | utf8(s)
 */
function envelopeAad(body: EnvelopeBody): Buffer {
  const lp = (s: string): Buffer => {
    const bytes = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  const u32 = (n: number): Buffer => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(n);
    return buf;
  };
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    u32(body.suite || 1),
    lp(body.keyId || ''),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 打开单个信封；失败返回 null，由调用方降级处理。 */
export function openEnvelope(envelope: WbEnvelope, key: Buffer): string | null {
  try {
    const body = JSON.parse(Buffer.from(envelope.envelope, 'base64').toString('utf8')) as EnvelopeBody;
    if (body.suite !== 1) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(body.nonce, 'base64'), {
      authTagLength: 16,
    });
    decipher.setAAD(envelopeAad(body));
    decipher.setAuthTag(Buffer.from(body.authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 用探针脚本 + 客户端可执行文件派生本机静态密钥。 */
export function deriveStaticKey(
  profile: ProfileId,
  exePath: string,
  options: { timeoutMs?: number } = {},
): { key: Buffer | null; error: string | null } {
  const cacheKey = `${profile}:${exePath}`;
  const cached = keyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) {
    return { key: cached.key, error: cached.error };
  }

  const probe = path.join(__dirname, '..', '..', 'scripts', 'key-probe.cjs');
  const probePath = fs.existsSync(probe) ? probe : path.join(process.cwd(), 'scripts', 'key-probe.cjs');
  if (!fs.existsSync(probePath)) {
    const error = '未找到 scripts/key-probe.cjs';
    keyCache.set(cacheKey, { key: null, at: Date.now(), error });
    return { key: null, error };
  }

  const result = spawnSync(exePath, [probePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: options.timeoutMs ?? 15000,
    encoding: 'utf8',
    windowsHide: true,
  });

  const match = /WB_CHECKIN_KEY ([A-Za-z0-9+/=]+)/.exec(result.stdout || '');
  if (!match || !match[1]) {
    const error = redactText(result.stderr || `exit=${result.status}`, 160) || '密钥派生失败';
    keyCache.set(cacheKey, { key: null, at: Date.now(), error });
    return { key: null, error };
  }
  const key = Buffer.from(match[1], 'base64');
  keyCache.set(cacheKey, { key, at: Date.now(), error: null });
  return { key, error: null };
}

/** 测试用：清空密钥缓存。 */
export function clearKeyCache(): void {
  keyCache.clear();
}

function normalizeTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number < 1e11 ? number * 1000 : number);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从（可能已解密的）凭据 JSON 中提取账号与令牌。 */
export function extractAuthContent(
  json: Record<string, unknown>,
  options: { key?: Buffer | null; keyError?: string | null } = {},
): AuthFileContent {
  let encrypted = false;
  const raw = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (isEnvelope(value)) {
        encrypted = true;
        if (options.key) {
          const plain = openEnvelope(value, options.key);
          if (plain !== null) record[key] = plain;
        }
      } else if (value && typeof value === 'object') {
        walk(value);
      }
    }
  };
  walk(raw);

  const authRaw = (raw.auth && typeof raw.auth === 'object' ? raw.auth : {}) as Record<string, unknown>;
  const accountRaw = (raw.account && typeof raw.account === 'object'
    ? raw.account
    : Array.isArray(raw.accounts) && raw.accounts[0] && typeof raw.accounts[0] === 'object'
      ? raw.accounts[0]
      : {}) as Record<string, unknown>;

  const accessToken = stringValue(authRaw.accessToken ?? authRaw.access_token ?? authRaw.token);
  const refreshToken = stringValue(authRaw.refreshToken ?? authRaw.refresh_token);
  const expiresAt = normalizeTimestamp(authRaw.expiresAt ?? authRaw.expires_at);

  let credentialError: string | null = null;
  if (!accessToken) {
    if (encrypted && !options.key) credentialError = options.keyError || '凭据已加密且未取得解密密钥';
    else if (encrypted) credentialError = '凭据已加密，解密失败（客户端版本可能不兼容）';
    else credentialError = '未登录：凭据文件中没有 accessToken';
  }

  const phoneRaw = stringValue(accountRaw.phoneNumber ?? accountRaw.phone_number);
  const account: WbAccountInfo = {
    uid: stringValue(accountRaw.uid),
    nickname: stringValue(accountRaw.nickname),
    phoneMasked: phoneRaw,
    uin: stringValue(accountRaw.uin),
    type: stringValue(accountRaw.type),
    enterpriseName: stringValue(accountRaw.enterpriseName),
  };

  return {
    raw,
    account: account.uid ? account : null,
    credentials: accessToken
      ? {
          accessToken,
          refreshToken,
          expiresAt,
          refreshExpiresAt: normalizeTimestamp(authRaw.refreshExpiresAt ?? authRaw.refresh_expires_at),
          lastRefreshTime: normalizeTimestamp(authRaw.lastRefreshTime ?? authRaw.last_refresh_time),
          domain: stringValue(authRaw.domain),
        }
      : null,
    credentialError,
    encrypted,
  };
}

/** 读取并解析一个凭据文件；加密时按需派生密钥。 */
export function readAuthFile(
  authFile: string,
  profile: ProfileId,
  options: { exePath?: string | null; allowKeyDerivation?: boolean } = {},
): AuthFileContent {
  let text: string;
  try {
    text = fs.readFileSync(authFile, 'utf8');
  } catch (error) {
    return {
      raw: {},
      account: null,
      credentials: null,
      credentialError: `凭据文件不可读：${redactText(error, 120)}`,
      encrypted: false,
    };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    return {
      raw: {},
      account: null,
      credentials: null,
      credentialError: `凭据文件格式异常：${redactText(error, 120)}`,
      encrypted: false,
    };
  }

  const hasEnvelope = /"\$wbEncrypted"\s*:\s*1/.test(text);
  if (!hasEnvelope) {
    return extractAuthContent(json);
  }

  const allow = options.allowKeyDerivation !== false;
  const exe = options.exePath === undefined ? findWorkBuddyExe(profile) : options.exePath;
  if (!allow || !exe) {
    return extractAuthContent(json, {
      key: null,
      keyError: exe ? '已禁用密钥派生' : `未找到 ${PROFILES[profile].name} 可执行文件，无法解密凭据`,
    });
  }
  const derived = deriveStaticKey(profile, exe);
  return extractAuthContent(json, { key: derived.key, keyError: derived.error });
}

/** 从 JWT 载荷读取签发域与过期时间（只取必要字段，绝不外传）。 */
export function inspectToken(token: string): { issuerOrigin: string | null; expiresAt: number | null; subject: string | null } {
  const parts = String(token || '').split('.');
  if (parts.length < 2 || !parts[1]) return { issuerOrigin: null, expiresAt: null, subject: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    let issuerOrigin: string | null = null;
    if (typeof payload.iss === 'string') {
      try {
        issuerOrigin = new URL(payload.iss).origin.toLowerCase();
      } catch {
        issuerOrigin = null;
      }
    }
    const exp = Number(payload.exp);
    return {
      issuerOrigin,
      expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : null,
      subject: typeof payload.sub === 'string' ? payload.sub : null,
    };
  } catch {
    return { issuerOrigin: null, expiresAt: null, subject: null };
  }
}

/** 令牌是否可用（留 60 秒余量）。 */
export function isTokenUsable(credentials: WbAuthCredentials | null, now = Date.now()): boolean {
  if (!credentials || !credentials.accessToken) return false;
  const expiry = credentials.expiresAt ?? inspectToken(credentials.accessToken).expiresAt;
  if (expiry === null) return true; // 无过期信息时不阻断，由服务端 401 兜底
  return expiry - now > 60_000;
}

/**
 * 用 refresh token 换新令牌（默认关闭）。
 *
 * 注意：官方刷新接口可能旋转 refresh token。若客户端仍持有旧值，
 * 下次它自己刷新时可能失败，因此本函数只在内存中生效，且必须由用户显式开启。
 */
export async function refreshCredentials(
  credentials: WbAuthCredentials,
  options: { apiHost: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: number },
): Promise<{ ok: boolean; credentials: WbAuthCredentials; error: string | null }> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!credentials.refreshToken) {
    return { ok: false, credentials, error: '缺少 refresh token' };
  }
  const host = options.apiHost.replace(/\/+$/, '');
  const now = options.now ?? Date.now();
  try {
    const response = await fetchImpl(`${host}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-Refresh-Token': credentials.refreshToken,
        ...(credentials.accessToken ? { authorization: `Bearer ${credentials.accessToken}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(options.timeoutMs ?? 12000),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const code = typeof payload.code === 'number' ? payload.code : null;
    if (!response.ok || (code !== null && code !== 0 && code !== 200)) {
      return { ok: false, credentials, error: redactText(payload.msg || payload.message || `HTTP ${response.status}`, 160) };
    }
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
    const accessToken = stringValue(data.accessToken ?? data.access_token);
    if (!accessToken) return { ok: false, credentials, error: '刷新响应缺少 accessToken' };
    const expiresIn = Number(data.expiresIn ?? data.expires_in);
    return {
      ok: true,
      credentials: {
        ...credentials,
        accessToken,
        refreshToken: stringValue(data.refreshToken ?? data.refresh_token) || credentials.refreshToken,
        lastRefreshTime: now,
        expiresAt: normalizeTimestamp(data.expiresAt ?? data.expires_at)
          ?? (Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : credentials.expiresAt),
      },
      error: null,
    };
  } catch (error) {
    return { ok: false, credentials, error: redactText(error, 160) };
  }
}
