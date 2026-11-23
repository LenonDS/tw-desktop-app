import fs from 'node:fs';
import path from 'node:path';

export type FileLogLevel = 'info' | 'success' | 'warn' | 'error';

export interface FileLoggerOptions {
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Redacts credentials, cookies, tokens, and userinfo URLs from log output.
 */
export function redactSensitiveText(input: string): string {
  if (!input) return '';
  let out = input;
  // Redact URLs with embedded credentials: protocol://user:pass@host
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/g, '$1$2:[REDACTED]@');
  // Redact JSON-like key/value pairs: "password": "..." / "cookie": "..." / "token": "..."
  out = out.replace(
    /("(?:password|passwd|proxyPass|cookie|cookies|token|secret|authorization)"\s*:\s*")([^"]*)(")/gi,
    '$1[REDACTED]$3'
  );
  // Redact query/form-style key=value secrets
  out = out.replace(
    /\b(password|passwd|proxyPass|cookie|token|secret|cid)=([^&\s;]+)/gi,
    '$1=[REDACTED]'
  );
  return out;
}

/**
 * Rotating file logger under userData/logs/app.log for post-mortem debugging.
 */
export class FileLogger {
  private readonly logDir: string;
  private readonly filePath: string;
  private readonly backupPath: string;
  private readonly maxBytes: number;

  constructor(logDir: string, options: FileLoggerOptions = {}) {
    this.logDir = logDir;
    this.filePath = path.join(logDir, 'app.log');
    this.backupPath = path.join(logDir, 'app.log.1');
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch {
      // Ignore initialization failure so logging never crashes the app
    }
  }

  public getLogDir(): string {
    return this.logDir;
  }

  public getLogFilePath(): string {
    return this.filePath;
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stat = fs.statSync(this.filePath);
      if (stat.size < this.maxBytes) return;
      if (fs.existsSync(this.backupPath)) {
        fs.unlinkSync(this.backupPath);
      }
      fs.renameSync(this.filePath, this.backupPath);
    } catch {
      // Ignore rotation failures
    }
  }

  public write(level: FileLogLevel, message: string, context?: string): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      this.rotateIfNeeded();
      const ts = new Date().toISOString();
      const ctx = context ? ` [${redactSensitiveText(context)}]` : '';
      const safeMsg = redactSensitiveText(message).replace(/\r?\n/g, ' | ');
      const line = `[${ts}] [${level.toUpperCase()}]${ctx} ${safeMsg}\n`;
      fs.appendFileSync(this.filePath, line, 'utf-8');
    } catch {
      // Never throw from file logging
    }
  }

  public readRecent(maxBytes = 512 * 1024): string {
    try {
      if (!fs.existsSync(this.filePath)) return '';
      const stat = fs.statSync(this.filePath);
      if (stat.size <= maxBytes) {
        return fs.readFileSync(this.filePath, 'utf-8');
      }
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
        return buffer.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }
}
