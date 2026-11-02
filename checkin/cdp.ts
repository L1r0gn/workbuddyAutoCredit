/**
 * CDP 客户端（零依赖，Node 20+ 使用全局 WebSocket）。
 *
 * 职责：
 * 1. 发现本机已运行的 WorkBuddy Electron 客户端（扫描候选调试端口）。
 * 2. 识别归属：只看渲染页 URL 是否来自该客户端的安装目录或登录域名，
 *    不靠标题猜测，避免误连其它 Chromium 应用。
 * 3. 连接目标页并执行 Runtime.evaluate（页面就绪检查、读取当前页面身份）。
 * 4. 断线后有限次重连，失败优雅降级：签到核心流程不依赖 CDP。
 *
 * 注意：本模块**不修改官方客户端任何文件**。客户端未带调试端口启动时，
 * 只会报告 unavailable，不会偷偷改配置；需要时由用户显式选择重启客户端。
 */
import { execFile } from 'node:child_process';
import { PROFILES } from './config';
import { redactText, type Logger } from './logger';
import type { CdpStatus, ProfileId } from './types';

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

interface TargetInfo {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  description?: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpOptions {
  profile: ProfileId;
  logger: Logger;
  /** 候选端口，默认 [9222..9229] */
  ports?: number[];
  fetchImpl?: typeof fetch;
  webSocketImpl?: WebSocketCtor;
  connectTimeoutMs?: number;
}

const DEFAULT_PORTS = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];

/** 判定 target 是否属于指定 profile：安装目录 app.asar 路径或登录域名。 */
export function classifyTarget(target: TargetInfo, profile: ProfileId): boolean {
  const url = String(target.url || '').replace(/%20/g, ' ');
  if (target.type !== 'page') return false;
  if (/^(devtools|chrome|about|edge):/i.test(url)) return false;

  if (profile === 'workbuddy-ai') {
    if (/\/WorkBuddy ?AI\/resources\/app\.asar(?:\/|$)/i.test(url)) return true;
    if (/\/WorkBuddyAI\/resources\/app\.asar(?:\/|$)/i.test(url)) return true;
    if (/https?:\/\/(?:[^/]+\.)?workbuddy\.ai(?:\/|$)/i.test(url)) return true;
    return false;
  }
  if (/\/WorkBuddy\/resources\/app\.asar(?:\/|$)/i.test(url)) return true;
  if (/https?:\/\/(?:[^/]+\.)?workbuddy\.cn(?:\/|$)/i.test(url)) return true;
  if (/https?:\/\/(?:[^/]+\.)?codebuddy\.cn(?:\/|$)/i.test(url)) return true;
  return false;
}

/** 在候选中挑主对话页：排除设置/工具窗口。 */
export function selectPageTarget(targets: TargetInfo[], profile: ProfileId): TargetInfo | null {
  const candidates = targets.filter((target) => classifyTarget(target, profile) && target.webSocketDebuggerUrl);
  if (!candidates.length) return null;
  const score = (target: TargetInfo): number => {
    const url = String(target.url || '');
    if (/windowAppId=settings|windowKind=settings|windowPreset=utility/i.test(url)) return 20;
    if (/accountSnapshot=|[?&]locale=/i.test(url)) return 0;
    return 10;
  };
  return [...candidates].sort((a, b) => score(a) - score(b))[0] || null;
}

function resolveWebSocket(): WebSocketCtor | null {
  const globalCtor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (globalCtor) return globalCtor;
  try {
    // 可选依赖：老版本 Node 没有全局 WebSocket 时使用 ws
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ws = require('ws') as { WebSocket?: WebSocketCtor } | WebSocketCtor;
    if (typeof ws === 'function') return ws as WebSocketCtor;
    if (ws && typeof (ws as { WebSocket?: WebSocketCtor }).WebSocket === 'function') {
      return (ws as { WebSocket: WebSocketCtor }).WebSocket;
    }
  } catch {
    /* 没有 ws 也不致命：会返回明确错误 */
  }
  return null;
}

export class CdpClient {
  private readonly options: CdpOptions;
  private readonly fetchImpl: typeof fetch;
  private ws: WebSocketLike | null = null;
  private messageId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private state: CdpStatus = {
    connected: false,
    port: null,
    targetUrl: null,
    targetTitle: null,
    pageReadyState: null,
    error: null,
  };

  constructor(options: CdpOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  status(): CdpStatus {
    return { ...this.state };
  }

  /** 探测候选端口上是否存在该 profile 的渲染页。 */
  async discover(): Promise<{ port: number; target: TargetInfo } | null> {
    const ports = this.options.ports || DEFAULT_PORTS;
    for (const port of ports) {
      try {
        const [versionRes, listRes] = await Promise.all([
          this.fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }),
          this.fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }),
        ]);
        if (!versionRes.ok || !listRes.ok) continue;
        const version = (await versionRes.json().catch(() => null)) as { Browser?: string } | null;
        const list = (await listRes.json().catch(() => null)) as TargetInfo[] | null;
        if (!version || !Array.isArray(list)) continue;
        const browser = `${version.Browser || ''}`;
        const target = selectPageTarget(list, this.options.profile);
        if (!target) {
          this.options.logger.warn(
            `端口 ${port} 开放（${browser || 'unknown'}），但没有归属 ${PROFILES[this.options.profile].name} 的页面目标`,
          );
          continue;
        }
        return { port, target };
      } catch {
        /* 端口未开放，继续 */
      }
    }
    return null;
  }

  /** 连接目标页（同一实例重复调用会先断开旧连接）。 */
  async connect(): Promise<CdpStatus> {
    if (this.ws) this.disconnect();

    const WebSocketImpl = this.options.webSocketImpl || resolveWebSocket();
    if (!WebSocketImpl) {
      this.state = { ...this.state, connected: false, error: '当前 Node 运行时没有 WebSocket 支持（需 Node 20+ 或安装 ws）' };
      return this.status();
    }

    const found = await this.discover();
    if (!found) {
      this.state = {
        connected: false,
        port: null,
        targetUrl: null,
        targetTitle: null,
        pageReadyState: null,
        error: '未发现 CDP 调试端口（客户端需以 --remote-debugging-port 启动）',
      };
      return this.status();
    }

    const wsUrl = found.target.webSocketDebuggerUrl as string;
    const timeoutMs = this.options.connectTimeoutMs ?? 6000;
    const status = await new Promise<CdpStatus>((resolve) => {
      let settled = false;
      const done = (value: CdpStatus): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let ws: WebSocketLike;
      try {
        ws = new WebSocketImpl(wsUrl);
      } catch (error) {
        done({ ...this.state, connected: false, error: `创建 WebSocket 失败：${redactText(error, 120)}` });
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        done({ ...this.state, connected: false, port: found.port, error: 'CDP 连接超时' });
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        this.state = {
          connected: true,
          port: found.port,
          targetUrl: String(found.target.url || ''),
          targetTitle: String(found.target.title || ''),
          pageReadyState: null,
          error: null,
        };
        done(this.status());
      };
      ws.onmessage = (event) => this.handleMessage(event.data);
      ws.onerror = () => {
        clearTimeout(timer);
        this.state = { ...this.state, connected: false, port: found.port, error: 'CDP WebSocket 连接失败' };
        done(this.status());
      };
      ws.onclose = () => {
        this.ws = null;
        this.state = { ...this.state, connected: false, error: this.state.error || 'CDP 连接已断开' };
        for (const [, pending] of this.pending) pending.reject(new Error('CDP 连接已断开'));
        this.pending.clear();
      };
    });
    return status;
  }

  private handleMessage(raw: unknown): void {
    let text: string;
    if (typeof raw === 'string') text = raw;
    else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
    else text = String(raw);
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.id === undefined) return; // 事件帧，忽略
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'CDP 调用失败'));
    else pending.resolve(message.result);
  }

  /** 发送 CDP 命令。 */
  private send(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws?.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 在页面上下文执行表达式并取回 JSON 值。 */
  async evaluate<T = unknown>(expression: string, options: { awaitPromise?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const result = (await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: options.awaitPromise === true },
      options.timeoutMs ?? 8000,
    )) as { result?: { value?: T }; exceptionDetails?: { text?: string } } | undefined;
    if (result && result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行异常');
    return (result && result.result ? result.result.value : undefined) as T;
  }

  /** 等待页面加载完成（document.readyState === 'complete'）。 */
  async waitForPageReady(timeoutMs = 15000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let last: string | null = null;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate<string>('document.readyState');
        last = typeof state === 'string' ? state : null;
        this.state.pageReadyState = last;
        if (last === 'complete') return last;
      } catch (error) {
        this.state.error = redactText(error, 120);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return last;
  }

  /**
   * 读取页面侧的登录身份线索（只读，不触碰令牌）。
   * 用于确认"当前页面显示的是哪个账号"，避免在账号切换后操作错账号。
   */
  async readPageIdentity(): Promise<{ href: string; title: string; readyState: string; accountHint: string | null } | null> {
    if (!this.state.connected) return null;
    const expression = `(function(){
      try {
        var href = location.href, title = document.title, ready = document.readyState;
        var hint = null;
        var nodes = document.querySelectorAll('[data-account-id], [data-uid], .user-name, .account-name');
        for (var i = 0; i < nodes.length && !hint; i++) {
          var el = nodes[i];
          var v = el.getAttribute && (el.getAttribute('data-account-id') || el.getAttribute('data-uid'));
          if (!v) { var t = (el.textContent || '').trim(); if (t && t.length <= 40) v = t; }
          if (v) hint = String(v).slice(0, 60);
        }
        return { href: href, title: title, readyState: ready, accountHint: hint };
      } catch (e) { return null; }
    })()`;
    try {
      return await this.evaluate(expression);
    } catch (error) {
      this.options.logger.warn(`读取页面身份失败：${redactText(error, 120)}`);
      return null;
    }
  }

  /** 带退避的重连，最多 attempts 次。 */
  async connectWithRetry(attempts = 3, baseDelayMs = 1000): Promise<CdpStatus> {
    let last: CdpStatus | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      last = await this.connect();
      if (last.connected) return last;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
    return last || this.status();
  }

  disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    this.state = { ...this.state, connected: false };
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    for (const [, pending] of this.pending) pending.reject(new Error('CDP 已断开'));
    this.pending.clear();
  }
}

/**
 * 检测客户端进程是否在运行（仅用于决定是否提示/启动客户端，不用于身份判断）。
 * 返回值 null 表示无法判定。
 */
export function detectClientProcess(profile: ProfileId): Promise<boolean | null> {
  const image = profile === 'workbuddy-ai' ? 'WorkBuddyAI.exe' : 'WorkBuddy.exe';
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { timeout: 6000 }, (error, stdout) => {
        if (error) return resolve(null);
        resolve(String(stdout || '').toLowerCase().includes(image.toLowerCase()));
      });
      return;
    }
    execFile('pgrep', ['-f', image.replace('.exe', '')], { timeout: 6000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout || '').trim().length > 0);
    });
  });
}
