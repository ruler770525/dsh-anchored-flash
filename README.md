# dsh-anchored-flash

An experimental DeepSeek Harness agent preset: **Minimal-aligned anchoring with
low-injection post-promotion, an indirect AGENTS.md injection pattern, and
subagent anchoring** — the "anchored intelligence without the IQ drop"
experiment series.

Fork of [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
with local modifications; the experiment report is in
[upstream issue #49](https://github.com/xiaobright/dsh-anchored-standard/issues/49).

## What makes this different from upstream

| Feature | Upstream `anchored-standard` | This preset |
|---|---|---|
| First request | Minimal pair `bash` + `str_replace_editor`, maxTokens 1024, zero injected context | same |
| System prompt after promotion | `complete: true` persona, stays the Minimal sentence (46 chars) forever | same, enforced by the assemble filter in every phase (`tool-bootstrap`) |
| Post-promotion catalog | bootstrap pair + discovery tools + `dev_tool_search` unlocks | configurable **`residentTools` whitelist** (default: 18 tools incl. memory/dtodo/web_search/de_session/read_image/exit_plan_mode/skill_search/skill_load) |
| `instruction-hint` wording | imperative ("read the relevant instruction files **first and follow them**") — **measured to flip the anchored trajectory back to "let me"** | neutral/suggestive reference note — **measured to preserve "we"** (see experiment table below) |
| Subagents | opt-in `includeSubagents` | **default `true`** — subagents go through the same anchor flow |
| AGENTS.md | full digest injection (perturbs) or nothing | **indirect injection**: 1 KB topic index + `AGENTS-*.md` topic files + `env-*` skills, read on demand (`skill_load` / `read`) — measured non-perturbing |
| Windows bash | `custom-bash` (fixed path) | `custom-bash` with **PATH fallback** when the configured Git Bash path is missing |
| Runtime context (memory snapshot etc.) | stripped | stripped in every phase (low-injection) |

## Experiment summary (measured 2026-08-16, DeepSeek V4 Pro, reasoningEffort=max)

Fingerprint = completed-reasoning counts of `we` / `let's` / `let me`
(case-insensitive, whole words). Sessions are real DSH sessions on Windows +
rc.6.

| Exp | Hint wording | System prompt | Result |
|---|---|---|---|
| baseline | imperative ("read first and follow them") | restored to standard (46→6620 chars) | **we→let me flip after promotion** (0 we / 3 let me; model: "I must read relevant instructions") |
| E1 | neutral reference note | 46 chars in every phase | `we` preserved (up to 49 we / 1 let me in 22.5k-char analyses) |
| E2 | neutral + user asked to read AGENTS.md | 46 chars | full on-demand chain walked (`skill_search` → `skill_load` → `read` 1 KB index); `we` preserved; environment facts actually used |
| E1.5 | suggestive ("reading the index is recommended") | 46 chars | `we` preserved; model reads only when the task needs environment facts |

Key conclusions:

1. **The promoted system-prompt mutation (46→6620 chars) is itself a
   perturbation.** Keep the system prompt at the single Minimal sentence in
   every phase.
2. **Imperative wording in a user-role injected message correlates with the
   style switch** (we report correlation, not mechanism).
3. **Non-imperative reference wording does not flip the trajectory**, and
   read willingness is driven by task need, not hint wording.
4. **Anchored intelligence and AGENTS.md availability are not mutually
   exclusive**: tell the model (non-imperatively) that reference documents
   exist, and let it load them on demand.

## Install

```powershell
$target = Join-Path $env:USERPROFILE '.dsh\.agent-presets\anchored-flash'
if (Test-Path -LiteralPath $target) { throw "Preset already exists: $target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath '.\preset' -Destination $target
```

Restart DeepSeek Harness, create a fresh session, pick **锚定标准·满血子代理**
(`anchored-flash`). Do not switch presets mid-session.

### Recommended AGENTS.md layout (the indirect-injection pattern)

Split the user-global `~/.dsh/AGENTS.md` into:

- `~/.dsh/AGENTS.md` — ~1 KB topic index (3 iron rules + pointer table)
- `~/.dsh/AGENTS-<topic>.md` — topic files (environment / network / dsh /
  workflow / browser …)
- `~/.dsh/skills/env-*` — the same content as skills, discoverable via
  `skill_search` and loadable via `skill_load`

## Verify

```sh
node verify/verify-anchored-flash.mjs      # 18 logic checks, no DSH runtime needed
node verify/trace-session.mjs <session-dir>        # header + reasoning fingerprint trace
node verify/count-pronouns.mjs <session-dir>       # we / let's / let me counters
node verify/dive-session.mjs <session-dir>         # full system + message sources
node verify/dump-session.mjs <session-dir>         # header + first-line dump
```

## License

MIT. The preset is based on the DeepSeek Harness Standard preset and on
`xiaobright/dsh-anchored-standard`; see [`NOTICE`](./NOTICE) and
[`LICENSE`](./LICENSE). Part of the experiment design and this documentation
were assisted by DeepSeek (an AI assistant); all measurements are from real
DSH sessions.
