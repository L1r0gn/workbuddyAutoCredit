/**
 * CDP 层测试：归属识别、目标选举、连接失败降级、断线重连。
 * 使用假的 fetch + 假的 WebSocket，不依赖真实客户端。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CdpClient, classifyTarget, selectPageTarget } from '../checkin/cdp';
import { silentLogger } from './helpers';

const CN_PAGE = {
  type: 'page',
  url: 'file:///F:/WorkBuddy/resources/app.asar/renderer/index.html',
  title: 'WorkBuddy',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
};
const AI_PAGE = {
  type: 'page',
  url: 'file:///C:/Users/x/AppData/Local/Programs/WorkBuddyAI/resources/app.asar/renderer/index.html',
  title: 'WorkBuddy AI',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/2',
};
const OTHER_APP = {
  type: 'page',
  url: 'file:///C:/Program%20Files/OtherApp/resources/app.asar/index.html',
  title: 'Some Chromium App',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/9',
};

test('归属识别：只认安装目录 app.asar 或登录域名', () => {
  assert.equal(classifyTarget(CN_PAGE, 'workbuddy-cn'), true);
  assert.equal(classifyTarget(CN_PAGE, 'workbuddy-ai'), false);
  assert.equal(classifyTarget(AI_PAGE, 'workbuddy-ai'), true);
  assert.equal(classifyTarget(AI_PAGE, 'workbuddy-cn'), false);
  assert.equal(classifyTarget(OTHER_APP, 'workbuddy-cn'), false, '不能靠标题误认其它 Chromium 应用');
  assert.equal(classifyTarget({ ...CN_PAGE, type: 'service_worker' }, 'workbuddy-cn'), false);
  assert.equal(classifyTarget({ ...CN_PAGE, url: 'devtools://devtools/bundled/x.html' }, 'workbuddy-cn'), false);
  assert.equal(
    classifyTarget({ type: 'page', url: 'https://www.workbuddy.cn/profile/plans-usage' }, 'workbuddy-cn'),
    true,
  );
});

test('目标选举：优先主对话页，跳过设置窗口', () => {
  const targets = [
    { ...CN_PAGE, url: 'file:///F:/WorkBuddy/resources/app.asar/index.html?windowAppId=settings', webSocketDebuggerUrl: 'ws://a' },
    { ...CN_PAGE, url: 'file:///F:/WorkBuddy/resources/app.asar/index.html?locale=zh-CN', webSocketDebuggerUrl: 'ws://b' },
    { ...CN_PAGE, webSocketDebuggerUrl: 'ws://c' },
  ];
  const picked = selectPageTarget(targets, 'workbuddy-cn');
  // 评分规则（与参考实现一致）：设置窗口最差(20)，带 locale 的普通页最优(0)，主页面次之(10)
  assert.equal(picked?.webSocketDebuggerUrl, 'ws://b');
  const withoutLocale = targets.filter((t) => !/locale=/.test(String(t.url)));
  assert.equal(selectPageTarget(withoutLocale, 'workbuddy-cn')?.webSocketDebuggerUrl, 'ws://c');
  const onlySettings = targets.filter((t) => /windowAppId=settings/.test(String(t.url)));
  assert.equal(selectPageTarget(onlySettings, 'workbuddy-cn')?.webSocketDebuggerUrl, 'ws://a', '只剩设置窗口时也要能连上');
});

test('没有匹配页面时返回 null', () => {
  assert.equal(selectPageTarget([OTHER_APP], 'workbuddy-cn'), null);
  assert.equal(selectPageTarget([], 'workbuddy-cn'), null);
});

test('端点全部未开放：connect 返回未连接 + 明确原因，不抛异常', async () => {
  const logger = silentLogger();
  const client = new CdpClient({
    profile: 'workbuddy-cn',
    logger,
    ports: [19222, 19223],
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  });

  const status = await client.connect();
  assert.equal(status.connected, false);
  assert.match(status.error ?? '', /未发现 CDP 调试端口/);
  assert.equal(client.status().connected, false);

  // 未连接时求值应明确失败，而不是静默返回 undefined
  await assert.rejects(() => client.evaluate('1+1'), /CDP 未连接/);
});

test('端口开放但页面不属于该客户端：报错并给出归属提示', async () => {
  const logger = silentLogger();
  const fetchImpl = (async (input: string | URL | { url: string }) => {
    const url = String(input);
    if (url.endsWith('/json/version')) return new Response(JSON.stringify({ Browser: 'Chrome/151' }), { status: 200 });
    if (url.endsWith('/json/list')) return new Response(JSON.stringify([OTHER_APP]), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const client = new CdpClient({ profile: 'workbuddy-cn', logger, ports: [9222], fetchImpl });
  const status = await client.connect();
  assert.equal(status.connected, false);
  assert.match(status.error ?? '', /未发现 CDP 调试端口/);
});

test('连接成功后可以求值；断开后状态复位', async () => {
  const sent: string[] = [];
  class FakeWebSocket {
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    constructor(public url: string) {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }
    send(data: string): void {
      sent.push(data);
      const message = JSON.parse(data) as { id: number; method: string };
      if (message.method === 'Runtime.evaluate') {
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ id: message.id, result: { result: { value: 'complete' } } }) });
        }, 0);
      }
    }
    close(): void {
      this.readyState = 3;
      this.onclose?.({});
    }
  }

  const fetchImpl = (async (input: string | URL | { url: string }) => {
    const url = String(input);
    if (url.endsWith('/json/version')) return new Response(JSON.stringify({ Browser: 'WorkBuddy/5.8' }), { status: 200 });
    if (url.endsWith('/json/list')) return new Response(JSON.stringify([CN_PAGE]), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const client = new CdpClient({
    profile: 'workbuddy-cn',
    logger: silentLogger(),
    ports: [9222],
    fetchImpl,
    webSocketImpl: FakeWebSocket as unknown as new (url: string) => never,
  });

  const status = await client.connect();
  assert.equal(status.connected, true);
  assert.equal(status.port, 9222);
  assert.equal(status.targetUrl, CN_PAGE.url);

  const value = await client.evaluate<string>('document.readyState');
  assert.equal(value, 'complete');
  assert.ok(sent.some((frame) => frame.includes('Runtime.evaluate')));

  const ready = await client.waitForPageReady(1000);
  assert.equal(ready, 'complete');

  client.disconnect();
  assert.equal(client.status().connected, false);
});

test('页面加载未完成时 waitForPageReady 会超时返回最后一次状态', async () => {
  class FakeWebSocket {
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    constructor(public url: string) {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }
    send(data: string): void {
      const message = JSON.parse(data) as { id: number };
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result: { result: { value: 'loading' } } }) });
      }, 0);
    }
    close(): void {
      this.readyState = 3;
    }
  }
  const fetchImpl = (async (input: string | URL | { url: string }) => {
    const url = String(input);
    if (url.endsWith('/json/version')) return new Response(JSON.stringify({ Browser: 'WorkBuddy' }), { status: 200 });
    if (url.endsWith('/json/list')) return new Response(JSON.stringify([CN_PAGE]), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const client = new CdpClient({
    profile: 'workbuddy-cn',
    logger: silentLogger(),
    ports: [9222],
    fetchImpl,
    webSocketImpl: FakeWebSocket as unknown as new (url: string) => never,
  });
  await client.connect();
  const state = await client.waitForPageReady(600);
  assert.equal(state, 'loading');
});
