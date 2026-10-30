// Explicit opt-in: logs into CTYun using a local .env and reads metadata only.
// Does not save credentials/cookies, call inference, or alter MAGPIE settings.
import { resolve } from 'node:path';
import { CtyunSession, APP, CtyunError, modelCatalog } from '../src/session.mjs';

const flag = process.argv.indexOf('--env');
if (flag < 0 || !process.argv[flag + 1]) throw new Error('用法：npm run test:live -- --env /path/to/.env');
process.loadEnvFile(resolve(process.argv[flag + 1]));
const username = process.env.CTYUN_USERNAME;
const password = process.env.CTYUN_PASSWORD;
if (!username || !password) throw new Error('.env 缺少 CTYUN_USERNAME 或 CTYUN_PASSWORD');

try {
  const session = new CtyunSession();
  await session.passwordLogin(username, password);
  const models = modelCatalog(await session.models());
  const quota = await session.quota();
  const before = session.expires();
  for (const cookie of session.jar.getCookiesSync(APP)) {
    if (['YL-Token', 'YL-Ssid'].includes(cookie.key)) await session.jar.store.removeCookie(cookie.domain, cookie.path, cookie.key);
  }
  let denied = false;
  try { await session.models(); } catch (error) { denied = error.code === 'AUTH'; }
  if (!denied) throw new CtyunError('清除 Cookie 后未确认未认证状态');
  await session.sso();
  const after = await session.quota();
  console.log(JSON.stringify({ passwordLogin: 'ok', models: Object.keys(models), plan: quota.plan,
    usedPercent: quota.windows.map(w => ({ name: w.name, used: w.used })),
    cookieLifetimeDays: Number(((before - Date.now()) / 86400_000).toFixed(2)),
    removedCookiesRejected: denied, ssoRecovery: after.windows.length === 3 }, null, 2));
} catch (error) {
  console.error(error instanceof CtyunError ? error.message : '实测失败，未输出可能含凭证的底层错误');
  process.exitCode = 1;
}
