import type { StoreSchema } from './types';

export const ENCRYPTED_SECRET_PREFIX = 'enc:v1:';

export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

/**
 * Fallback no-op cipher when Electron safeStorage is unavailable (e.g., plain Node test runner).
 */
export const NOOP_SECRET_CIPHER: SecretCipher = {
  isAvailable: () => false,
  encrypt: (plain: string) => plain,
  decrypt: (stored: string) => (stored.startsWith(ENCRYPTED_SECRET_PREFIX) ? '' : stored),
};

/**
 * Creates a SecretCipher backed by Electron's OS keychain / DPAPI safeStorage API.
 * Falls back safely to NOOP_SECRET_CIPHER outside Electron runtime.
 */
export function createElectronSafeStorageCipher(): SecretCipher {
  try {
    // Lazy require keeps store.ts importable under plain Node.js unit tests
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    const safeStorage = electron?.safeStorage;
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
      return NOOP_SECRET_CIPHER;
    }

    return {
      isAvailable: () => {
        try {
          return safeStorage.isEncryptionAvailable();
        } catch {
          return false;
        }
      },
      encrypt: (plain: string) => {
        if (!plain) return '';
        if (plain.startsWith(ENCRYPTED_SECRET_PREFIX)) return plain;
        try {
          if (!safeStorage.isEncryptionAvailable()) return plain;
          const buf = safeStorage.encryptString(plain);
          return `${ENCRYPTED_SECRET_PREFIX}${buf.toString('base64')}`;
        } catch {
          return plain;
        }
      },
      decrypt: (stored: string) => {
        if (!stored) return '';
        if (!stored.startsWith(ENCRYPTED_SECRET_PREFIX)) return stored;
        try {
          if (!safeStorage.isEncryptionAvailable()) return '';
          const payload = stored.slice(ENCRYPTED_SECRET_PREFIX.length);
          return safeStorage.decryptString(Buffer.from(payload, 'base64'));
        } catch {
          return '';
        }
      },
    };
  } catch {
    return NOOP_SECRET_CIPHER;
  }
}

/**
 * Returns a shallow-cloned StoreSchema with account/proxy passwords and cookie values encrypted.
 * Never mutates the in-memory StoreSchema passed in.
 */
export function encryptStoreSecrets(data: StoreSchema, cipher: SecretCipher): StoreSchema {
  return {
    ...data,
    accounts: data.accounts.map((acc) => ({
      ...acc,
      credentials: acc.credentials
        ? {
            ...acc.credentials,
            password: acc.credentials.password
              ? cipher.encrypt(acc.credentials.password)
              : acc.credentials.password,
          }
        : undefined,
      proxy: acc.proxy
        ? {
            ...acc.proxy,
            password: acc.proxy.password ? cipher.encrypt(acc.proxy.password) : acc.proxy.password,
          }
        : undefined,
      cookies: Array.isArray(acc.cookies)
        ? acc.cookies.map((cookie) => ({
            ...cookie,
            value: cookie.value ? cipher.encrypt(cookie.value) : cookie.value,
          }))
        : [],
    })),
    proxies: data.proxies.map((proxy) => ({
      ...proxy,
      password: proxy.password ? cipher.encrypt(proxy.password) : proxy.password,
    })),
  };
}

/**
 * Restores plain-text credentials and cookie values from a persisted StoreSchema.
 * Unencrypted legacy entries pass through untouched for seamless migration.
 */
export function decryptStoreSecrets(data: StoreSchema, cipher: SecretCipher): StoreSchema {
  return {
    ...data,
    accounts: data.accounts.map((acc) => ({
      ...acc,
      credentials: acc.credentials
        ? {
            ...acc.credentials,
            password: acc.credentials.password
              ? cipher.decrypt(acc.credentials.password)
              : acc.credentials.password,
          }
        : undefined,
      proxy: acc.proxy
        ? {
            ...acc.proxy,
            password: acc.proxy.password ? cipher.decrypt(acc.proxy.password) : acc.proxy.password,
          }
        : undefined,
      cookies: Array.isArray(acc.cookies)
        ? acc.cookies.map((cookie) => ({
            ...cookie,
            value: cookie.value ? cipher.decrypt(cookie.value) : cookie.value,
          }))
        : [],
    })),
    proxies: data.proxies.map((proxy) => ({
      ...proxy,
      password: proxy.password ? cipher.decrypt(proxy.password) : proxy.password,
    })),
  };
}
