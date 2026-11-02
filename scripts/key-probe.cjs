'use strict';
/**
 * 静态密钥探针（必须在 WorkBuddy 自己的 Electron 运行时里执行）：
 *   ELECTRON_RUN_AS_NODE=1 <WorkBuddy.exe> scripts/key-probe.cjs
 *
 * 原理：WorkBuddy 用 Electron 私有绑定 electron_browser_workbuddy_storage 暴露
 * 本机"静态加密"配置（loggerGet 返回 JSON）。其中 atRestSecretKey 经 SHA-256
 * 派生即为凭据信封的 AES-256-GCM 密钥。
 *
 * 该绑定只存在于客户端进程内，所以必须以客户端可执行文件作为宿主。
 * 只读：不写文件、不改配置、不联网。密钥仅通过 stdout 管道交给父进程。
 */
const crypto = require('node:crypto');

function fail(code, message) {
  try {
    process.stderr.write(String(message || 'key-probe failed').slice(0, 200));
  } catch (_) {
    /* ignore */
  }
  process.exit(code);
}

try {
  const binding = process._linkedBinding('electron_browser_workbuddy_storage');
  if (!binding || typeof binding.loggerGet !== 'function') fail(3, 'binding-unavailable');
  const payload = JSON.parse(binding.loggerGet());
  if (!payload || payload.version !== 1 || typeof payload.atRestSecretKey !== 'string') {
    fail(4, 'payload-schema-mismatch');
  }
  const key = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
  process.stdout.write('WB_CHECKIN_KEY ' + key.toString('base64') + '\n');
  key.fill(0);
  process.exit(0);
} catch (error) {
  fail(5, error && error.message ? error.message : error);
}
