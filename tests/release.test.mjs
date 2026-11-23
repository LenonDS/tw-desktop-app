import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DataStore } = require('../dist-electron/store.js');
const {
  ENCRYPTED_SECRET_PREFIX,
  NOOP_SECRET_CIPHER,
  decryptStoreSecrets,
  encryptStoreSecrets,
} = require('../dist-electron/secretCrypto.js');
const { FileLogger, redactSensitiveText } = require('../dist-electron/fileLogger.js');

function createMockCipher() {
  return {
    isAvailable: () => true,
    encrypt: (plain) =>
      plain.startsWith(ENCRYPTED_SECRET_PREFIX)
        ? plain
        : `${ENCRYPTED_SECRET_PREFIX}${Buffer.from(plain, 'utf-8').toString('base64')}`,
    decrypt: (stored) =>
      stored.startsWith(ENCRYPTED_SECRET_PREFIX)
        ? Buffer.from(stored.slice(ENCRYPTED_SECRET_PREFIX.length), 'base64').toString('utf-8')
        : stored,
  };
}

test('secretCrypto encrypts/decrypts store secrets without mutating memory and supports legacy plaintext', () => {
  const cipher = createMockCipher();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crypto-test-'));

  try {
    const store = new DataStore(tmpDir, { cipher });
    const account = store.createAccount({
      username: 'PlayerOne',
      domain: 'tribalwars.com.br',
      world: 'br130',
      credentials: { username: 'PlayerOne', password: 'super-secret-password', autoLogin: true },
      proxy: {
        enabled: true,
        protocol: 'http',
        host: '10.0.0.1',
        port: 8080,
        username: 'proxyuser',
        password: 'proxy-password',
      },
      cookies: [{ name: 'sid', value: 'cookie-secret-val', domain: '.tribalwars.com.br' }],
    });

    store.saveProxy({
      enabled: true,
      label: 'Test Proxy',
      protocol: 'socks5',
      host: '10.0.0.2',
      port: 1080,
      username: 'p2',
      password: 'saved-proxy-password',
    });

    // In-memory objects must remain plaintext for runtime use
    const inMemAccount = store.getAccountById(account._id);
    assert.equal(inMemAccount.credentials.password, 'super-secret-password');
    assert.equal(inMemAccount.proxy.password, 'proxy-password');
    assert.equal(inMemAccount.cookies[0].value, 'cookie-secret-val');

    // Disk file must store encrypted values with enc:v1: prefix
    const diskJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tw-store.json'), 'utf-8'));
    assert.ok(diskJson.accounts[0].credentials.password.startsWith(ENCRYPTED_SECRET_PREFIX));
    assert.ok(diskJson.accounts[0].proxy.password.startsWith(ENCRYPTED_SECRET_PREFIX));
    assert.ok(diskJson.accounts[0].cookies[0].value.startsWith(ENCRYPTED_SECRET_PREFIX));
    assert.ok(diskJson.proxies[0].password.startsWith(ENCRYPTED_SECRET_PREFIX));
    assert.ok(!JSON.stringify(diskJson).includes('super-secret-password'));
    assert.ok(!JSON.stringify(diskJson).includes('saved-proxy-password'));

    // Reloading with the same cipher restores plaintext
    const reloaded = new DataStore(tmpDir, { cipher });
    const loadedAcc = reloaded.getAccountById(account._id);
    assert.equal(loadedAcc.credentials.password, 'super-secret-password');
    assert.equal(loadedAcc.proxy.password, 'proxy-password');
    assert.equal(loadedAcc.cookies[0].value, 'cookie-secret-val');
    assert.equal(reloaded.getProxies()[0].password, 'saved-proxy-password');

    // Legacy plaintext schema decrypts cleanly and NOOP cipher protects missing key
    const legacy = {
      accounts: [{ _id: '1', credentials: { username: 'u', password: 'legacy-plain', autoLogin: true }, cookies: [] }],
      proxies: [{ enabled: true, protocol: 'http', host: '1.2.3.4', port: 80, password: 'legacy-proxy-plain' }],
    };
    const decLegacy = decryptStoreSecrets(legacy, cipher);
    assert.equal(decLegacy.accounts[0].credentials.password, 'legacy-plain');
    assert.equal(decLegacy.proxies[0].password, 'legacy-proxy-plain');

    const encSchema = encryptStoreSecrets(legacy, cipher);
    const noopDecrypted = decryptStoreSecrets(encSchema, NOOP_SECRET_CIPHER);
    assert.equal(noopDecrypted.accounts[0].credentials.password, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FileLogger redacts sensitive values and rotates app.log when maxBytes is reached', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-logger-test-'));

  try {
    const redacted = redactSensitiveText(
      'Proxy http://user:myPass123@10.0.0.1:8080 failed; password=secretValue1 token=abc999 {"cookie":"xyz"}'
    );
    assert.ok(!redacted.includes('myPass123'));
    assert.ok(!redacted.includes('secretValue1'));
    assert.ok(!redacted.includes('abc999'));
    assert.ok(!redacted.includes('xyz'));
    assert.ok(redacted.includes('[REDACTED]'));

    const logger = new FileLogger(tmpDir, { maxBytes: 1024 });
    for (let i = 0; i < 30; i++) {
      logger.write('info', `Event #${i} password=leak-${i} details=${'x'.repeat(60)}`, 'AccOne');
    }

    assert.ok(fs.existsSync(logger.getLogFilePath()));
    assert.ok(fs.existsSync(`${logger.getLogFilePath()}.1`));

    const recent = logger.readRecent();
    assert.ok(!recent.includes('leak-'));
    assert.ok(recent.includes('[REDACTED]'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
