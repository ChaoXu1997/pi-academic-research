# Observed Issues — 2026-09-04 (from the 25-sj-外泌体 SCI manuscript run)

Issues observed while running the ARS `academic-paper` pipeline end-to-end in Pi
(TGEV exosome manuscript, inline single-session execution), with dispositions.

## 1. ARS agents were not invocable as Pi subagents (integration gap)

**Observed.** The upstream 12-agent (reviewer 7, pipeline 5, deep-research 14 = 38+)
ensemble defines agents as Claude Code markdown; the pi package ships Pi-format
ports under `subagents/`, but nothing registered them, so `subagent_list_agents`
showed zero ARS roles and the pipeline ran as parent-session role-play.

**Disposition — FIXED.** All 38 ports symlinked into `~/.pi/agent/subagents/`
(global scope, user-confirmed). Effective after Pi restart. Future runs can
dispatch Phase agents via `subagent_run` (e.g. `intake`, `draft-writer`,
`peer-reviewer`, `pipeline-orchestrator`).

## 2. v3.6.6 generator–evaluator four-call protocol cannot run inline

**Observed.** The v3.6.6 contract requires *physically separated model calls*
(Phase 4a/4b/6a/6b) to defeat read-the-paper-then-rationalize drift. A single
parent session executing inline cannot provide call separation, so the protocol
was skipped for this run (documented deviation, not silent).

**Disposition — DOCUMENTED + mitigation now available.** With (1) fixed, a
future run can realize the four calls as four distinct `subagent_run` dispatches
(writer 4a blind pre-commitment → writer 4b visible draft → evaluator 6a blind
scoring plan → evaluator 6b visible scoring), which restores the contract's
physical separation. Until a dispatcher wires this, treat inline runs of
`academic-paper full` as v3.6.5-equivalent and say so in the run record.

## 3. citation-gate DOI parser truncated DOIs containing parentheses

**Observed.** `DOI_RE`'s character class excluded `)`, so legacy Elsevier/Wiley
DOIs (e.g. `10.1016/0378-1135(90)90144-K`, `10.1016/0092-8674(83)90040-5`)
truncated at the first `)` → 404 REJECTs (false positives).

**Disposition — FIXED (TDD).** `extensions/citation-gate.ts`: `)` removed from
the exclusion class; trailing-`)` stripping is now balance-aware (matched parens
kept, citation-wrapper parens stripped). 5 new unit cases (RED→GREEN),
`citation-gate.test.js` 40/40, full suite regression green. E2E on the real
manuscript: **17/17 PASS, 0 REJECT** (was 14 PASS / 3 false REJECT + 1 true
REJECT from a fabricated DOI, now deleted from the ref list).

## 4. ref-verify semantic REJECT on a truncated metadata title (external tool)

**Observed.** `10.1080/20013078.2018.1535750` (MISEV2018) returned REJECT
although the DOI resolves correctly.

**Root cause.** ref-verify's `_titles_match` requires **exact token-set
equality** (and an equal digit multiset) between the supplied and fetched
titles; the supplied metadata title was a truncated form of the canonical
title. pipx-installed third-party tool — not patched here.

**Disposition — DOCUMENTED guidance.** The per-DOI metadata JSONL must carry
**canonical full titles** (as returned by CrossRef). With the full MISEV2018
title supplied, the gate returned PASS. Consider an upstream feature request to
ref-verify for prefix/subset-tolerant title matching.

## 5. `wet_lab` domain evidence profile was reserved (field gap)

**Observed.** Veterinary virology intake resolved to
`unknown_user_defined (requested: wet_lab)` — the wet-lab checklist did not
exist.

**Disposition — FIXED locally (pending upstream PR).** `wet_lab` promoted to
ship-ready in the three operative files (submodule working-tree patch,
uncommitted):
- `academic-paper/references/domain_evidence_profiles.md` — profile row +
  addendum; reserved list now 4.
- `academic-paper/agents/intake_agent.md` — Step 12 enum 4→5, prompt bullet,
  reserved list, profile-value rules.
- `academic-paper/agents/literature_strategist_agent.md` — (b)/(c) branch
  counts, discipline map row, pseudocode enum comment.

Admission list: primary experimental literature + curated bio-databases
(miRBase/KEGG/GO) as evidence; preprints admitted with advisory flag; vendor
notes and abstracts demoted to methods context. Advisory-only semantics
unchanged. The kong-259 spec's own "reserved profiles ship per demand" clause
covers this promotion; spec/plan design docs left as history.

## Files touched

- Parent repo: `extensions/citation-gate.ts`, `extensions/citation-gate.test.ts`
  (committed? NO — working tree, awaiting user decision), this doc.
- Submodule (`upstream/`): 3 markdown files (uncommitted local patch).
- Global: `~/.pi/agent/subagents/` ← 38 symlinks.
