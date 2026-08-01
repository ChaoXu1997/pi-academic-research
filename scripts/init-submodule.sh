#!/usr/bin/env bash
#
# init-submodule.sh — initialize the upstream git submodule after `pi install`.
#
# pi's `git install` runs a plain `git clone`, which does NOT init submodules —
# but the 4 skills (academic-paper, academic-paper-reviewer, academic-pipeline,
# deep-research) live inside the upstream/ submodule, so they would not resolve
# out of the box. This postinstall hook inits the submodule automatically.
#
# Defensive by design:
#   - no-op (exit 0) when there is no .git (e.g. npm-packed install without git
#     history), so it never breaks `npm install` in non-git contexts;
#   - warns instead of failing if submodule init hits a network error, so a flaky
#     clone never aborts the whole `pi install` (the user can retry manually).
#
# Triggered automatically via the package.json `postinstall` script.

if [ ! -d .git ] || [ ! -f .gitmodules ]; then
  echo "init-submodule: no .git/.gitmodules present — skipping (non-git install context)."
  exit 0
fi

if git submodule update --init --recursive; then
  echo "init-submodule: upstream submodule initialized."
else
  echo "init-submodule: WARNING — 'git submodule update --init --recursive' failed." >&2
  echo "  The 4 skills will not load until you run it manually in the package dir." >&2
  exit 0
fi
