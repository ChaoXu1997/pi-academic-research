# NOTICE

This project, `pi-academic-research`, is a Pi-package wrapper and port of the
[Academic Research Skills](https://github.com/imbad0202/academic-research-skills)
project by **Imbad0202** (upstream author).

## Upstream attribution

- **Original work:** [Imbad0202/academic-research-skills](https://github.com/imbad0202/academic-research-skills)
- **Original author:** Imbad0202
- **Upstream version tracked:** v3.19.0 (vendored unmodified in the `upstream/` git submodule)
- **Upstream license:** CC BY-NC 4.0

The entire upstream repository is vendored **unmodified** inside the `upstream/`
git submodule. All original copyright, authorship, and licensing of that content
belong to Imbad0202 and the upstream contributors.

## This wrapper

Code in this repository outside `upstream/` (the `package.json` manifest,
`prompts/`, `subagents/`, `scripts/`, and documentation) is a derivative work
that adapts the upstream Claude Code plugin to the
[Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

It is distributed under the same CC BY-NC 4.0 license as the upstream to
preserve license compatibility. See `LICENSE` for the full legal code.

## Synchronizing with upstream

```bash
git submodule update --remote upstream
git add upstream
git commit -m "chore(upstream): sync academic-research-skills to <new-ref>"
```

The wrapper (`prompts/`, `subagents/`, `package.json`) is intentionally kept
separate from the vendored upstream so syncs never conflict.
