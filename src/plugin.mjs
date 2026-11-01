import { createHash } from 'node:crypto';
import { AuthError, CtyunError, CtyunSession, BASE, modelCatalog } from './session.mjs';
import { CredentialStore, credentialId } from './credentials.mjs';
import { browserLogin } from './browser.mjs';
import { modelId, adaptReasoning, ReasoningSettingError } from './model-profiles.mjs';
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
const hasPortal = auth => auth?.type === 'oauth' && auth.ctyun && auth.ctyun.mode !== 'api-key';
const accountKey = auth => createHash('sha256').update(`${auth.accountId}\0${auth.access}`).digest('hex');

export function savedAuth(session, inputs, mode, ref) {
  return { type: 'success', refresh: JSON.stringify(session.state()), access: inputs.api_key.trim(),
    expires: session.expires(), accountId: inputs.account_name.trim(),
    ctyun: { version: 1, mode, deviceCode: session.deviceCode, planId: inputs.plan_id?.trim() || '',
      ...(ref ? { credentialRef: ref } : {}) } };
}

export class SessionManager {
  constructor({ sessionFactory, credentials }) {
    this.make = sessionFactory;
    this.credentials = credentials;
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

  update(auth, session) {
    return { ...auth, refresh: JSON.stringify(session.state()), expires: session.expires(),
      ctyun: { ...auth.ctyun, portalError: '', reauthRequired: false } };
  }

  // Serialize per account: concurrent quota/model reads cannot overwrite a renewed
  // cookie jar or submit the same password several times. Reads keep changes in
  // memory only: MAGPIE's auth.set can recreate an account deleted concurrently.
  // Only auth.refresh returns a patch for the host's atomic, conditional save.
  async run(getAuth, operation, forceRefresh = false) {
    const initial = await getAuth();
    if (!hasPortal(initial)) throw new AuthError('请先登录天翼云 Coding Plan');
    const id = accountKey(initial);
    const previous = this.pending.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      let auth = await getAuth();
      if (!hasPortal(auth) || auth.accountId !== initial.accountId || auth.access !== initial.access) {
        throw new AuthError('账号已移除或更改');
      }
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
        const updated = this.update(auth, session);
        this.latest.set(id, { source: fingerprint(initial), auth: updated });
        return { value, auth: updated };
      } catch (error) {
        const reauth = error instanceof AuthError || ['captcha', 'sms'].includes(error.code);
        const failed = { ...auth, refresh: JSON.stringify(session.state()), expires: Date.now() + (reauth ? 86400_000 : 60_000),
          ctyun: { ...auth.ctyun, portalError: MESSAGE(error), reauthRequired: reauth } };
        this.latest.set(id, { source: fingerprint(initial), auth: failed });
        throw error;
      }
    });
    this.pending.set(id, task);
    try { return await task; }
    finally { if (this.pending.get(id) === task) this.pending.delete(id); }
  }
}

export async function createPlugin(_input, dependencies = {}) {
  const credentials = dependencies.credentials || new CredentialStore();
  const sessionFactory = dependencies.sessionFactory || (options => new CtyunSession(options));
  const browser = dependencies.browserLogin || browserLogin;
  const request = dependencies.fetchImpl || globalThis.fetch;
  const sessions = new SessionManager({ sessionFactory, credentials });
  const defaultUpstreamModels = new Map(SNAPSHOT.map(([id]) => [modelId(id), id]));
  const accountUpstreamModels = new Map();
  const common = [
    { type: 'text', key: 'account_name', message: '账号名称（用于区分多个账号）', placeholder: '天翼云个人账号', validate: REQUIRED },
    { type: 'password', key: 'api_key', message: 'Coding Plan API Key', placeholder: '填写套餐专用密钥', validate: REQUIRED },
    { type: 'text', key: 'plan_id', message: '套餐 ID（只有一个有效套餐时留空）' },
  ];
  const passwordMethod = {
    type: 'oauth',
    label: '账号密码登录',
    prompts: [...common,
      { type: 'text', key: 'username', message: '天翼云账号（手机号／邮箱／账号名）', validate: REQUIRED },
      { type: 'select', key: 'save_password', message: '是否保存密码用于自动重登？', options: [
        { value: 'no', label: '否，不保存密码', hint: '适用于服务器和 Docker；IAM 会话失效后需手动重登' },
        { value: 'yes', label: '是，保存到系统凭据库', hint: '需要可用的钥匙串／凭据服务；支持自动重登' },
      ], validate: value => ['yes', 'no'].includes(value) ? undefined : '请选择是或否' },
      { type: 'password', key: 'password', message: '天翼云密码', validate: REQUIRED },
    ],
    async authorize(inputs) {
      const savePassword = inputs?.save_password === 'yes';
      return { method: 'auto', opened: true,
        instructions: savePassword ? '正在登录天翼云，并将账号密码保存到系统凭据库。'
          : '正在通过账号密码登录天翼云，不打开浏览器、不保存密码。仅保留登录会话；单点登录会话也失效后需再次登录。',
        async callback() {
          try {
            validateInputs(inputs);
            if (inputs.save_password !== undefined && !['yes', 'no'].includes(inputs.save_password)) {
              throw new CtyunError('请选择是否保存密码', 'INPUT');
            }
            if (REQUIRED(inputs.username) || !inputs.password) throw new CtyunError('请输入账号和密码', 'INPUT');
            const session = sessionFactory();
            await session.passwordLogin(inputs.username, inputs.password);
            await session.models();
            const ref = savePassword ? credentialId(inputs.account_name.trim()) : undefined;
            if (savePassword) await credentials.set(ref, { username: inputs.username.trim(), password: inputs.password });
            return savedAuth(session, inputs, savePassword ? 'password' : 'password-session', ref);
          } catch (error) { return { type: 'failed', error: MESSAGE(error) }; }
          finally { if (inputs) inputs.password = ''; }
        } };
    },
  };

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
          // MAGPIE's OAuth result is its extensible multi-account envelope.
          // An empty refresh and zero expiry carry only the inference key;
          // no website session is created and the host schedules no renewal.
          type: 'oauth', label: '仅 API Key（不查询额度）', prompts: common.slice(0, 2),
          async authorize(inputs) {
            return { method: 'auto', opened: true, instructions: '仅保存 API Key，不登录官网，不查询额度。以后可用相同账号名称和原 API Key 补充浏览器或密码登录。',
              async callback() {
                try {
                  validateInputs(inputs);
                  return { type: 'success', accountId: inputs.account_name.trim(), access: inputs.api_key.trim(),
                    refresh: '', expires: 0, ctyun: { version: 1, mode: 'api-key' } };
                } catch (error) { return { type: 'failed', error: MESSAGE(error) }; }
              } };
          },
        },
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
        passwordMethod,
      ],
      refreshLead: 60_000,
      async refresh(auth) {
        if (!hasPortal(auth)) return;
        try {
          // The host owns saving this patch under its renewal lock.
          return (await sessions.run(async () => auth, s => s.models(), true)).auth;
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
            if (!current?.access) throw new AuthError('账号已移除或更改');
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
                const adaptedReasoning = adaptReasoning(body);
                const upstreamModels = hasPortal(current) ? accountUpstreamModels.get(accountKey(current)) : undefined;
                const upstream = (upstreamModels ?? defaultUpstreamModels).get(adaptedReasoning?.model);
                const adapted = upstream && upstream !== adaptedReasoning.model
                  ? { ...adaptedReasoning, model: upstream } : adaptedReasoning;
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
          const auth = await getAuth();
          if (auth?.ctyun?.mode === 'api-key') {
            return { plan: '仅 API Key（未启用额度查询）', windows: [], signIn: 'kept' };
          }
          const { value } = await sessions.run(getAuth, (s, a) => s.quota(a.ctyun.planId));
          return { ...value, signIn: 'kept' };
        } catch (error) { return { windows: [], error: MESSAGE(error), signIn: 'kept' }; }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!hasPortal(auth)) return provider.models;
        try {
          // This hook receives a snapshot, not a live getAuth. Saving from it
          // can recreate an account removed while model discovery is in flight.
          const { value } = await sessions.run(async () => auth, s => s.models());
          const models = modelCatalog(value, provider.models);
          // Remember exact official IDs, including newly discovered models.
          // Never append -oc to models the vendor actually lists without it.
          const upstreamModels = new Map(defaultUpstreamModels);
          for (const row of value.models) {
            if (typeof row.model === 'string' && row.model && row.api?.includes('openai-completions')) {
              upstreamModels.set(modelId(row.model), row.model);
            }
          }
          accountUpstreamModels.set(accountKey(auth), upstreamModels);
          return models;
        } catch { return provider.models; }
      },
    },
  };
}

function validateInputs(inputs) {
  if (REQUIRED(inputs?.account_name) || REQUIRED(inputs?.api_key)) throw new CtyunError('请填写账号名称和 Coding Plan API Key', 'INPUT');
}

export const CtyunCodingPlanPlugin = async input => createPlugin(input);
