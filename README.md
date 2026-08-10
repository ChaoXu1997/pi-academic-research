# pi-academic-research

A [Pi](https://github.com/earendil-works/pi-coding-agent) package that wraps and adapts
[Imbad0202/academic-research-skills](https://github.com/imbad0202/academic-research-skills)
— a comprehensive suite of Claude Code skills for academic research (paper writing,
peer review, and the full research pipeline) — for use inside the Pi coding agent.

> ⚠️ **Derivative work.** This is an unofficial Pi port. The original Academic Research
> Skills project is © its author **Imbad0202**, licensed **CC BY-NC 4.0**. This wrapper
> is distributed under the same license. See [`NOTICE.md`](./NOTICE.md) and
> [`LICENSE`](./LICENSE).

## What works in Pi

| Upstream component | Pi status |
| --- | --- |
| 4 skills (`academic-paper`, `academic-paper-reviewer`, `academic-pipeline`, `deep-research`) + all their `references/`, `templates/`, `examples/` | ✅ Loaded natively via `pi` manifest (Agent Skills standard) |
| `/ars-*` slash commands (`commands/`) | ✅ Ported to Pi prompt templates under `prompts/` (13 of 16; 3 cache/log commands need the upstream Python runtime and are stubbed) |
| Claude Code subagents (`agents/`) | ✅ All **38** agents adapted to Pi subagent format under `subagents/` — covers the upstream 39-agent ensemble (12 paper + 7 reviewer + 5 pipeline + 14 deep-research + 1 shared `compliance`); `socratic_mentor` is de-duplicated across `academic-paper`/`deep-research` |
| Claude Code hooks (PreToolUse write-scope guard) | ✅ Ported to a Pi extension (`extensions/write-scope-guard.ts`) — see [Behavioral caveats](#behavioral-caveats) below |

## What is **not** portable from Claude Code

- `/plugin marketplace add` and `/plugin install` — Claude Code runtime commands
- The upstream's own multi-agent orchestration via Claude Code's Task tool (Pi uses `subagent_run` instead)
- The upstream Python runtime (`upstream/scripts/`, ~268 modules) — the deterministic **structural-check suite** that the 4 skills reference as integrity gates (`check_pipeline_integrity.py`, `check_phase_conformance.py`, `check_sprint_contract.py`, `check_panel_synthesis.py`, …). These have **no Pi-native equivalent** and are silently skipped — the agent reaches those steps as advisory no-ops. Porting the critical ones natively is tracked as follow-up work.
- The 3 `/ars-*` cache/log commands (`ars-cache-invalidate`, `ars-mark-read`, `ars-unmark-read`) — they shell out to the upstream Python CLI + SQLite cache and are shipped as documented stubs.

> ✅ Both runtime invariants **are** ported natively: `#134` write-scope guard → `extensions/write-scope-guard.ts`, and `#182` citation-verification gate → `extensions/citation-gate.ts` (wraps the `ref-verify` CLI instead of the Python runtime, degrading to advisory if `ref-verify` is absent). See [Behavioral caveats](#behavioral-caveats) below.

All four skills are functional: the 4 `SKILL.md` files load from the vendored `upstream/`
submodule (with their `references/`, `templates/`, `examples/`), and every one of the 38
upstream agents is available as a Pi subagent. The pipeline runs end-to-end driven by Pi's
`subagent_run` and the `/ars-*` prompt templates instead of Claude Code's primitives, and the
upstream write-scope guard is enforced by a native Pi extension (below).

## Write-scope guard (Pi extension)

This package ships a native Pi port of the upstream `PreToolUse` write-scope guard at
`extensions/write-scope-guard.ts` (declared under the `pi.extensions` key in `package.json`,
backed by `extensions/ars_phase_scope_manifest.json`). It loads automatically when the package
is installed.

**How it works.** Claude Code wires the guard as a `PreToolUse` shell hook
(`upstream/hooks/run_guard.sh` → `ars_write_scope_guard.py`). Pi has no `PreToolUse`; instead the
port is a Pi **extension** that subscribes to the `tool_call` event (fires before a tool executes,
can return `{ block: true, reason }`). Pi subagents run as **in-process `AgentSession`s**, and the
subagents runner inherits parent extensions into the subagent session (filtered to the
`tool_call`/`tool_result`/`user_bash` events) — so the handler fires inside each subagent for its
own tool calls. The current subagent is identified via the pi-subagents interaction-session
registry (`Symbol.for("pi.subagents.interactionSessions")`, keyed by session id); if that lookup
fails the actor is treated as unconstrained (the upstream's "absent agent_type ⇒ main session"
posture). The manifest's snake_case `_agent` keys are mapped from the Pi subagents' kebab-case
frontmatter `name`s (`draft-writer` → `draft_writer_agent`; all 23 Bucket A agents map 1:1).

**What it enforces** (faithful to upstream `#134`):

- **Phase Boundary (v3.9.2)** — the 23 single-phase ("Bucket A") agents are deterministically
  fenced to their `allowed_write_globs` (e.g. `bibliography` → `phase2_*/**`). An out-of-scope
  `write`/`edit` is blocked regardless of the agent's prompt. `draft-writer` retains its documented
  `phase4_*/**` + `phase6_*/**` dual-phase static union.
- **`#134` write-scope clamping** + **infra self-protection** — no actor (including the main
  session) may rewrite the guard, its manifest, the ported subagent definitions, or the vendored
  upstream enforcement surface.
- **Bash policy** — `bash` is denied **wholesale** for Bucket A agents (neither "writes a file"
  nor "is read-only" is decidable from a command string; all-deny is the only zero-fail-open
  policy). Bucket A agents use the grep/find/read tools to inspect and write/edit to write.

**Posture.** The guard only **adds** denials and **fails open** on any internal error (unreadable
manifest, registry shape drift, a thrown exception) — it never wedges the session and never emits
an explicit "allow" that would skip Pi's other permission rules.

**Audit trail.** Each inspected decision is appended (best-effort, never blocking) to
`.pi/ars-write-scope-audit.jsonl` under the workspace root — timestamp, subagent, tool, target,
decision, reason. Borrowed from `pi-secured-setup` / `pi-access-guard`. The `.pi/` dir is gitignored
runtime state, so the log never lands in version control.

**Verified.** The pure decision core (`evaluateDecision` and the path/glob helpers) is unit-tested
in `extensions/write-scope-guard.test.ts` (26 cases: phase fencing, bash deny, infra protection,
traversal, schema-drift, dual-phase union, glob segment semantics). Run the full suite with:

```bash
npm install            # devDependencies: typescript, @types/node
npm run typecheck      # tsc --noEmit on extensions/
npm test               # write-scope-guard (26 cases) + citation-gate (18 cases)
npm run test:e2e       # needs ref-verify installed + network
```

## Citation-verification gate (Pi extension)

The upstream `#182` deterministic citation-verification gate (which hard-blocks a submission on
unverified citations) is re-implemented natively as `extensions/citation-gate.ts`. Instead of
porting the upstream 200-module Python runtime, it wraps **`ref-verify`**
([Moonweave-Research/ref-verify](https://github.com/Moonweave-Research/ref-verify)) — a zero-dep
Python CLI that does the same job more rigorously (CrossRef / Semantic Scholar / PubMed / OpenAlex
metadata, **retraction detection**, verbatim-abstract claim checks).

**Surface.** Two entry points share one core:

- `ars_verify_citations` **tool** — agent-callable. The `citation-compliance` / `formatter` agents
  invoke it at submission. It is NOT a `write`/`edit`/`bash` tool, so the write-scope guard does not
  fence it — a Bucket A agent may call it even though its bash is denied wholesale.
- `/ars-verify-citations` **command** — manual user run.

**How it works.** It resolves the `ref-verify` binary, extracts DOIs from a references file
(`.bib`/`.txt`/`.md`/`.tex`/`.csv`/`.jsonl`) or a literal DOI list, runs the Quick Screen
(`verify-doi <doi> --json`) per DOI (bounded concurrency), and aggregates the verdicts.

**Gate outcome** (mirrors ref-verify's conservatism — a conservative guard, not an oracle):

- `fail` — any DOI returned an explicit **REJECT** (dead DOI, DOI resolves to a different paper,
  retracted). This is the only hard block.
- `review` — one or more DOIs returned **WARN** / **UNVERIFIABLE** (no abstract reachable). Not a
  block: ref-verify is explicit that `UNVERIFIABLE` means "no abstract reachable", NOT "wrong".
- `pass` — all DOIs returned **PASS**.
- `advisory` — `ref-verify` is not installed, OR no DOIs found in the input. **Never blocks** —
  identical to the upstream no-Python posture.

**Audit trail.** Each gate run (tool or command) is appended (best-effort, never blocking) to
`.pi/ars-citation-audit.jsonl` under the workspace root — timestamp, source, outcome, per-DOI
verdicts, input (truncated), and metadata file. Mirrors the write-scope guard's audit; the `.pi/`
dir is gitignored runtime state.

**Install the backend.** The package's `postinstall` script (`scripts/init-submodule.sh`)
attempts to install `ref-verify` automatically via `pipx` when you run `pi install`. If that
succeeded, you're done. If `pipx` was unavailable or the install failed, install manually
(ref-verify is a PEP-668-managed Python CLI — use `pipx`, NOT a bare `pip install`):

```bash
pipx install git+https://github.com/Moonweave-Research/ref-verify.git
ref-verify --help    # verify
```

**Verified end-to-end** against ref-verify 1.2.0 + live CrossRef (see
`extensions/citation-gate.e2e.test.ts`): correct metadata → `pass`; bare DOI → `review`
(insufficient-metadata WARN); dead DOI → `fail` (HTTP 404 → REJECT).

For a **native-Pi alternative** (no Python CLI, uses Docling + the `native-web-search` skill) see
[`pi-citecheck`](https://github.com/baochunli/pi-citecheck) (`/citecheck`, optimized for
hallucinated-reference detection in PDFs). The two are complementary: `ref-verify` is stricter
metadata + retraction + claim verification; `pi-citecheck` is lower-friction PDF-first screening.

## Behavioral caveats

The upstream ships a `PreToolUse` hook (`upstream/hooks/hooks.json` + `run_guard.sh`) that
**enforces** several invariants at runtime. **All three are now deterministically enforced again
in Pi** via two native extensions:

- **v3.9.2 Phase Boundary** — ✅ **enforced** by `extensions/write-scope-guard.ts`
  (Bucket A agents blocked from other phases' dirs).
- **#134 write-scope rescoping** — ✅ **enforced** by the same guard
  (each agent clamped to its declared scope).
- **#182 deterministic citation-verification gate** — ✅ **enforced** by
  `extensions/citation-gate.ts` (wraps `ref-verify`; degrades to advisory if `ref-verify` is not
  installed — matching the upstream no-Python posture).

**Practical impact:** the `academic-pipeline` orchestrator's phase fencing is fully restored, and
submission citations are verifiable. Each agent's written "Phase Boundary" section is now backed
by a real block; submission citations get a real gate when `ref-verify` is installed.

**Complementary plugins.** The write-scope guard is specialized (phase/manifest-aware) and is NOT
replaced by general Pi permission extensions — but they run alongside it without conflict (all only
add denials). If you want broader safety, consider `pi-permission-system`, `pi-guardrails`,
`safe-coder`, or `pi-access-guard` from the [pi.dev package catalog](https://pi.dev/packages).

## Install

```bash
# project-only install
pi install -l git:github.com/ChaoXu1997/pi-academic-research
```

Then reload Pi. The four skills become available via `/skill:academic-paper`,
`/skill:academic-paper-reviewer`, `/skill:academic-pipeline`, or by their natural-language
triggers (including 中文 / 日本語 / 한국어).

## Subagent setup

Pi does not auto-load subagent definitions from packages; they must live in the project's
`.pi/subagents/` (or global `~/.pi/agent/subagents/`). This package ships a symlink script:

```bash
# After `pi install`, find the package path and link the 38 adapted subagents.
# Replace <pkg-path> with the install location reported by `pi list`, e.g.
#   .pi/git/github.com/ChaoXu1997/pi-academic-research   (git source, project-local)
#   ~/.pi/agent/git/github.com/ChaoXu1997/pi-academic-research   (git source, global)
bash <pkg-path>/scripts/link-subagents.sh        # links into $PWD/.pi/subagents/
bash <pkg-path>/scripts/link-subagents.sh /other/project
```

Then restart Pi (or run `pi config`). Verify with `subagent_list_agents`.

> All 38 subagents ship with a uniform tool allowlist of `read`, `write`, `edit`, `grep`,
> `glob`, `memory_search` (no `bash`, no `subagent_*` tools, per Pi subagent safety rules).
> Narrow these per-agent via `model_profiles` in your `subagents.json` if desired.

## Sync with upstream

```bash
git submodule update --remote upstream   # pull latest upstream
git add upstream
git commit -m "chore(upstream): sync to <ref>"
```

## License

CC BY-NC 4.0 — same as upstream. Non-commercial use only, with attribution.
See [`LICENSE`](./LICENSE) and [`NOTICE.md`](./NOTICE.md).
