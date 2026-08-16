/**
 * instruction-hint — replace `dsh-agent-instructions`' full AGENTS.md/CLAUDE.md
 * injection with a minimal "these files exist" hint.
 *
 * WHY: the full workspace-instruction digest is a large injected block. After
 * the anchored bootstrap promotes, we want the model to KNOW the reference
 * files exist without dumping their content into every request. The model
 * reads the files itself via the filesystem tools when it needs them.
 *
 * EXPERIMENT 1 (2026-08-16, local change): the hint text is a NEUTRAL
 * DECLARATIVE reference note — no imperative verbs ("must", "first",
 * "follow"). The upstream wording is a directive-role injection: measured on
 * session 546a4f16, the promoted request carrying the imperative hint
 * (173 chars) shifted the reasoning from "we" (6x) to "let me" (3x), and the
 * model even announced "AGENTS.md exists — I must read relevant
 * instructions". This variant states existence and purpose only, to test
 * whether a non-command reference note preserves the "we" trajectory while
 * still letting the model discover the environment documents.
 *
 * EXPERIMENT 1.5 (2026-08-16): SUGGESTIVE wording — adds a soft
 * "reading the index before workspace tasks is recommended — it is short"
 * nudge. Experiment 1 preserved the anchor but the model never read
 * AGENTS.md unprompted. This tests whether a gentle recommendation (still
 * no imperative verbs) raises the natural read rate without losing "we".
 *
 * Behavior:
 *  - After the session records its first durable promotion signal
 *    (`promoteOn`, default `either`), ONE hint message is injected (once per
 *    session — durable event scan, resume-safe), listing which reference
 *    files were found:
 *      - user-global: `$DSH_HOME/AGENTS.md`
 *      - project chain: AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md
 *        walking up from the session cwd to the project root (a directory
 *        containing `.git`, or the cwd itself).
 *  - Files are probed via `ctx.fs` (the host filesystem seam); a missing fs
 *    service or an unreadable probe degrades to no hint (never throws).
 *  - Pre-promotion requests get NO hint (matches the anchored bootstrap).
 *
 * ROW ORDER: this plugin registers its `agent/pre-step` handler with
 * `prepend: true` and after `tool-bootstrap`, so it runs inside the
 * bootstrap's outermost strip — but it emits AFTER promotion, when the strip
 * is inactive. The hint source kind is `instruction-hint`, which is NOT in
 * `suppressedContextSources`, so it is never stripped.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'instruction-hint'

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Candidate file names, in probe order, for the project chain and user-global. */
const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const USER_GLOBAL_CANDIDATE = 'AGENTS.md'

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/** Find the project root: first ancestor containing any root marker (e.g. .git). */
async function findProjectRoot(fs, cwd, signal) {
  let current = cwd
  for (;;) {
    for (const marker of ['.git', '.hg', '.svn']) {
      try {
        const target = await fs.resolve(joinPath(current, marker), { cwd, signal })
        const info = await fs.stat(target, signal)
        if (info !== undefined) return current
      } catch {
        // Probe failure = marker absent; continue.
      }
    }
    const parent = parentPath(current)
    if (parent === current || parent.length === 0) return cwd
    current = parent
  }
}

/** List instruction files present in one directory (project candidates). */
async function presentInDir(fs, dir, candidates, signal) {
  const found = []
  for (const candidate of candidates) {
    try {
      const target = await fs.resolve(joinPath(dir, candidate), { cwd: dir, signal })
      const info = await fs.stat(target, signal)
      if (info !== undefined && info.type === 'file') found.push(candidate)
    } catch {
      // Absent or unreadable — skip.
    }
  }
  return found
}

/** Join one path segment onto a directory (platform-agnostic string join). */
function joinPath(dir, segment) {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + segment
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir + sep + segment
}

/** Parent of an absolute Windows or POSIX path. */
function parentPath(path) {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  const parent = path.slice(0, idx)
  return parent.length === 0 ? path : parent
}

/** Register the post-promotion instruction-hint injector. */
export function apply(ctx, config) {
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const promotion = createEpochPromotion(promoteEvents)
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  /** Sessions that already received the hint. */
  const hinted = new Set()
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

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      if (promotion.status(agent).promoted !== true) return decision
      const session = agent.session
      if (session === undefined || hinted.has(session.id)) return decision
      hinted.add(session.id)

      const fs = ctx.get('fs')
      if (fs === undefined) return decision
      const cwd = session.header.cwd ?? process.cwd()

      const projectFiles = []
      const root = await findProjectRoot(fs, cwd, signal)
      projectFiles.push(...await presentInDir(fs, root, PROJECT_CANDIDATES, signal))

      // FIX (2026-08-16): include the FULL resolved paths in the hint — the
      // model was looking for "AGENTS.md" inside its cwd and could not find
      // the user-global file otherwise.
      const dshHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined)
      const userGlobalFiles = []
      try {
        if (dshHome !== undefined) {
          userGlobalFiles.push(...await presentInDir(fs, dshHome, [USER_GLOBAL_CANDIDATE], signal))
        }
      } catch {
        // Unreadable home probe — ignore.
      }

      const sections = []
      if (projectFiles.length > 0) {
        const paths = projectFiles.map((name) => joinPath(root, name))
        sections.push(`Reference documents exist: ${paths.join(', ')}.`)
      }
      if (userGlobalFiles.length > 0) {
        const paths = userGlobalFiles.map((name) => joinPath(dshHome, name))
        sections.push(`A user reference document exists: ${paths.join(', ')} (topic index; topic files AGENTS-*.md and env-* skills).`)
      }
      if (sections.length === 0) return decision

      // EXPERIMENT 1.5 (2026-08-16): suggestive wording — a soft
      // "recommended" nudge instead of the neutral "consult only when you
      // need" from experiment 1. Experiment 1 proved a non-command reference
      // note preserves the "we" trajectory, but the model never read
      // AGENTS.md on its own (task did not need it). This variant keeps the
      // declarative, non-imperative frame (no "must", no "first", no
      // "follow") while gently recommending the read, to test whether the
      // natural read rate goes up without losing the anchor.
      const text = [
        ...sections,
        'They are reference documents about the user environment (paths, network rules, tooling notes), not task instructions. Reading the index before workspace tasks is recommended — it is short — but consult them only when you need environment details; the task itself never depends on them.',
      ].join(' ')

      return {
        ...decision,
        messages: [...decision.messages, {
          id: `instruction-hint-${session.id}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'instruction-hint', form: 'hint' },
        }],
      }
    } catch (error) {
      // A hint bug must never hurt the session: skip the hint.
      warnOnce(`${name}: hint injection failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
