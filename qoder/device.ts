/**
 * 设备身份层。
 *
 * 只做两件事：
 * 1. 调用**官方 UMID 组件**（`runtime-info`）生成设备风控三件套；
 * 2. 提供 Cosy-MachineOS / Cosy-MachineHostname 这类本机环境值。
 *
 * 明确不做的事：
 * - 不伪造硬件指纹、不硬编码 machineToken；
 * - 不修改客户端文件；
 * - 不把 machineToken / 设备身份上传到任何地方（只在请求头里发给 Qoder 自己的接口）。
 *
 * 组件协议（源自 Qoder-Daily 源码 + 本机实测）：
 *   runtime-info <0|3> --account-stdin
 *   stdin : {"account":"<uid>"}\n
 *   stdout: {"machineToken":"...","machineCode":"...","machineType":"...", ...}
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { findUmidComponent, REGIONS, RISK_TTL_MS } from './config';
import { redactText } from '../checkin/logger';
import type { QoderRegion, QoderRiskValues } from './types';

export interface DeviceOptions {
  region: QoderRegion;
  /** 账号 uid，透传给组件（组件用它做同人多号判定） */
  uid?: string;
  /** 客户端可执行文件路径（用于推导 resources/umid） */
  exe?: string | null;
  /** 显式指定的组件路径 */
  umidPath?: string | null;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 组件调用超时 */
  timeoutMs?: number;
  /** 忽略 CLI 运行时缓存的组件 */
  ignoreCliCache?: boolean;
}

export interface RiskResult {
  values: QoderRiskValues | null;
  error: string | null;
  /** 组件路径与来源，便于诊断 */
  component: { path: string | null; source: string; tried: string[] };
}

const cache = new Map<string, { at: number; values: QoderRiskValues }>();

/** 测试用：清空缓存。 */
export function clearRiskCache(): void {
  cache.clear();
}

/** 本机 OS 标识，形如 x86_64_win32（与上游 Cosy-MachineOS 一致）。 */
export function machineOs(): string {
  const raw = os.arch().toLowerCase();
  const arch = raw === 'x64' || raw === 'amd64' ? 'x86_64' : raw === 'arm64' ? 'aarch64' : raw;
  const system = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return `${arch}_${system}`;
}

/**
 * Cosy-MachineHostname：优先返回可打印的主机名；
 * 含非 ASCII 字符时用短摘要兜底，长度上限 96。
 */
export function machineHostname(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.COMPUTERNAME || env.HOSTNAME || '').trim();
  if (!raw) return '';
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
  const printable = [...raw].every((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (code >= 0x21 && code <= 0x7e) || ch === ' ';
  });
  let text: string;
  if (printable) {
    text = raw;
  } else {
    const cleaned = [...raw].map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x21 && code <= 0x7e ? ch : '-';
    }).join('');
    const collapsed = cleaned.split('-').filter(Boolean).join('-');
    text = collapsed ? `${collapsed}-${digest}` : `unknown-${digest}`;
  }
  if (text.length > 96) text = `${text.slice(0, 87).replace(/[- ]+$/, '')}-${digest}`;
  return text;
}

/** 定位官方组件（不安装、不写文件）。 */
export function locateUmid(options: Omit<DeviceOptions, 'uid'>): { path: string | null; source: string; tried: string[] } {
  const lookup = findUmidComponent(options.region, {
    exe: options.exe ?? null,
    configured: options.umidPath ?? null,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.ignoreCliCache ? { ignoreCliCache: true } : {}),
  });
  return { path: lookup.path, source: lookup.source, tried: lookup.tried };
}

interface ComponentOutput {
  machineToken?: unknown;
  machineCode?: unknown;
  machineType?: unknown;
}

/** 调用组件一次（不含缓存）。 */
export async function invokeUmid(
  componentPath: string,
  envNumber: number,
  uid: string,
  timeoutMs = 25000,
): Promise<QoderRiskValues> {
  const args = [String(envNumber), '--account-stdin'];
  return new Promise<QoderRiskValues>((resolve, reject) => {
    let settled = false;
    const child = spawn(componentPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`UMID 组件调用超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1024 * 1024) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('UMID 组件输出过大'));
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`UMID 组件启动失败：${redactText(error, 160)}`));
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || '';
      if (!line) return reject(new Error('UMID 组件没有输出（可能不是官方组件或已被安全策略拦截）'));
      let parsed: ComponentOutput;
      try {
        parsed = JSON.parse(line) as ComponentOutput;
      } catch {
        return reject(new Error('UMID 组件输出不是合法 JSON'));
      }
      const pick = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
      const values: QoderRiskValues = {
        machineToken: pick(parsed.machineToken),
        machineCode: pick(parsed.machineCode),
        machineType: pick(parsed.machineType),
      };
      const missing = (['machineToken', 'machineCode', 'machineType'] as const).filter((key) => !values[key]);
      if (missing.length) return reject(new Error(`UMID 组件输出缺少 ${missing.join(' / ')}`));
      resolve(values);
    });

    try {
      child.stdin.end(JSON.stringify({ account: uid || '' }) + '\n');
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`写入 UMID 组件标准输入失败：${redactText(error, 120)}`));
    }
  });
}

/**
 * 取得设备风控身份（带 50 分钟缓存，按 region+uid 隔离）。
 * 失败时返回可读原因，绝不回退到伪造值。
 */
export async function getRiskIdentity(options: DeviceOptions): Promise<RiskResult> {
  const uid = options.uid || '';
  const key = `${options.region}:${uid}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < RISK_TTL_MS) {
    return { values: hit.values, error: null, component: { path: null, source: 'cache', tried: [] } };
  }

  const component = locateUmid(options);
  if (!component.path) {
    const label = REGIONS[options.region].label;
    return {
      values: null,
      error:
        `未找到 ${label} 的官方 UMID 组件（runtime-info）。` +
        `请确认已安装并登录对应客户端，或用 ${REGIONS[options.region].umidEnvVar} 指定组件路径。`,
      component,
    };
  }
  try {
    const values = await invokeUmid(component.path, REGIONS[options.region].umidEnv, uid, options.timeoutMs);
    cache.set(key, { at: Date.now(), values });
    return { values, error: null, component };
  } catch (error) {
    return { values: null, error: redactText(error, 240), component };
  }
}

/** 生成 UUID 形态的 Cosy-MachineId（仅当上游没有提供时使用）。 */
export function randomMachineId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
