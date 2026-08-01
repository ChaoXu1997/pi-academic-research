---
description: ARS academic-paper-reviewer `full` mode — simulated peer-review panel
argument-hint: "[mode: full|quick|methodology-focus|re-review|guided|calibration]"
---

Load and apply the `academic-paper-reviewer` skill (provided by the `pi-academic-research` package; in Pi invoke `/skill:academic-paper-reviewer` or read `upstream/academic-paper-reviewer/SKILL.md`) and run it in **full mode**.

Honor explicit alternate modes when present: `quick`, `methodology-focus`, `re-review`, `guided`, or `calibration`. Runs on the inherited session model — the v3.7.0 `opus` frontmatter floor was retired in the 2026-06 harness pass so a stronger session model is never silently downgraded.

Mode reference: `MODE_REGISTRY.md` § academic-paper-reviewer.
Skill entry: `academic-paper-reviewer/SKILL.md`.

---

[Optional user input]: $@
