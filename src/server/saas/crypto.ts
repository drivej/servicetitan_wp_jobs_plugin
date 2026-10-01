import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const randomToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const csrfToken = (session: string): string => hashToken(`csrf:${session}`);

export class SecretVault {
  private readonly keys = new Map<string, Buffer>();
  constructor(keys: Record<string, string>, private readonly activeKey: string) {
    for (const [id, value] of Object.entries(keys)) {
      const key = Buffer.from(value, 'base64');
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || key.length !== 32 || key.toString('base64') !== value) {
        throw new Error('Encryption keys must be canonical base64-encoded 32-byte keys with valid key IDs.');
      }
      this.keys.set(id, key);
    }
    if (!this.keys.has(activeKey)) throw new Error('Active encryption key is missing.');
  }
  encrypt(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKey)!, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, key: this.activeKey, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  }
  decrypt<T>(envelope: string, context: string): T {
    const data = JSON.parse(envelope) as { v: number; key: string; iv: string; tag: string; data: string };
    const key = this.keys.get(data.key);
    if (data.v !== 1 || !key) throw new Error('Credential encryption key is unavailable.');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8')) as T;
  }
}
