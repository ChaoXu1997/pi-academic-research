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
|---|---|
| 4 skills (`academic-paper`, `academic-paper-reviewer`, `academic-pipeline`, `deep-research`) + all their `references/`, `templates/`, `examples/` | ✅ Loaded natively via `pi` manifest (Agent Skills standard) |
| `/ars-*` slash commands (`commands/`) | ✅ Ported to Pi prompt templates under `prompts/` (13 of 16; 3 cache/log commands need the upstream Python runtime and are stubbed) |
| Claude Code subagents (`agents/`) | ✅ Adapted to Pi subagent format under `subagents/` (27 agents) |
| Claude Code hooks (PreToolUse guard) | ❌ Not ported (Pi has its own hook system) |

## What is **not** portable from Claude Code

- `/plugin marketplace add` and `/plugin install` — Claude Code runtime commands
- The upstream's own multi-agent orchestration via Claude Code's Task tool
- The Python `PreToolUse` write-scope guard

The three skills themselves are fully usable; the pipeline works, just driven by Pi's
`subagent_run` and Pi prompt-template commands instead of Claude Code's primitives.

## Install

```bash
# project-only install
pi install -l git:github.com/ChaoXu1997/pi-academic-research
```

Then reload Pi. The three skills become available via `/skill:academic-paper`,
`/skill:academic-paper-reviewer`, `/skill:academic-pipeline`, or by their natural-language
triggers (including 中文 / 日本語 / 한국어).

## Subagent setup

Pi does not auto-load subagent definitions from packages; they must live in the project's
`.pi/subagents/` (or global `~/.pi/agent/subagents/`). This package ships a symlink script:

```bash
# After `pi install`, find the package path and link the 27 adapted subagents.
# Replace <pkg-path> with the install location reported by `pi list`, e.g.
#   .pi/git/github.com/ChaoXu1997/pi-academic-research   (git source, project-local)
#   ~/.pi/agent/git/github.com/ChaoXu1997/pi-academic-research   (git source, global)
bash <pkg-path>/scripts/link-subagents.sh        # links into $PWD/.pi/subagents/
bash <pkg-path>/scripts/link-subagents.sh /other/project
```

Then restart Pi (or run `pi config`). Verify with `subagent_list_agents`.

> All 27 subagents ship with a uniform tool allowlist of `read`, `write`, `edit`, `grep`,
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
