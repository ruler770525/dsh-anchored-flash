/**
 * Logic self-test for the anchored-flash tool-bootstrap plugin.
 * Runs against the REAL plugin module with a minimal mock ctx — no DSH
 * runtime needed. Node: `node verify-anchored-flash.mjs` (node >= 22).
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

// Resolve the installed preset from the environment (works on any user).
const dshHome = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE, '.dsh')
const pluginUrl = pathToFileURL(path.join(dshHome, '.agent-presets', 'anchored-flash', 'tool-bootstrap.mjs')).href
const { apply } = await import(pluginUrl)

/** Minimal event-bus mock: records listeners, fires them. */
function makeCtx() {
  const listeners = {}
  return {
    listeners,
    on(event, fn) { (listeners[event] ??= []).push(fn) },
    fire(event, ...args) { for (const fn of listeners[event] ?? []) fn(...args) },
    logger: { warn() {} },
  }
}

function makeAgent(sessionId, events = [], header = {}) {
  return { session: { id: sessionId, events, header } }
}

const ALL_TOOLS = [
  'bash', 'pwsh', 'str_replace_editor', 'read', 'write', 'edit', 'glob', 'grep',
  'memory', 'dtodo', 'todo_write', 'ask_user_question', 'web_search',
  'dev_tool_search', 'de_session', 'read_image', 'exit_plan_mode',
  'skill_search', 'skill_load',
  'subagent', 'workflow', 'ralph', 'de_broadcast', 'de_canvas', 'skill_manage',
  'mcp__playwright__navigate', 'mcp__playwright__click', 'cordis_define',
]
const RESIDENT = new Set([
  'bash', 'pwsh', 'str_replace_editor', 'read', 'write', 'edit', 'glob', 'grep',
  'memory', 'dtodo', 'todo_write', 'ask_user_question', 'web_search',
  'dev_tool_search', 'de_session', 'read_image', 'exit_plan_mode',
  'skill_search', 'skill_load',
])
const BOOTSTRAP = new Set(['bash', 'str_replace_editor'])
const COMPACTION_EXTRA = ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question', 'memory', 'dtodo']

const ctx = makeCtx()
apply(ctx, {
  bootstrapTools: ['bash', 'str_replace_editor'],
  promoteOn: 'either',
  bootstrapMaxTokens: 1024,
  suppressedContextSources: ['agent-instructions', 'skill-catalog'],
  includeSubagents: true,
  residentTools: [...RESIDENT],
  compactionTools: COMPACTION_EXTRA,
})

const assembleListener = ctx.listeners['system-prompt/assemble'][0]
const preStepListener = ctx.listeners['agent/pre-step'][0]
const requestListener = ctx.listeners['agent/request'][0]

const assembled = () => ({
  sections: [
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
    { name: 'persona', text: 'You are a coding agent.' },
    { name: 'planning:mode', text: 'You are in plan mode. ...' },
  ],
  contexts: [
    { name: 'memory:snapshot', text: '## 长期记忆 …' },
    { name: 'policy', text: 'Current DSH file policy: …' },
  ],
  tools: ALL_TOOLS.map((name) => ({ name, description: name })),
  variables: {},
})

const names = (out) => out.tools.map((t) => t.name).sort()

const preStepDecision = (messages) => ({ kind: 'run', messages })
const msg = (kind) => ({ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind } })

let pass = 0
const check = (label, cond) => {
  assert.ok(cond, `FAIL: ${label}`)
  pass++
  console.log(`ok ${pass} - ${label}`)
}

// ── 1. fresh session: bootstrap tools + ZERO contexts + ONLY Minimal persona ─
{
  const agent = makeAgent('s-fresh', [])
  const out = await assembleListener(assembled(), { agent }, async () => assembled())
  check('fresh tools == bootstrap pair', names(out).join() === [...BOOTSTRAP].sort().join())
  check('fresh contexts stripped', out.contexts.length === 0)
  check('fresh sections == ONLY Minimal persona (complete semantics)',
    out.sections.length === 1 && out.sections[0].text === 'You are a helpful software engineer assistant.')
}

// ── 2. after first assistant/message: promoted → resident, system stays ──
//    the single Minimal sentence (full-minimal forever), contexts stripped
{
  const agent = makeAgent('s-promoted', [{ type: 'assistant/message', seq: 1 }])
  const out = await assembleListener(assembled(), { agent }, async () => assembled())
  check('promoted tools == resident set', names(out).join() === [...RESIDENT].sort().join())
  check('promoted contexts still stripped (low-injection)', out.contexts.length === 0)
  check('promoted sections == ONLY Minimal persona (full-minimal forever)',
    out.sections.length === 1 && out.sections[0].text === 'You are a helpful software engineer assistant.')
}

// ── 3. dev_tool_search unlock persists (from durable tool/call events) ────
{
  const agent = makeAgent('s-unlocked', [
    { type: 'tool/call', seq: 1, data: { name: 'dev_tool_search', arguments: '{"toolNames":["subagent","de_broadcast","mcp__playwright__navigate"]}' } },
  ])
  const out = await assembleListener(assembled(), { agent }, async () => assembled())
  const got = names(out)
  check('unlocked tools resident', got.includes('subagent') && got.includes('de_broadcast') && got.includes('mcp__playwright__navigate'))
  check('unlocked count == resident+3', got.length === RESIDENT.size + 3)
}

// ── 4. compaction/end: fall back to bootstrap + compactionTools ───────────
{
  const agent = makeAgent('s-compacted', [
    { type: 'assistant/message', seq: 1 },
    { type: 'compaction/end', seq: 2 },
  ])
  const out = await assembleListener(assembled(), { agent }, async () => assembled())
  const got = names(out)
  const expected = [...BOOTSTRAP, ...COMPACTION_EXTRA].sort()
  check('post-compaction tools == bootstrap + compactionTools', got.join() === expected.join())
  check('post-compaction contexts stripped', out.contexts.length === 0)
}

// ── 5. subagent with includeSubagents:true → anchored, NOT promoted ───────
{
  const agent = makeAgent('s-sub', [], { delegationDepth: 1 })
  const out = await assembleListener(assembled(), { agent }, async () => assembled())
  check('subagent fresh tools == bootstrap pair', names(out).join() === [...BOOTSTRAP].sort().join())
}

// ── 6. pre-step: strip skill-catalog + agent-instructions while unpromoted ─
{
  const agent = makeAgent('s-pre', [])
  const decision = await preStepListener({ agent }, async () => preStepDecision([
    msg('user'), msg('skill-catalog'), msg('agent-instructions'), msg('plugin'),
  ]))
  const kinds = decision.messages.map((m) => m.source.kind)
  check('pre-step strips catalog+instructions, keeps user/plugin',
    kinds.join() === ['user', 'plugin'].join())
}
{
  const agent = makeAgent('s-pre2', [{ type: 'assistant/message', seq: 1 }])
  const decision = await preStepListener({ agent }, async () => preStepDecision([
    msg('user'), msg('skill-catalog'), msg('agent-instructions'),
  ]))
  check('pre-step keeps everything after promotion', decision.messages.length === 3)
}

// ── 7. agent/request: cap at 1024 while bootstrapping, release after ──────
{
  const agent = makeAgent('s-req', [])
  const out = await requestListener({ agent }, async () => ({ maxTokens: 256000, tools: [] }))
  check('request #1 capped at 1024', out.maxTokens === 1024)
}
{
  const agent = makeAgent('s-req2', [{ type: 'tool/call', seq: 1, data: { name: 'bash', arguments: '{}' } }])
  const out = await requestListener({ agent }, async () => ({ maxTokens: 1024, tools: [] }))
  check('cap released after promotion', out.maxTokens === undefined && Object.hasOwn(out, 'maxTokens') === false)
}

// ── 8. invalid config fails at apply time ──────────────────────────────────
{
  let threw = false
  try {
    apply(makeCtx(), { promoteOn: 'bogus' })
  } catch { threw = true }
  check('invalid promoteOn throws at mount', threw)
}
{
  let threw = false
  try {
    apply(makeCtx(), { unknownKey: true })
  } catch { threw = true }
  check('unknown config key throws at mount', threw)
}

// ── 9. subagent bypass with includeSubagents:false → promoted (resident) ──
{
  const ctx2 = makeCtx()
  apply(ctx2, { includeSubagents: false, bootstrapTools: ['bash', 'str_replace_editor'], residentTools: [...RESIDENT] })
  const fn = ctx2.listeners['system-prompt/assemble'][0]
  const agent = makeAgent('s-sub2', [], { delegationDepth: 1 })
  const out = await fn(assembled(), { agent }, async () => assembled())
  check('includeSubagents:false → subagent promoted (resident, no anchor)', names(out).join() === [...RESIDENT].sort().join())
}

console.log(`\nALL ${pass} CHECKS PASSED`)
