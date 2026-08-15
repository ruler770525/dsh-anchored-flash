/**
 * Anchored tool bootstrap — `anchored-flash` 定制版
 *
 * 移植自 xiaobright/dsh-anchored-standard 的 preset/tool-bootstrap.mjs
 * （MIT；上游 NOTICE 见本仓库根目录 NOTICE 文件）。
 * 相对上游的三处本地定制：
 *
 *  1. residentTools 配置化：晋升后的常驻目录由 agent.cordis.yml 的
 *     `residentTools` 白名单决定（上游是硬编码 bootstrap 对 + 三个发现
 *     工具）。白名单之外的已装配工具（subagent/workflow/de_broadcast/
 *     playwright MCP…）一律经 dev_tool_search 按名解锁，解锁名从持久
 *     tool/call 事件推导，resume/reload 不丢。
 *  2. includeSubagents 默认 true：子代理（subagent/subagent_fork/workflow
 *     worker/ralph fresh agent）首轮同样走锚定流程（上游默认 false：
 *     子代理视为已晋升、首轮即全目录）。开启后每个子代理多一次模型
 *     调用（锚定轮）。
 *  3. contexts 首轮置空：上游用 persona `complete: true` +
 *     `includeRuntimeContext: false` 全程关闭 runtime context（连记忆
 *     快照一起关）；本 preset 保留 standard persona 与 memory-evolve
 *     记忆注入插件，改为在 system-prompt/assemble 过滤器里把未晋升
 *     阶段的 `contexts` 置空（memory:snapshot 等全部动态上下文首轮不
 *     注入），晋升后原样恢复——首轮快照退化为官方 Minimal 同款的
 *     "Current runtime context: none…"。
 *  4. bootstrapPersona 首轮替换：未晋升阶段把 persona section 文本替换
 *     为 Minimal 的完整 system prompt 句（默认 "You are a helpful
 *     software engineer assistant."），晋升后恢复 standard persona
 *     （{{model}}/{{cwd}} 原样渲染）——首轮与 Minimal 的完整 system
 *     prompt 条件对齐（issue #11 实验即用此句）。
 *
 * 保留的上游机制（社区实测验证，issues #6/#11/#19/#32）：
 *  - 首轮工具目录 = bootstrapTools（Minimal 真 schema：持久 bash +
 *    str_replace_editor；Windows 下 bash 由 custom-bash.mjs 提供）；
 *  - 晋升信号 = 首次持久 tool/call 或 assistant/message（promoteOn:
 *    either，先到者为准），状态从持久 session 事件推导，resume/reload
 *    保持；请求 #1 恒为 bootstrap 目录，请求 #2 起恒为 resident；
 *  - pre-step 注入剥离（suppressedContextSources，默认 skill-catalog +
 *    agent-instructions），晋升后恢复；用户主动的 skill 手势不过滤；
 *  - bootstrapMaxTokens 可选封顶：rc.6 prebuilt profile 包可能被
 *    adapterDefaults.maxTokens 覆盖（issue #11），不生效也无害；
 *  - compaction epoch：compaction/end 后回退受控阶段（bootstrap 对 +
 *    compactionTools 核心工作集），越过边界后重新晋升；
 *  - 任何过滤器失败降级为全目录/保留全部消息并一次性告警，绝不锁死
 *    会话；非法配置在 preset 挂载时报错。
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Applying without an inject — combined with this row being FIRST in
 * agent.cordis.yml — registers the plugin before dsh-agent-instructions and
 * dsh-tool-skill, and waterfall after-next transforms apply in reverse
 * registration order, so the first-request strip below is the LAST transform.
 * With an inject here those plugins register first and re-inject their
 * messages after the strip. The pre-step listener additionally registers with
 * `prepend: true` so the strip stays the outermost transform even against
 * host-plane listeners and future row reordering.
 */
export const inject = []

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set([
  'bootstrapTools',
  'promoteOn',
  'bootstrapMaxTokens',
  'suppressedContextSources',
  'compactionTools',
  'residentTools',
  'includeSubagents',
  'bootstrapPersona',
])

/**
 * Context sources stripped from the first request by default. Both are
 * automatic `agent/pre-step` injections: the available-skills reminder
 * (`skill-catalog`) and the AGENTS.md/CLAUDE.md workspace digest
 * (`agent-instructions`). True Minimal mounts neither plugin.
 */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/**
 * The default first-request catalog: the OFFICIAL Minimal preset's exact tool
 * pair — the persistent `bash` shell and `str_replace_editor`. Issue #11
 * measured this schema anchoring 5/5 at the adapter-default maxTokens while
 * every standard-family schema failed 11/11.
 */
const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/**
 * Default post-promotion resident set when `residentTools` is not configured:
 * the bootstrap pair + the discovery tool. agent.cordis.yml overrides this
 * with the session's whitelist (read/write/edit/glob/grep/memory/dtodo/
 * web_search/de_session/read_image/…).
 */
const DEFAULT_RESIDENT_TOOLS = ['bash', 'str_replace_editor', 'dev_tool_search']

/**
 * The first-request persona text: the OFFICIAL Minimal preset's complete
 * system prompt sentence. Issue #11 measured the anchor with exactly this
 * system prompt; while bootstrapping, the sections are replaced with ONLY
 * this text (mimicking `complete: true`) and restored to the standard
 * assembly after promotion.
 */
const DEFAULT_BOOTSTRAP_PERSONA = 'You are a helpful software engineer assistant.'

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Validate the suppressed context sources. Unlike the bootstrap tool lists,
 * an explicitly empty array is meaningful: it disables the context filter
 * while keeping the tool bootstrap.
 */
function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens, and the
 * cap's delivery is profile-package dependent (see the header note), so it is
 * opt-in rather than the default.
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }
  const bootstrapTools = stringList(source.bootstrapTools, 'bootstrapTools')
  const residentTools = stringList(source.residentTools ?? DEFAULT_RESIDENT_TOOLS, 'residentTools')
  const promoteEvents = parsePromoteOn(source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const suppressedSources = sourceList(source.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  // Core work set exposed after a compaction, before re-promotion. Empty
  // means "no compaction recovery catalog": the session stays on the
  // bootstrap pair until a new promotion signal.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')
  // Subagents follow the same bootstrap/anchor phase as top-level sessions.
  // Set false to treat subagents as already promoted (full catalog from
  // their very first request).
  const includeSubagents = source.includeSubagents !== false
  // First-request persona text; the standard persona is restored after
  // promotion. Empty string disables the replacement (keep standard).
  const bootstrapPersona = typeof source.bootstrapPersona === 'string' && source.bootstrapPersona.length > 0
    ? source.bootstrapPersona
    : DEFAULT_BOOTSTRAP_PERSONA

  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. The event's `arguments` is the raw JSON string the model produced;
   * we parse it defensively and read the `toolNames` array.
   */
  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray(session.events)) return unlocked
    for (const event of session.events) {
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
    }
    return unlocked
  }

  /** Narrow the assembled catalog to a keep-set; validate required names. */
  const keepTools = (assembled, keep, missingAllowsFullCatalog) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = [...keep].filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
      )
      if (missingAllowsFullCatalog) return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        // FULL MINIMAL CONDITION, FOREVER: the system prompt stays the single
        // Minimal sentence (46 chars) in EVERY phase — no harness identity,
        // no tool guidance, no plan section, no persona swap. Measured
        // 2026-08-16: request #1 anchored ("we", 6x); the promoted request
        // with the standard system restored (46→6620 chars) + instruction-hint
        // shifted to "let me" (3x) — both the system mutation and the
        // one-line directive are trajectory perturbations. instruction-hint
        // is disabled in agent.cordis.yml for the same reason.
        const keep = new Set([...residentTools, ...unlockedFor(context.agent?.session)])
        const narrowed = keepTools(assembled, keep, false)
        return {
          ...narrowed,
          sections: [{ name: 'deployment:persona', text: bootstrapPersona }],
          contexts: [],
        }
      }
      // Controlled phase: the bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue. Runtime context
      // is stripped (memory:snapshot, policy facts, …) and the sections are
      // replaced with ONLY the Minimal persona sentence — the full Minimal
      // condition in every phase, exactly like the promoted branch above.
      const { boundary } = status
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      const narrowed = keepTools(assembled, keep, true)
      return {
        ...narrowed,
        sections: [{ name: 'deployment:persona', text: bootstrapPersona }],
        contexts: [],
      }
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Unset (`bootstrapMaxTokens` omitted) means the adapter default flows — the
  // Minimal tool schema anchors at 256000 without a cap (issue #11).
  if (bootstrapMaxTokens !== undefined) {
    // Same registration discipline as the pre-step strip below: `prepend`
    // keeps this listener the OUTERMOST transform of the agent/request
    // waterfall for the same registration-order reasons (loader row
    // application is concurrent; row order alone does not decide listener
    // order — see issue #6 and upstream PR #13), so a later listener can
    // never override the first-round budget after we set it.
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        // The next request's seed proposal carries the previous header's
        // maxTokens forward, so the injected cap must be stripped explicitly —
        // otherwise it would persist for the whole session.
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }

  // Strip first-step injected reminders (skill catalog, AGENTS.md) during
  // bootstrap. Because this listener is the first registered (see the inject
  // note, the row order in agent.cordis.yml, and `prepend` below), the strip
  // is the final waterfall transform and actually removes what later
  // listeners inject.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (promotion.status(agent).promoted || suppressedSources.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
