// Official model capabilities, reviewed 2026-10-31. CTYun verification and
// primary sources are recorded in README.md. Match exact IDs:
// a newly discovered model must not silently inherit another version's rules.
const profiles = {
  'glm-5.3-oc': 'glm-effort',
  'glm-5.3-flash': 'glm-effort',
  'deepseek-v4.1-flash': 'deepseek',
  'deepseek-v4-flash-0731-oc': 'deepseek',
  'deepseek-v4-pro-0813-oc': 'deepseek',
  'glm-5.1-oc': 'thinking-switch',
  'kimi-k2.5-oc': 'thinking-switch',
  'qwen-3.6-flash-oc': 'qwen-switch',
  'MiniMax-M2.5-oc': 'always-on',
};
const graded = ['low', 'high', 'max'];
const aliases = { minimal: 'low', medium: 'high', xhigh: 'high', ultra: 'max' };
const onEfforts = new Set(['enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function reasoningConfig(id) {
  const profile = Object.hasOwn(profiles, id) ? profiles[id] : undefined;
  if (!profile) return {};
  const levels = profile === 'glm-effort' ? graded : profile === 'deepseek' ? ['none', ...graded]
    : profile === 'always-on' ? ['enabled'] : ['none', 'enabled'];
  // "enabled" is a switch, not an invented effort level. It also prevents
  // the host from borrowing unrelated effort levels for always-on models.
  return { reasoning: true, variants: Object.fromEntries(levels.map(level => [level, { reasoningEffort: level }])) };
}

export class ReasoningSettingError extends Error {}

// MAGPIE forwards variant *names* as reasoning_effort. Translate switches
// to the provider's native parameters; never invent token-budget mappings.
export function adaptReasoning(body) {
  const profile = Object.hasOwn(profiles, body?.model) ? profiles[body.model] : undefined;
  const effort = body?.reasoning_effort;
  if (!profile || effort === undefined) return body;
  const result = { ...body };
  if (profile === 'glm-effort') {
    if (!graded.includes(effort)) throw new ReasoningSettingError('GLM-5.3 仅支持 low、high、max，不能关闭思考');
    // Preserve explicit native settings and unrelated thinking fields.
    result.thinking = { type: 'enabled', ...body.thinking };
  } else if (profile === 'deepseek') {
    const level = Object.hasOwn(aliases, effort) ? aliases[effort] : effort;
    if (!['none', ...graded].includes(level)) throw new ReasoningSettingError('DeepSeek 仅支持 none、low、high、max');
    result.reasoning_effort = level;
    // Native thinking.type has priority, per DeepSeek's API. In particular,
    // enabled + none must not be reinterpreted as disabled.
    if (!body.thinking?.type) result.thinking = { ...body.thinking, type: level === 'none' ? 'disabled' : 'enabled' };
  } else {
    if (effort !== 'none' && !onEfforts.has(effort)) throw new ReasoningSettingError('此模型仅支持思考开关，不支持该强度参数');
    if (profile === 'always-on' && effort === 'none') throw new ReasoningSettingError('MiniMax-M2.5 不能关闭思考，也不提供分级强度');
    delete result.reasoning_effort;
    if (profile === 'qwen-switch') result.enable_thinking = body.enable_thinking ?? effort !== 'none';
    else if (profile === 'thinking-switch') result.thinking = { type: effort === 'none' ? 'disabled' : 'enabled', ...body.thinking };
    // MiniMax has no effort setting. Leave its native default and response
    // format untouched, including any <think> content in model history.
  }
  return result;
}
