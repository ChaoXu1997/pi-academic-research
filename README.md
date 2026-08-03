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
| Claude Code hooks (PreToolUse write-scope guard) | ❌ Not ported — see [Behavioral caveats](#behavioral-caveats) below |

## What is **not** portable from Claude Code

- `/plugin marketplace add` and `/plugin install` — Claude Code runtime commands
- The upstream's own multi-agent orchestration via Claude Code's Task tool (Pi uses `subagent_run` instead)
- The Python runtime (`upstream/scripts/`, 200+ modules) backing the deterministic citation-verification gate (#182) and the 3 stubbed `/ars-*` commands
- The `PreToolUse` write-scope guard (`upstream/hooks/run_guard.sh`) — see caveat below

All four skills are functional: the 4 `SKILL.md` files load from the vendored `upstream/`
submodule (with their `references/`, `templates/`, `examples/`), and every one of the 38
upstream agents is available as a Pi subagent. The pipeline runs end-to-end driven by Pi's
`subagent_run` and the `/ars-*` prompt templates instead of Claude Code's primitives.

## Behavioral caveats

The upstream ships a `PreToolUse` hook (`upstream/hooks/hooks.json` + `run_guard.sh`) that
**enforces** several invariants at runtime. Pi has its own hook system and this guard is
**not** ported, so the invariants below are **convention only** in Pi — each agent's
written "Phase Boundary" section still documents them, but nothing blocks a violation:

- **v3.9.2 Phase Boundary** — single-phase ("Bucket A") agents are normally blocked from
  writing into other phases' `phase{M}_*/` directories. In Pi this is advisory.
- **#134 write-scope rescoping** — the guard clamps each agent's writes to its declared scope.
- **#182 deterministic citation-verification gate** — a Python gate (needs the unported
  runtime) that hard-blocks submission on unverified citations.

**Practical impact:** the `academic-pipeline` orchestrator is the most affected, since it
relies on phase fencing to keep agents from stomping each other's work. If you need the
upstream's hard guarantees, run the original Claude Code plugin alongside, or re-implement
an equivalent Pi `PreToolUse` hook (`upstream/hooks/run_guard.sh` is a readable reference).

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
