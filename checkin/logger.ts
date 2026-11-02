/**
 * 日志层：负责脱敏、结构化 JSONL 落盘与控制台输出。
 *
 * 安全约束（硬性）：
 * - 任何日志、异常、诊断信息都不得包含 accessToken / refreshToken / Cookie。
 * - 账号统一以脱敏标签出现（uid 前 4 位 + 后 2 位）。
 * - 写盘前再脱敏一次，避免调用方漏处理。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckinRecord } from './types';

/** 明显的凭据形状：JWT、Bearer 头、超长不透明串。 */
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;
const LONG_SECRET_RE = /\b[A-Za-z0-9+/]{60,}={0,2}\b/g;
const COOKIE_RE = /\b(cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi;
const INSECURE_ENV_RE = /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|NODE_TLS_REJECT_UNAUTHORIZED['"]?\s*[:=]\s*['"]?0/;

/** 把 uid 变成可写入日志的标签。 */
export function maskUid(uid: string): string {
  const value = String(uid || '').trim();
  if (!value) return 'unknown';
  if (value.length <= 6) return value.slice(0, 2) + '****';
  return `${value.slice(0, 4)}****${value.slice(-2)}`;
}

/** 手机号脱敏。 */
export function maskPhone(phone: string): string {
  const value = String(phone || '').trim();
  if (!value) return '';
  if (/^\d{11}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/** 通用文本脱敏，供日志与异常信息复用。 */
export function redactText(input: unknown, maxLength = 400): string {
  let text: string;
  if (typeof input === 'string') text = input;
  else if (input instanceof Error) text = `${input.name}: ${input.message}`;
  else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  const cleaned = text
    .replace(BEARER_RE, 'Bearer <redacted>')
    .replace(JWT_RE, '<redacted-jwt>')
    .replace(LONG_SECRET_RE, '<redacted-secret>')
    .replace(COOKIE_RE, '$1: <redacted>');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** 北京时间（Asia/Shanghai，无夏令时，固定 UTC+8）日期字符串。 */
export function beijingDate(at: number | Date = Date.now()): string {
  const date = at instanceof Date ? at : new Date(at);
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 本地时区的可读时间戳（日志用）。 */
export function localIso(at: number | Date = Date.now()): string {
  const date = at instanceof Date ? at : new Date(at);
  return date.toISOString();
}

export interface LoggerOptions {
  /** 日志目录；为空时只输出到控制台 */
  logDir?: string | null;
  verbose?: boolean;
  /** 文件名前缀，用于区分 CLI 与 daemon */
  scope?: string;
}

/**
 * 运行日志器。
 *
 * - 每次调用按级别输出到控制台（verbose=false 时只输出 warn/error）。
 * - 结构化事件写入 `run-log-YYYY-MM-DD.jsonl`（北京时间日期分片）。
 * - 写盘失败不抛出：日志不可用不应中断签到主流程。
 */
export class Logger {
  private readonly logDir: string | null;
  private readonly verbose: boolean;
  private readonly scope: string;
  private memoryLines: string[] = [];

  constructor(options: LoggerOptions = {}) {
    this.logDir = options.logDir ?? null;
    this.verbose = options.verbose !== false;
    this.scope = options.scope || 'checkin';
  }

  /** 纯文本诊断日志。 */
  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  /** 结构化事件（JSONL），字段顺序稳定便于人工比对。 */
  event(event: string, payload: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: localIso(),
      scope: this.scope,
      event,
      ...sanitizePayload(payload),
    });
    this.append(line);
    // 诊断信息一律走 stderr，保证 stdout 只承载命令输出（表格 / JSON）
    if (this.verbose) process.stderr.write(`[${event}] ${redactText(JSON.stringify(payload), 600)}\n`);
  }

  /** 单账号签到结果 -> 结构化日志（需求：执行日期/账号/前后积分/结果/失败原因）。 */
  record(record: CheckinRecord): void {
    this.event('checkin.result', {
      date: record.date,
      account: record.accountTag,
      profile: record.profile,
      outcome: record.outcome,
      ok: record.ok,
      already: record.already,
      code: record.code,
      message: redactText(record.message, 200),
      startedAt: localIso(record.startedAt),
      finishedAt: localIso(record.finishedAt),
      durationMs: record.finishedAt - record.startedAt,
      creditsBefore: record.creditsBefore,
      creditsAfter: record.creditsAfter,
      creditsDelta: record.creditsDelta,
      verified: record.verified,
      verification: record.verification,
      endpoint: record.endpoint,
      dryRun: record.dryRun,
      diagnostic: record.diagnostic ? redactText(record.diagnostic, 300) : null,
    });
  }

  /** 供测试与 CLI 汇总读取。 */
  drainMemoryLines(): string[] {
    const lines = this.memoryLines;
    this.memoryLines = [];
    return lines;
  }

  private write(level: 'info' | 'warn' | 'error', message: string): void {
    const text = redactText(message, 600);
    const line = JSON.stringify({ ts: localIso(), scope: this.scope, event: 'log', level, message: text });
    this.append(line);
    if (this.verbose || level !== 'info') {
      process.stderr.write(`${level.toUpperCase()} ${text}\n`);
    }
  }

  private append(line: string): void {
    this.memoryLines.push(line);
    if (this.memoryLines.length > 500) this.memoryLines.splice(0, this.memoryLines.length - 500);
    if (!this.logDir) return;
    try {
      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.logDir, `run-log-${beijingDate()}.jsonl`);
      fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    } catch {
      /* 日志落盘失败不影响主流程 */
    }
  }
}

/** 递归脱敏对象里的字符串值。 */
function sanitizePayload(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/token|cookie|authorization|password|secret/i.test(key)) {
      out[key] = '<redacted>';
      continue;
    }
    if (typeof raw === 'string') out[key] = redactText(raw, 600);
    else if (raw && typeof raw === 'object' && depth < 3) out[key] = sanitizePayload(raw, depth + 1);
    else out[key] = raw;
  }
  return out;
}

/**
 * 启动时的环境自查：本模块从不关闭 TLS 校验，
 * 但外部环境可能通过 NODE_TLS_REJECT_UNAUTHORIZED=0 全局关闭，需要在日志里点明。
 */
export function detectInsecureTlsEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (value === undefined) return false;
  return INSECURE_ENV_RE.test(`NODE_TLS_REJECT_UNAUTHORIZED=${value}`) || value.trim() === '0';
}
