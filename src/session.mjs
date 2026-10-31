import { createHash, randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { modelId, reasoningConfig, modelCost } from './model-profiles.mjs';

export const APP = 'https://eaichat.ctyun.cn';
export const IAM = 'https://desk.ctyun.cn/cloudB/dy/iam/';
export const BASE = `${APP}/ai/platform/v2/cp`;
export const SERVICE = `${APP}:443/chat/#/aichat`;
export const ENTRY = `${IAM}api/auth/iam/cas/login?${new URLSearchParams({ service: SERVICE, consent: 'false' })}`;
const HOSTS = new Set(['eaichat.ctyun.cn', 'desk.ctyun.cn']);

export class CtyunError extends Error {
  constructor(message, code = 'UPSTREAM') { super(message); this.name = 'CtyunError'; this.code = code; }
}
export class AuthError extends CtyunError {
  constructor(message = '网页登录会话已失效，请重新登录') { super(message, 'AUTH'); }
}
export class ChallengeError extends CtyunError {
  constructor(kind) {
    super(kind === 'captcha' ? '天翼云要求图形验证码，请改用浏览器登录并人工完成验证' : '天翼云要求短信验证，请改用浏览器登录并人工完成验证', kind);
  }
}

export function allowedURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new CtyunError('请求地址无效', 'ORIGIN'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || !['', '443'].includes(url.port) || url.username || url.password) {
    throw new CtyunError('已阻止向非预期地址发送天翼云登录信息', 'ORIGIN');
  }
  return url;
}

export function ticketFrom(url) {
  const u = allowedURL(url);
  if (u.hostname !== 'eaichat.ctyun.cn') return null;
  const fragment = u.hash.includes('?') ? u.hash.slice(u.hash.indexOf('?') + 1) : '';
  return new URLSearchParams(fragment).get('ticket') || u.searchParams.get('ticket');
}

export class CtyunSession {
  constructor({ state, deviceCode, fetchImpl = globalThis.fetch } = {}) {
    try { this.jar = state ? CookieJar.deserializeSync(state) : new CookieJar(); }
    catch { throw new AuthError('本地登录会话无法读取，请重新登录'); }
    this.deviceCode = deviceCode || `iam:${randomBytes(16).toString('hex')}`;
    this.fetch = fetchImpl;
  }

  state() { return this.jar.serializeSync(); }

  expires() {
    const expiries = this.jar.getCookiesSync(APP)
      .filter(c => ['YL-Token', 'YL-Ssid'].includes(c.key))
      .map(c => c.expiryTime()).filter(Number.isFinite);
    return expiries.length ? Math.min(...expiries) : Date.now() + 3600_000;
  }

  async request(address, { body, form = false } = {}) {
    let url = allowedURL(address);
    let data = body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    for (let i = 0; i < 12; i++) {
      const headers = new Headers({ Accept: 'application/json, text/html', 'User-Agent': 'magpie-ctyun-coding-plan/0.2.0' });
      const cookie = await this.jar.getCookieString(url.href);
      if (cookie) headers.set('Cookie', cookie);
      if (data !== undefined) {
        headers.set('Content-Type', form ? 'application/x-www-form-urlencoded' : 'application/json');
        headers.set('Origin', url.origin);
      }
      let response;
      try {
        response = await this.fetch(url.href, { method: data === undefined ? 'GET' : 'POST', body: data,
          headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      } catch { throw new CtyunError('无法连接天翼云，请检查网络后重试', 'NETWORK'); }
      for (const value of response.headers.getSetCookie()) {
        try { await this.jar.setCookie(value, url.href); }
        catch { /* Match browsers: discard invalid/foreign-domain Set-Cookie headers. */ }
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new CtyunError('天翼云登录跳转缺少地址');
        const next = allowedURL(new URL(location, url).href);
        if (data !== undefined && [307, 308].includes(response.status) && next.origin !== url.origin) {
          throw new CtyunError('已阻止跨域转发登录表单', 'ORIGIN');
        }
        if ([301, 302, 303].includes(response.status)) data = undefined;
        url = next;
        continue;
      }
      let payload = null;
      try { payload = await response.json(); } catch { /* Login pages may be HTML. */ }
      return { status: response.status, url: url.href, payload };
    }
    throw new CtyunError('天翼云登录跳转次数过多');
  }

  async authorizeTicket(ticket) {
    const { status, payload } = await this.request(`${APP}/sso/login/v2/iam/ticketAuthorize`, {
      body: { loginType: 'iamTicket', clientId: 'eaiapp', iamTicket: ticket, jwtType: '3', redirectUri: SERVICE }, form: true,
    });
    if ([401, 403].includes(status)) throw new AuthError();
    if (status !== 200 || payload?.resultCode !== 0) throw new AuthError('天翼云未接受单点登录票据，请重新登录');
  }

  async sso(address = ENTRY) {
    const { status, url } = await this.request(address);
    const ticket = ticketFrom(url);
    if (status >= 500) throw new CtyunError('天翼云登录服务暂不可用');
    if (!ticket) throw new AuthError('单点登录会话已失效，需要重新登录');
    await this.authorizeTicket(ticket);
  }

  async passwordLogin(username, password) {
    if (!username?.trim() || !password) throw new CtyunError('请输入账号和密码', 'INPUT');
    await this.request(ENTRY);
    const { status, payload } = await this.request(`${IAM}api/auth/iam/login`, { body: {
      userAccount: username.trim(), password: createHash('sha256').update(password).digest('hex'),
      deviceCode: this.deviceCode, deviceName: 'iam:web',
    } });
    if (payload?.code === 51040) throw new ChallengeError('captcha');
    if (payload?.data?.needSmsValidate === 1) throw new ChallengeError('sms');
    if (status >= 500) throw new CtyunError('天翼云登录服务暂不可用');
    if (status !== 200 || payload?.code !== 0) throw new AuthError('账号密码登录失败，请检查凭据或改用浏览器登录');
    await this.sso(payload.data?.returnUrl || ENTRY);
  }

  async portal(path, params) {
    const url = new URL(`/ai/portal/v1/${path}`, APP);
    if (params) url.search = new URLSearchParams(params).toString();
    const { status, payload } = await this.request(url.href);
    if ([401, 403].includes(status) || [401, 403].includes(payload?.resultCode)) throw new AuthError();
    if (status !== 200 || payload?.resultCode !== 0 || payload.data == null) {
      throw new CtyunError('天翼云元数据接口未成功返回，请稍后重试');
    }
    return payload.data;
  }

  models() { return this.portal('platform/cp/model/apiAccess'); }

  async quota(planId, now = Date.now()) {
    const summary = await this.portal('platform/cp/codingplan/usage/summry');
    const plans = (summary.paid || []).filter(p => p.state === '已购买' && (!parseChinaTime(p.expTime) || parseChinaTime(p.expTime) > now));
    const plan = planId ? plans.find(p => String(p.id) === String(planId)) : plans.length === 1 ? plans[0] : null;
    if (!plan) throw new CtyunError(plans.length > 1 ? '存在多个有效套餐，请重新登录并填写套餐 ID' : '未找到所选账号的有效 Coding Plan 套餐', 'PLAN');
    const details = await this.portal('platform/cp/codingplan/usage/detail', { id: plan.id });
    return quotaWindows(plan, details, now);
  }
}

export function parseChinaTime(value) {
  if (!value || typeof value !== 'string') return null;
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

export function hintSeconds(hint) {
  if (typeof hint !== 'string' || !hint.includes('后刷新')) return null;
  let total = 0;
  let found = false;
  for (const match of hint.matchAll(/(\d+)\s*(天|小时|时|分钟|分|秒)/g)) {
    found = true;
    total += Number(match[1]) * ({ 天: 86400, 小时: 3600, 时: 3600, 分钟: 60, 分: 60, 秒: 1 })[match[2]];
  }
  return found ? total : null;
}

export function quotaWindows(plan, details, now = Date.now()) {
  const labels = { 近5小时: ['5 hours', 18000], 本周: ['Weekly', 604800], 套餐总量: ['Plan total', null] };
  if (!Array.isArray(details.usages)) throw new CtyunError('官方额度响应格式已变化');
  const seen = new Set();
  const sampled = Number(details.updateTime);
  const timestamp = Number.isFinite(sampled) && sampled > 0 ? sampled : now;
  const until = parseChinaTime(plan.expTime);
  const begin = parseChinaTime(plan.effTime);
  const windows = details.usages.flatMap(row => {
    const spec = labels[row.period];
    if (!spec) return [];
    if (seen.has(row.period)) throw new CtyunError('官方额度周期重复，无法可靠解析');
    seen.add(row.period);
    const fraction = row.usage;
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0) throw new CtyunError('官方额度比例无效');
    const seconds = hintSeconds(row.tips);
    const window = { name: spec[0], used: fraction * 100,
      display: `${row.period} · 已用 ${Number((fraction * 100).toFixed(1))}%${row.tips ? ` · ${row.tips}` : ''}` };
    if (spec[1]) window.span = spec[1];
    if (seconds !== null) window.resetsAt = new Date(timestamp + seconds * 1000).toISOString();
    if (row.period === '套餐总量') {
      if (until) window.resetsAt = new Date(until).toISOString();
      if (until && begin && until > begin) window.span = (until - begin) / 1000;
    }
    return [window];
  });
  if (seen.size !== 3) throw new CtyunError('未找到完整的三个官方额度周期');
  return { plan: plan.name, ...(until ? { until: new Date(until).toISOString() } : {}), windows };
}

export function modelCatalog(data, previous) {
  if (!Array.isArray(data.models)) throw new CtyunError('官方模型清单格式已变化');
  const rows = data.models.filter(m => typeof m.model === 'string' && m.model && m.api?.includes('openai-completions'));
  if (!rows.length) throw new CtyunError('官方未返回可调用的模型');
  return Object.fromEntries(rows.map(m => {
    const id = modelId(m.model);
    const reasoning = reasoningConfig(id);
    const price = modelCost(id);
    const model = { id, name: id === 'glm-5.3' ? 'GLM-5.3' : modelId(m.title || m.model), tool_call: true,
      modalities: { input: ['text'], output: ['text'] }, ...reasoning, ...(price ? { cost: price } : {}) };
    if (previous === undefined) return [id, model];
    // provider.models receives normalized models, unlike config. Keep API,
    // limits and cost metadata or dynamic discovery erases host capabilities.
    const was = previous[id] ?? previous[m.model];
    return [id, { ...was, ...model,
      api: { ...(was?.api ?? { url: BASE, npm: '@ai-sdk/openai-compatible' }), id },
      limit: was?.limit ?? { context: 0, output: 0 },
      cost: was?.cost ?? (price ? { input: price.input, output: price.output,
        cache: { read: price.cache_read ?? 0, write: price.cache_write ?? 0 } } : { input: 0, output: 0 }),
      capabilities: { toolcall: true, input: { text: true }, output: { text: true },
        ...was?.capabilities, ...(reasoning.reasoning ? { reasoning: true } : {}) },
    }];
  }));
}
