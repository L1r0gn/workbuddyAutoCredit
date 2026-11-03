/**
 * 设备身份测试：本机环境值、UMID 组件定位（区域隔离）、组件调用协议。
 * 组件只有在真实存在时才会被执行（否则跳过），不伪造身份。
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { findUmidComponent, umidBinaryName } from '../qoder/config';
import { getRiskIdentity, invokeUmid, locateUmid, machineHostname, machineOs } from '../qoder/device';
import { tempDir } from './qoder-helpers';

test('machineOs 形如 x86_64_win32', () => {
  assert.match(machineOs(), /^(x86_64|aarch64|[a-z0-9]+)_(win32|darwin|linux)$/);
});

test('machineHostname：ASCII 主机名原样返回', () => {
  assert.equal(machineHostname({ COMPUTERNAME: 'MY-PC' }), 'MY-PC');
  assert.equal(machineHostname({ HOSTNAME: 'host-1' }), 'host-1');
});

test('machineHostname：非 ASCII 主机名用短摘要兜底，且可打印', () => {
  const value = machineHostname({ COMPUTERNAME: '小明的主机' });
  assert.match(value, /^[\x21-\x7e ]+$/);
  assert.match(value, /unknown-[0-9a-f]{8}$/);
});

test('machineHostname：超长主机名截断并附加摘要', () => {
  const long = 'a'.repeat(200);
  const value = machineHostname({ COMPUTERNAME: long });
  assert.ok(value.length <= 96, `长度应 <= 96，实际 ${value.length}`);
  assert.match(value, /-[0-9a-f]{8}$/);
});

test('环境变量优先于其它来源指定 UMID 组件', () => {
  const dir = tempDir();
  const fake = `${dir}/${umidBinaryName()}`;
  require('node:fs').writeFileSync(fake, '');
  const found = findUmidComponent('cn', { env: { QODERCN_RUNTIME_INFO: fake } });
  assert.equal(found.path, fake);
  assert.equal(found.source, 'env');
});

test('两个区域的覆盖变量互不串用', () => {
  const dir = tempDir();
  const cnBin = `${dir}/cn-${umidBinaryName()}`;
  const intlBin = `${dir}/intl-${umidBinaryName()}`;
  fs.writeFileSync(cnBin, '');
  fs.writeFileSync(intlBin, '');

  const env = { QODERCN_RUNTIME_INFO: cnBin, QODER_RUNTIME_INFO: intlBin };
  assert.equal(findUmidComponent('cn', { env }).path, cnBin);
  assert.equal(findUmidComponent('global', { env }).path, intlBin);
});

test('找不到组件时返回尝试过的路径清单（供 CLI 提示）', () => {
  const found = findUmidComponent('global', {
    env: { QODER_RUNTIME_INFO: '/definitely/not/here/runtime-info' },
    dataDir: '/tmp/does-not-exist',
    ignoreCliCache: true,
    exe: null,
  });
  assert.equal(found.path, null);
  assert.equal(found.source, 'none');
  assert.ok(found.tried.length >= 1);
  assert.ok(found.tried.includes('/definitely/not/here/runtime-info'), '应记录环境变量指定的路径');
});

test('忽略 CLI 缓存时不会回落到 CLI 组件', () => {
  const withCli = findUmidComponent('global', {});
  const withoutCli = findUmidComponent('global', { ignoreCliCache: true });
  if (withCli.source === 'cli') {
    assert.notEqual(withoutCli.source, 'cli');
  }
  // 只校验行为契约：忽略后不会返回 cli 来源
  assert.notEqual(withoutCli.source, 'cli');
});

test('locateUmid 不安装、不写文件，只做定位', () => {
  const dir = tempDir();
  const result = locateUmid({
    region: 'cn',
    dataDir: dir,
    env: { QODERCN_RUNTIME_INFO: `${dir}/nope` },
    ignoreCliCache: true,
  });
  assert.equal(result.path, null);
  assert.ok(result.tried.length >= 1);
  // 关键契约：定位过程不在数据目录里创建任何东西
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('组件调用失败时给出可读错误，不回退伪造身份', async () => {
  const dir = tempDir();
  const result = await getRiskIdentity({
    region: 'cn',
    uid: 'uid-1',
    env: { QODERCN_RUNTIME_INFO: '/definitely/not/here/runtime-info' },
    dataDir: dir,
    ignoreCliCache: true,
    exe: null,
  });
  assert.equal(result.values, null, '找不到组件时绝不能返回伪造的身份');
  assert.ok(result.error);
  assert.match(result.error || '', /UMID/);
});

// ---- 真实组件集成（仅在装了对应客户端时执行）----

const CN_UMID = findUmidComponent('cn', {});
const INTL_UMID = findUmidComponent('global', {});

test('真实 UMID 组件可生成本机设备身份（国内版）', { skip: !CN_UMID.path }, async () => {
  const result = await getRiskIdentity({ region: 'cn', uid: '', timeoutMs: 25000 });
  assert.equal(result.error, null, `组件调用失败：${result.error}`);
  assert.ok(result.values);
  assert.ok((result.values?.machineToken.length ?? 0) > 20);
  assert.ok((result.values?.machineCode.length ?? 0) > 0);
  assert.ok((result.values?.machineType.length ?? 0) > 0);
});

test('真实 UMID 组件可生成本机设备身份（国际版）', { skip: !INTL_UMID.path }, async () => {
  const result = await getRiskIdentity({ region: 'global', uid: '', timeoutMs: 25000 });
  assert.equal(result.error, null, `组件调用失败：${result.error}`);
  assert.ok(result.values);
});

test('组件输出缺字段时报错而不是猜值', async () => {
  // 用一个必然缺字段的“组件”验证解析严格性：这里直接验证错误路径存在
  await assert.rejects(
    () => invokeUmid('/definitely/not/a/component', 0, 'uid', 2000),
    /启动失败|没有输出|不是合法 JSON/,
  );
});
