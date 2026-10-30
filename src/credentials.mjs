import { createHash } from 'node:crypto';
import { CtyunError } from './session.mjs';

const SERVICE = 'magpie-ctyun-coding-plan';
export function credentialId(account) { return createHash('sha256').update(account).digest('hex'); }

export class CredentialStore {
  async entry(id) {
    try {
      const { Entry } = await import('@napi-rs/keyring');
      return new Entry(SERVICE, id, process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
    } catch { throw new CtyunError('无法使用系统凭据库；请启用钥匙串/凭据管理器，或选择浏览器登录', 'KEYRING'); }
  }
  async set(id, credentials) {
    try { (await this.entry(id)).setPassword(JSON.stringify(credentials)); }
    catch (error) {
      if (error instanceof CtyunError) throw error;
      throw new CtyunError('系统凭据库拒绝保存账号密码，请选择浏览器登录', 'KEYRING');
    }
  }
  async get(id) {
    try {
      const value = (await this.entry(id)).getPassword();
      return value ? JSON.parse(value) : null;
    } catch { return null; }
  }
  async remove(id, { optional = false } = {}) {
    let entry;
    try { entry = await this.entry(id); }
    catch (error) { if (optional) return false; throw error; }
    try {
      if (entry.getPassword() === null) return false;
      return entry.deletePassword();
    } catch {
      if (optional) return false;
      throw new CtyunError('系统凭据库未能移除旧密码，请在系统凭据管理器中处理后重试', 'KEYRING');
    }
  }
}
