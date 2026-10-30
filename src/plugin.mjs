import { createHash } from 'node:crypto';
import { AuthError, CtyunError, CtyunSession, BASE, modelCatalog } from './session.mjs';
import { CredentialStore, credentialId } from './credentials.mjs';
import { browserLogin } from './browser.mjs';
import { adaptReasoning, ReasoningSettingError } from './model-profiles.mjs';
import { normalizeSSE } from './sse.mjs';

export const PROVIDER = 'ctyun-coding-plan';
const SNAPSHOT = [
  ['deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'], ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['deepseek-v4-flash-0731-oc', 'DeepSeek-V4-Flash-0731'], ['MiniMax-M2.5-oc', 'MiniMax-M2.5'],
  ['glm-5.1-oc', 'GLM-5.1'], ['kimi-k2.5-oc', 'Kimi-K2.5'],
  ['deepseek-v4-pro-0813-oc', 'DeepSeek-V4-Pro-0813'], ['glm-5.3-oc', 'GLM-5.3'], ['qwen-3.6-flash-oc', 'Qwen-3.6-Flash'],
];
const REQUIRED = value => typeof value === 'string' && value.trim() ? undefined : '此项不能为空';
const MESSAGE = error => error instanceof CtyunError ? error.message : '操作未完成，请稍后重试';
const fingerprint = auth => JSON.stringify([auth.refresh, auth.ctyun]);

export function savedAuth(session, inputs, mode, ref) {
  return { type: 'success', refresh: JSON.stringify(session.state()), access: inputs.api_key.trim(),
    expires: session.expires(), accountId: inputs.account_name.trim(),
    ctyun: { version: 1, mode, deviceCode: session.deviceCode, planId: inputs.plan_id?.trim() || '',
      ...(ref ? { credentialRef: ref } : {}) } };
}

export class SessionManager {
  constructor({ sessionFactory, credentials, persist }) {
    this.make = sessionFactory;
    this.credentials = credentials;
    this.persist = persist;
    this.pending = new Map();
    this.latest = new Map();
  }

  async recover(session, auth) {
    if (auth.ctyun?.reauthRequired) throw new AuthError(auth.ctyun.portalError);
    try { await session.sso(); }
    catch (error) {
      if (!(error instanceof AuthError)) throw error;
      if (auth.ctyun?.mode !== 'password' || !auth.ctyun.credentialRef) throw error;
      const credentials = await this.credentials.get(auth.ctyun.credentialRef);
      if (!credentials?.username || !credentials.password) throw new AuthError('系统凭据库中没有可用的账号密码，请重新登录');
      await session.passwordLogin(credentials.username, credentials.password);
    }
  }

  async update(auth, session, extra = {}, saveChanges = true) {
    const next = { ...auth, refresh: JSON.stringify(session.state()), expires: session.expires(),
      ctyun: { ...auth.ctyun, portalError: '', reauthRequired: false }, ...extra };
    if (saveChanges && JSON.stringify(auth) !== JSON.stringify(next)) await this.persist(next);
    return next;
  }

  // Serialize per account: concurrent quota/model reads cannot overwrite a renewed
  // cookie jar or submit the same password several times. The host scopes auth.set.
  async run(getAuth, operation, forceRefresh = false, saveChanges = true) {
    const initial = await getAuth();
    if (initial?.type !== 'oauth' || !initial.ctyun) throw new AuthError('请先登录天翼云 Coding Plan');
    const id = createHash('sha256').update(`${initial.accountId}\0${initial.access}`).digest('hex');
    const previous = this.pending.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      let auth = await getAuth();
      const latest = this.latest.get(id);
      if (latest && (fingerprint(auth) === latest.source || fingerprint(auth) === fingerprint(latest.auth))) auth = latest.auth;
      let state;
      try { state = JSON.parse(auth.refresh); } catch { throw new AuthError('本地登录会话损坏，请重新登录'); }
      const session = this.make({ state, deviceCode: auth.ctyun.deviceCode });
      try {
        if (forceRefresh) await this.recover(session, auth);
        let value;
        try { value = await operation(session, auth); }
        catch (error) {
          if (!(error instanceof AuthError) || forceRefresh) throw error;
          await this.recover(session, auth);
          value = await operation(session, auth);
        }
        const updated = await this.update(auth, session, {}, saveChanges);
        this.latest.set(id, { source: fingerprint(initial), auth: updated });
        return { value, auth: updated };
      } catch (error) {
        const reauth = error instanceof AuthError || ['captcha', 'sms'].includes(error.code);
        const failed = { ...auth, refresh: JSON.stringify(session.state()), expires: Date.now() + (reauth ? 86400_000 : 60_000),
          ctyun: { ...auth.ctyun, portalError: MESSAGE(error), reauthRequired: reauth } };
        if (saveChanges) await this.persist(failed);
        this.latest.set(id, { source: fingerprint(initial), auth: failed });
        throw error;
      }
    });
    this.pending.set(id, task);
    try { return await task; }
    finally { if (this.pending.get(id) === task) this.pending.delete(id); }
  }
}

export async function createPlugin({ client }, dependencies = {}) {
  const credentials = dependencies.credentials || new CredentialStore();
  const sessionFactory = dependencies.sessionFactory || (options => new CtyunSession(options));
  const browser = dependencies.browserLogin || browserLogin;
  const request = dependencies.fetchImpl || globalThis.fetch;
  const persist = async body => { await client.auth.set({ path: { id: PROVIDER }, body }); };
  const sessions = new SessionManager({ sessionFactory, credentials, persist });
  const common = [
    { type: 'text', key: 'account_name', message: '账号名称（用于区分多个账号）', placeholder: '天翼云个人账号', validate: REQUIRED },
    { type: 'password', key: 'api_key', message: 'Coding Plan API Key', placeholder: '填写套餐专用密钥', validate: REQUIRED },
    { type: 'text', key: 'plan_id', message: '套餐 ID（只有一个有效套餐时留空）' },
  ];

  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= { name: '天翼云 Coding Plan', npm: '@ai-sdk/openai-compatible', api: BASE,
        models: modelCatalog({ models: SNAPSHOT.map(([model, title]) => ({ model, title, api: ['openai-completions'] })) }) };
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: 'oauth', label: '浏览器单点登录（不保存密码）', prompts: common,
          async authorize(inputs) {
            return { method: 'auto', opened: true, instructions: '将在本机打开专用登录窗口；请在天翼云官网完成登录，成功后窗口自动关闭。',
              async callback() {
                try {
                  validateInputs(inputs);
                  const session = await browser();
                  const id = credentialId(inputs.account_name.trim());
                  await credentials.remove(id, { optional: true });
                  return savedAuth(session, inputs, 'browser');
                } catch (error) { return { type: 'failed', error: MESSAGE(error) }; }
              } };
          },
        },
        {
          type: 'oauth', label: '账号密码登录（保存到系统凭据库，自动重登）',
          prompts: [...common,
            { type: 'text', key: 'username', message: '天翼云账号（手机号／邮箱／账号名）', validate: REQUIRED },
            { type: 'password', key: 'password', message: '天翼云密码（将保存在系统凭据库中）', validate: REQUIRED },
          ],
          async authorize(inputs) {
            return { method: 'auto', opened: true, instructions: '正在登录天翼云，并将账号密码保存到系统凭据库。',
              async callback() {
                try {
                  validateInputs(inputs);
                  if (REQUIRED(inputs.username) || !inputs.password) throw new CtyunError('请输入账号和密码', 'INPUT');
                  const session = sessionFactory();
                  await session.passwordLogin(inputs.username, inputs.password);
                  await session.models();
                  const id = credentialId(inputs.account_name.trim());
                  await credentials.set(id, { username: inputs.username.trim(), password: inputs.password });
                  return savedAuth(session, inputs, 'password', id);
                } catch (error) { return { type: 'failed', error: MESSAGE(error) }; }
                finally { if (inputs) inputs.password = ''; }
              } };
          },
        },
      ],
      refreshLead: 60_000,
      async refresh(auth) {
        try {
          // The host owns saving this patch under its renewal lock.
          return (await sessions.run(async () => auth, s => s.models(), true, false)).auth;
        } catch (error) {
          // Website auth is separate from the inference key: do not mark the
          // whole MAGPIE account expired when only portal metadata is unavailable.
          const reauth = error instanceof AuthError || ['captcha', 'sms'].includes(error.code);
          return { expires: Date.now() + (reauth ? 86400_000 : 60_000),
            ctyun: { ...auth.ctyun, portalError: MESSAGE(error), reauthRequired: reauth } };
        }
      },
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth?.access) return {};
        return { baseURL: BASE, apiKey: auth.access,
          async fetch(input, init) {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.origin !== new URL(BASE).origin || !url.href.startsWith(BASE + '/')) {
              throw new CtyunError('已阻止向非套餐接口发送 API Key', 'ORIGIN');
            }
            const current = await getAuth();
            let req = new Request(input, init);
            const headers = new Headers(req.headers);
            headers.delete('cookie');
            headers.delete('yl-authorization');
            headers.delete('x-api-key');
            headers.set('authorization', `Bearer ${current.access}`);
            if (req.method === 'POST' && /\/(?:v1\/)?chat\/completions\/?$/.test(url.pathname)) {
              // JSON calls are small request bodies, not response streams.
              // Use a clone so unknown/malformed request formats pass through.
              let body;
              try { body = await req.clone().json(); } catch { /* upstream validates */ }
              try {
                const adapted = adaptReasoning(body);
                if (adapted !== body) {
                  headers.delete('content-length');
                  req = new Request(req, { body: JSON.stringify(adapted) });
                }
              } catch (error) {
                if (!(error instanceof ReasoningSettingError)) throw error;
                return Response.json({ error: { type: 'invalid_request_error', code: 'unsupported_reasoning_setting', message: error.message } }, { status: 400 });
              }
            }
            return normalizeSSE(await request(new Request(req, { headers, redirect: 'manual' })));
          } };
      },
      async usage(getAuth) {
        try {
          const { value } = await sessions.run(getAuth, (s, a) => s.quota(a.ctyun.planId));
          return { ...value, signIn: 'kept' };
        } catch (error) { return { windows: [], error: MESSAGE(error), signIn: 'kept' }; }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth?.ctyun) return provider.models;
        try {
          const { value } = await sessions.run(async () => auth, s => s.models());
          return modelCatalog(value, provider.models);
        } catch { return provider.models; }
      },
    },
  };
}

function validateInputs(inputs) {
  if (REQUIRED(inputs?.account_name) || REQUIRED(inputs?.api_key)) throw new CtyunError('请填写账号名称和 Coding Plan API Key', 'INPUT');
}

export const CtyunCodingPlanPlugin = async input => createPlugin(input);
