# ARS Package Observed Issues — 2026-08-31 session

Real-world usage: integrating 4 heterogeneous literature-review drafts (PRRSV PhD
dissertation chapter) into one document with verified GB/T 7714 references.
Workflow: hand-driven (mode gap, see #1); verification used PubMed eutils +
CrossRef directly.

## Blocking / correctness

1. **No multi-draft integration mode.** The 11 modes assume one draft under
   revision or from-scratch writing. Merging N existing drafts with
   heterogeneous citation numbering spaces (ours: 4 spaces — one unified (n)
   list, two [n] lists from different source docs, one destroyed list) required
   a fully custom reconciliation script. A `merge`/`integrate` mode with a
   citation-space reconciliation utility (claim-anchored lookup) would cover a
   common real workflow (advisor/section drafts merged into a thesis chapter).

2. **Citation gate false REJECTs under rate limiting.** `ars_verify_citations`
   on 10 freshly-PubMed-verified DOIs returned 9×REJECT + 1×REVIEW; one entry
   explicitly showed `HTTP Error 429: Too Many Requests`. All 5 sampled DOIs
   verified 200 OK via api.crossref.org immediately after. Network/endpoint
   failures are misclassified as REJECT — indistinguishable from dead DOIs.
   Needs: retry with backoff, rate-limit detection, and a `network-unverified`
   verdict class distinct from `reject`.

   **✅ FIXED 2026-08-31** (`extensions/citation-gate.ts` `classify()`): bare
   errors now split by status — 404/410 → REJECT (dead DOI), 429/5xx/timeout/
   status-less → REVIEW (cannot verify). Verified: 6 new unit tests + live
   re-run (0 false REJECT) + e2e 3/3 (real dead-DOI still fails). Retry/backoff
   deliberately not added — rerunning the gate is cheap once verdicts are
   honest; revisit if REVIEW-noise becomes common.

3. **Gate input parser misses newline-separated DOI files.** A `.txt` with one
   DOI per line (60 lines) → "No DOIs found in input". Same list passed inline
   as a newline string parsed fine. The file-input path seems to expect commas
   or a references document.

   **✅ FIXED 2026-08-31** (root cause was NOT the newline format):
   `readInput()`'s path regex `[\w./~-]+` is ASCII-only, so any references file
   under a Unicode directory (e.g. `.../23-sj-毕业论文综述/refs/dois.txt`)
   never matched and was treated as a literal DOI list. Replaced the regex
   with `existsSync` + `statSync` on any single-token input — handles Unicode
   paths and drops the extension allowlist. Verified: 3 new unit tests incl.
   a real Unicode-path tmp file.

## Advisory

4. **No claim→reference semantic check tooling.** IRON RULE says every
   citation must be verified; tooling verifies bibliographic existence, but
   nothing helps repair *mis-numbered* citations (wrong paper behind a number).
   We rebuilt ~20 such mappings by hand via claim-anchored PubMed esearch.
   A "citation anchor audit" helper would be valuable.

5. **Structural-check suite remains advisory no-ops** (upstream Python not
   ported), as documented in README. No impact on this run.

## What worked well

- PubMed eutils (esearch/esummary/idconv) as a verification channel: 61/61
  refs recovered with full metadata; corrupted ChatGPT-paste reference lists
  (hyperlink-fragmented entries) were recoverable from embedded PMIDs.
- Prompt/skill design of the upstream docs is solid; the failure modes above
  are all tooling-side.
