/**
 * 凭据层测试：明文/加密凭据解析、信封往返、令牌有效性判断。
 * 加密样例由测试侧独立实现（不依赖被测代码的加密路径），用于验证解密实现正确。
 */
import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { extractAuthContent, inspectToken, isTokenUsable, openEnvelope, readAuthFile } from '../checkin/auth-manager';
import { fakeJwt, tempDir } from './helpers';

/** 与客户端实现一致的 AAD 构帧（测试侧独立书写）。 */
function aad(body: { suite: number; keyId: string }): Buffer {
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
    u32(body.suite),
    lp(body.keyId),
    Buffer.from([2, 0, 0]),
  ]);
}

/** 生成一个 $wbEncrypted 信封。 */
function seal(plain: string, key: Buffer, keyId = 'test-key-id'): { $wbEncrypted: 1; envelope: string } {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad({ suite: 1, keyId }));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(
      JSON.stringify({
        suite: 1,
        keyId,
        nonce: nonce.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }),
    ).toString('base64'),
  };
}

const KEY = crypto.createHash('sha256').update('unit-test-at-rest-secret', 'utf8').digest();

test('明文凭据：直接提取 accessToken 与账号信息', () => {
  const content = extractAuthContent({
    account: { uid: 'uid-plain-1', nickname: '小明', phoneNumber: '13800001111', type: 'personal' },
    auth: { accessToken: 'plain-token-value', refreshToken: 'rt', expiresAt: 1893456000000, domain: 'workbuddy.cn' },
  });
  assert.ok(content.credentials);
  assert.equal(content.credentials?.accessToken, 'plain-token-value');
  assert.equal(content.account?.uid, 'uid-plain-1');
  assert.equal(content.account?.nickname, '小明');
  assert.equal(content.encrypted, false);
  assert.equal(content.credentialError, null);
});

test('加密凭据：用派生密钥可以解开并通过校验', () => {
  const envelope = seal('sealed-access-token', KEY);
  const json = {
    account: { uid: 'uid-enc-1', nickname: '小红' },
    auth: { accessToken: envelope, refreshToken: seal('sealed-refresh', KEY), expiresAt: 1893456000000 },
  };
  const content = extractAuthContent(json, { key: KEY });
  assert.ok(content.encrypted);
  assert.equal(content.credentials?.accessToken, 'sealed-access-token');
  assert.equal(content.credentials?.refreshToken, 'sealed-refresh');
  assert.equal(content.credentialError, null);
});

test('加密凭据缺少密钥：不抛错，给出可读的失败原因', () => {
  const json = { auth: { accessToken: seal('x', KEY) } };
  const content = extractAuthContent(json, { key: null, keyError: '未找到客户端可执行文件' });
  assert.equal(content.credentials, null);
  assert.match(content.credentialError ?? '', /未找到客户端可执行文件/);
});

test('密钥不匹配：解密失败按"已加密"降级，不会返回半截明文', () => {
  const wrongKey = crypto.createHash('sha256').update('wrong', 'utf8').digest();
  const json = { auth: { accessToken: seal('value', KEY) } };
  const content = extractAuthContent(json, { key: wrongKey });
  assert.equal(content.credentials, null);
  assert.match(content.credentialError ?? '', /解密失败/);
});

test('openEnvelope 对损坏信封返回 null', () => {
  assert.equal(openEnvelope({ $wbEncrypted: 1, envelope: 'not-base64-json' }, KEY), null);
  const tampered = seal('value', KEY);
  const body = JSON.parse(Buffer.from(tampered.envelope, 'base64').toString('utf8'));
  body.authTag = Buffer.alloc(16).toString('base64');
  assert.equal(openEnvelope({ $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(body)).toString('base64') }, KEY), null);
});

test('readAuthFile 读取明文文件；禁用取钥时对加密文件给出明确原因', () => {
  const dir = tempDir();
  const plainFile = path.join(dir, 'plain.info');
  fs.writeFileSync(plainFile, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't1', expiresAt: 1893456000000 } }));

  const plain = readAuthFile(plainFile, 'workbuddy-cn');
  assert.equal(plain.credentials?.accessToken, 't1');

  const encFile = path.join(dir, 'enc.info');
  fs.writeFileSync(encFile, JSON.stringify({ account: { uid: 'u2' }, auth: { accessToken: seal('t2', KEY) } }));
  const enc = readAuthFile(encFile, 'workbuddy-cn', { allowKeyDerivation: false, exePath: null });
  assert.equal(enc.credentials, null);
  assert.match(enc.credentialError ?? '', /未找到|已禁用/);
});

test('readAuthFile 对损坏 JSON 不抛异常', () => {
  const dir = tempDir();
  const file = path.join(dir, 'broken.info');
  fs.writeFileSync(file, '{ not json');
  const content = readAuthFile(file, 'workbuddy-cn');
  assert.equal(content.credentials, null);
  assert.match(content.credentialError ?? '', /格式异常/);
});

test('inspectToken 只暴露签发域与过期时间', () => {
  const token = fakeJwt({ iss: 'https://www.workbuddy.cn/auth/realms/copilot', exp: 1893456000, sub: 'abc' });
  const info = inspectToken(token);
  assert.equal(info.issuerOrigin, 'https://www.workbuddy.cn');
  assert.equal(info.expiresAt, 1893456000 * 1000);
  assert.equal(info.subject, 'abc');

  const bad = inspectToken('garbage');
  assert.equal(bad.issuerOrigin, null);
  assert.equal(bad.expiresAt, null);
});

test('isTokenUsable：过期与即将过期都视为不可用', () => {
  const now = Date.now();
  assert.equal(isTokenUsable(null, now), false);
  assert.equal(
    isTokenUsable({ accessToken: 'x', refreshToken: '', expiresAt: now + 10 * 60_000, refreshExpiresAt: null, lastRefreshTime: null, domain: '' }, now),
    true,
  );
  assert.equal(
    isTokenUsable({ accessToken: 'x', refreshToken: '', expiresAt: now + 30_000, refreshExpiresAt: null, lastRefreshTime: null, domain: '' }, now),
    false,
  );
  assert.equal(
    isTokenUsable({ accessToken: 'x', refreshToken: '', expiresAt: now - 1000, refreshExpiresAt: null, lastRefreshTime: null, domain: '' }, now),
    false,
  );
});
