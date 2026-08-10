// Unit tests for the pipeline-integrity-gate pure CLI core.
// Run via: tsc -p tsconfig.test.json && node .test-build/pipeline-integrity-gate.test.js
//
// These tests port the 16-test upstream Python oracle
// (upstream/scripts/test_check_pipeline_integrity.py) into the Pi TS test harness, plus 3 new
// tests for spec-flagged gaps (AC-8 io-error, AC-9 window-seconds override, AC-2 file-not-dir).
// They exercise the pure `cli()` function directly — no Pi runtime, no subprocess.

import { cli } from "./pipeline-integrity-gate.js";
import type { CliResult } from "./pipeline-integrity-gate.js";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	chmodSync,
	utimesSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.error(`  \u2717 ${name}`);
	}
}

function run(workdir: string, ...extraArgs: string[]): CliResult {
	return cli([workdir, ...extraArgs]);
}

function buildWorkspace(
	root: string,
	structure: Record<string, string[]>,
): void {
	for (const [dirName, files] of Object.entries(structure)) {
		const d = join(root, dirName);
		mkdirSync(d, { recursive: true });
		for (const fname of files) {
			writeFileSync(join(d, fname), "");
		}
	}
}

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "ars-pipeline-int-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// AC-1, AC-4, AC-11: empty workdir, no findings
// ---------------------------------------------------------------------------

console.log("test_empty_workdir_no_findings");
withTempDir((td) => {
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"contains 'No advisory findings.'",
		r.stdout.includes("No advisory findings."),
	);
	check("stderr empty (AC-13)", r.stderr === "");
});

// ---------------------------------------------------------------------------
// AC-4, AC-11: non-phase dirs ignored
// ---------------------------------------------------------------------------

console.log("test_no_phase_dirs_no_findings");
withTempDir((td) => {
	mkdirSync(join(td, "some_other_dir"));
	writeFileSync(join(td, "README.md"), "");
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"contains 'No advisory findings.'",
		r.stdout.includes("No advisory findings."),
	);
	check("stderr empty", r.stderr === "");
});

// ---------------------------------------------------------------------------
// AC-3, AC-5, AC-11: #133 inflation — STRUCTURAL finding, exit 0
// ---------------------------------------------------------------------------

console.log("test_issue_133_inflation_case_phase5_missing_reviewers");
withTempDir((td) => {
	buildWorkspace(td, {
		phase2_bibliography: ["annotated_bib.md"],
		phase3_synthesis: ["synthesis.md"],
		phase4_draft: ["draft_v1.md"],
		phase5_review: ["review.md"],
		phase6_revision: ["draft_v2.md"],
	});
	const r = run(td);
	check("exit 0 (advisory, AC-3)", r.exitCode === 0);
	check("contains STRUCTURAL", r.stdout.includes("STRUCTURAL"));
	check(
		"contains phase5_missing_independent_reviewer",
		r.stdout.includes("phase5_missing_independent_reviewer"),
	);
	check("contains devil's advocate", r.stdout.includes("devil's advocate"));
	check("contains editorial/EIC", r.stdout.includes("editorial/EIC"));
	check(
		"contains ethics or panel reviewer",
		r.stdout.includes("ethics or panel reviewer"),
	);
	check("stderr empty", r.stderr === "");
});

// ---------------------------------------------------------------------------
// AC-5: legitimate phase5 with all three reviewer files → no STRUCTURAL
// ---------------------------------------------------------------------------

console.log("test_legitimate_phase5_with_three_reviewer_files_passes");
withTempDir((td) => {
	buildWorkspace(td, {
		phase2_bibliography: ["annotated_bib.md"],
		phase3_synthesis: ["synthesis.md"],
		phase4_draft: ["draft_v1.md"],
		phase5_review: [
			"devils_advocate_report.md",
			"editor_in_chief_decision.md",
			"ethics_review.md",
		],
		phase6_revision: ["draft_v2.md"],
	});
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check("no STRUCTURAL finding", !r.stdout.includes("STRUCTURAL"));
	check(
		"contains 'No advisory findings.'",
		r.stdout.includes("No advisory findings."),
	);
});

// ---------------------------------------------------------------------------
// AC-5: alternative reviewer stems (methodology/domain/perspective)
// ---------------------------------------------------------------------------

console.log("test_phase5_methodology_domain_perspective_also_counts");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review: [
			"devils_advocate_card.md",
			"eic_card.md",
			"methodology_reviewer_card.md",
		],
	});
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"no findings (methodology counts)",
		r.stdout.includes("No advisory findings."),
	);
});

console.log("test_phase5_domain_reviewer_also_counts");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review: [
			"devils_advocate_card.md",
			"eic_card.md",
			"domain_reviewer_card.md",
		],
	});
	const r = run(td);
	check(
		"domain_reviewer satisfies cat 3",
		r.stdout.includes("No advisory findings."),
	);
});

console.log("test_phase5_perspective_reviewer_also_counts");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review: [
			"devils_advocate_card.md",
			"eic_card.md",
			"perspective_reviewer_card.md",
		],
	});
	const r = run(td);
	check(
		"perspective_reviewer satisfies cat 3",
		r.stdout.includes("No advisory findings."),
	);
});

console.log("test_phase5_bare_ethics_without_review_does_not_match");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review: [
			"devils_advocate_card.md",
			"eic_card.md",
			"ethics.md", // bare "ethics" without _review — must NOT match
		],
	});
	const r = run(td);
	check(
		"bare ethics does NOT match (STRUCTURAL emitted)",
		r.stdout.includes("STRUCTURAL"),
	);
	check(
		"names ethics or panel reviewer as missing",
		r.stdout.includes("ethics or panel reviewer"),
	);
});

// ---------------------------------------------------------------------------
// AC-7: phase5_empty advisory
// ---------------------------------------------------------------------------

console.log("test_phase5_empty_dir_flags_advisory");
withTempDir((td) => {
	mkdirSync(join(td, "phase5_review"));
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check("contains phase5_empty", r.stdout.includes("phase5_empty"));
	check("stderr empty", r.stderr === "");
});

// ---------------------------------------------------------------------------
// AC-5: editorial_synthesizer alone satisfies cat 2 but not 1 and 3
// ---------------------------------------------------------------------------

console.log("test_phase5_with_only_editorial_synthesizer_flags_missing_da");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review: ["editorial_synthesizer_letter.md"],
	});
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"contains phase5_missing_independent_reviewer",
		r.stdout.includes("phase5_missing_independent_reviewer"),
	);
	check("contains devil's advocate", r.stdout.includes("devil's advocate"));
	check(
		"contains ethics or panel reviewer",
		r.stdout.includes("ethics or panel reviewer"),
	);
	check(
		"does NOT contain editorial/EIC (satisfied)",
		!r.stdout.includes("editorial/EIC"),
	);
});

// ---------------------------------------------------------------------------
// AC-1, AC-9: --strict triggers HEURISTIC
// ---------------------------------------------------------------------------

console.log("test_strict_flag_triggers_heuristic");
withTempDir((td) => {
	buildWorkspace(td, {
		phase2_bibliography: ["annotated_bib.md"],
		phase3_synthesis: ["synthesis.md"],
	});
	const r = run(td, "--strict");
	check("exit 0", r.exitCode === 0);
	check("contains HEURISTIC", r.stdout.includes("HEURISTIC"));
	check(
		"contains adjacent_phase_same_window",
		r.stdout.includes("adjacent_phase_same_window"),
	);
});

// ---------------------------------------------------------------------------
// AC-9: no --strict → heuristic never runs
// ---------------------------------------------------------------------------

console.log("test_no_strict_flag_skips_heuristic");
withTempDir((td) => {
	buildWorkspace(td, {
		phase2_bibliography: ["annotated_bib.md"],
		phase3_synthesis: ["synthesis.md"],
	});
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check("no HEURISTIC", !r.stdout.includes("HEURISTIC"));
	check(
		"no adjacent_phase_same_window",
		!r.stdout.includes("adjacent_phase_same_window"),
	);
});

// ---------------------------------------------------------------------------
// AC-9 (NEW): --window-seconds override
// ---------------------------------------------------------------------------

console.log("test_window_seconds_override");
withTempDir((td) => {
	buildWorkspace(td, {
		phase2_bibliography: ["annotated_bib.md"],
		phase3_synthesis: ["synthesis.md"],
	});
	// Set mtimes 10 seconds apart.
	const t = Date.now() / 1000;
	utimesSync(join(td, "phase2_bibliography", "annotated_bib.md"), t, t);
	utimesSync(join(td, "phase3_synthesis", "synthesis.md"), t, t + 10);

	const r1 = run(td, "--strict", "--window-seconds", "1");
	check("window=1: exit 0", r1.exitCode === 0);
	check(
		"window=1: no heuristic (delta 10s > 1s)",
		!r1.stdout.includes("adjacent_phase_same_window"),
	);

	const r2 = run(td, "--strict", "--window-seconds", "300");
	check(
		"window=300: heuristic fires (delta 10s <= 300s)",
		r2.stdout.includes("adjacent_phase_same_window"),
	);
});

// ---------------------------------------------------------------------------
// AC-1, AC-12: JSON output format
// ---------------------------------------------------------------------------

console.log("test_json_output_format");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review: ["review.md"],
	});
	const r = run(td, "--json");
	check("exit 0", r.exitCode === 0);
	let payload: any = null;
	try {
		payload = JSON.parse(r.stdout);
	} catch (_e) {
		// payload stays null — test below asserts null
	}
	check("stdout is valid JSON", payload !== null);
	check("has workdir key", payload && "workdir" in payload);
	check("has phase_dirs key", payload && "phase_dirs" in payload);
	check("has findings key", payload && "findings" in payload);
	check(
		"at least 1 finding",
		payload && payload.findings && payload.findings.length >= 1,
	);
	check(
		"finding rule is phase5_missing_independent_reviewer",
		payload &&
			payload.findings &&
			payload.findings.some(
				(f: any) => f.rule === "phase5_missing_independent_reviewer",
			),
	);
	check(
		"phase_dirs has string key '5'",
		payload && payload.phase_dirs && "5" in payload.phase_dirs,
	);
	check("stderr empty on --json", r.stderr === "");
});

// ---------------------------------------------------------------------------
// AC-2, AC-13: invalid workdir → exit 1, stderr
// ---------------------------------------------------------------------------

console.log("test_invalid_workdir_returns_exit_1");
{
	const r = run("/tmp/nonexistent_dir_for_test_xyz_133");
	check("exit 1", r.exitCode === 1);
	check("stderr contains 'not found'", r.stderr.includes("not found"));
	check("stdout empty", r.stdout === "");
}

// ---------------------------------------------------------------------------
// AC-2 (NEW): file (not dir) as workdir → exit 1
// ---------------------------------------------------------------------------

console.log("test_file_as_workdir_returns_exit_1");
withTempDir((td) => {
	const filePath = join(td, "not_a_dir.txt");
	writeFileSync(filePath, "hello");
	const r = run(filePath);
	check("file as workdir: exit 1", r.exitCode === 1);
	check(
		"file as workdir: stderr contains 'not found'",
		r.stderr.includes("not found"),
	);
	check("file as workdir: stdout empty", r.stdout === "");
});

// ---------------------------------------------------------------------------
// AC-4: non-phase dirs (phase0, phase7, stage5) ignored
// ---------------------------------------------------------------------------

console.log("test_non_phase_dirs_ignored");
withTempDir((td) => {
	mkdirSync(join(td, "phase0_intake"));
	mkdirSync(join(td, "phase7_format"));
	mkdirSync(join(td, "stage5_review"));
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"contains 'No advisory findings.'",
		r.stdout.includes("No advisory findings."),
	);
});

// ---------------------------------------------------------------------------
// AC-6: dotfiles ignored
// ---------------------------------------------------------------------------

console.log("test_dotfiles_in_phase5_ignored");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review: [
			".DS_Store",
			".gitkeep",
			"devils_advocate_card.md",
			"eic_card.md",
			"ethics_review.md",
		],
	});
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"dotfiles don't interfere → no findings",
		r.stdout.includes("No advisory findings."),
	);
});

// ---------------------------------------------------------------------------
// AC-5: multiple phase5 dirs evaluated independently
// ---------------------------------------------------------------------------

console.log("test_multiple_phase5_dirs_each_independently_checked");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review_r1: [
			"devils_advocate_card.md",
			"eic_card.md",
			"ethics_review.md",
		],
		phase5_review_r2: ["review.md"],
	});
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"phase5_missing_independent_reviewer appears exactly once",
		r.stdout.split("phase5_missing_independent_reviewer").length - 1 === 1,
	);
	check("references phase5_review_r2", r.stdout.includes("phase5_review_r2"));
});

// ---------------------------------------------------------------------------
// AC-6, AC-12: Unicode filenames with ASCII canonical stem match
// ---------------------------------------------------------------------------

console.log("test_unicode_filenames_with_canonical_stem_match");
withTempDir((td) => {
	buildWorkspace(td, {
		phase5_review: [
			"devils_advocate_\u5831\u544a.md",
			"editor_in_chief_\u6c7a\u5b9a.md",
			"ethics_review_\u5831\u544a.md",
		],
	});
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"Unicode filenames still match → no findings",
		r.stdout.includes("No advisory findings."),
	);
});

console.log("test_unicode_json_preserves_non_ascii (AC-12)");
withTempDir((td) => {
	// Incomplete phase5 with Unicode filename → finding message includes it.
	buildWorkspace(td, {
		phase5_review: ["devils_advocate_\u5831\u544a.md"],
	});
	const rj = run(td, "--json");
	let parsed2: any = null;
	try {
		parsed2 = JSON.parse(rj.stdout);
	} catch (_e) {
		// stays null
	}
	check("JSON is valid", parsed2 !== null);
	check(
		"JSON preserves non-ASCII literally (not escaped)",
		rj.stdout.includes("\u5831\u544a"),
	);
});

// ---------------------------------------------------------------------------
// AC-6: nested files in subdirectories count
// ---------------------------------------------------------------------------

console.log("test_nested_files_in_phase5_count");
withTempDir((td) => {
	const sub = join(td, "phase5_review", "round1");
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(sub, "devils_advocate.md"), "");
	writeFileSync(join(sub, "editor_in_chief.md"), "");
	writeFileSync(join(sub, "ethics_review.md"), "");
	const r = run(td);
	check("exit 0", r.exitCode === 0);
	check(
		"nested files count → no findings",
		r.stdout.includes("No advisory findings."),
	);
});

// ---------------------------------------------------------------------------
// AC-8 (NEW): phase5_attribution_io_error branch
// ---------------------------------------------------------------------------

console.log("test_phase5_attribution_io_error");
{
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	const td = mkdtempSync(join(tmpdir(), "ars-pipeline-int-io-"));
	try {
		// phase5_good: complete (should be evaluated normally)
		buildWorkspace(td, {
			phase5_good: [
				"devils_advocate_report.md",
				"editor_in_chief_decision.md",
				"ethics_review.md",
			],
		});
		// phase5_bad: empty dir, then chmod 000 → readdirSync throws EACCES
		mkdirSync(join(td, "phase5_bad"));

		if (isRoot) {
			// Root bypasses chmod — cannot test this path as root.
			chmodSync(join(td, "phase5_bad"), 0o000);
			chmodSync(join(td, "phase5_bad"), 0o755);
			check("io_error test skipped (running as root)", true);
		} else {
			chmodSync(join(td, "phase5_bad"), 0o000);
			const r = run(td);
			// Restore for cleanup
			chmodSync(join(td, "phase5_bad"), 0o755);

			check("exit 0 (advisory)", r.exitCode === 0);
			check(
				"contains phase5_attribution_io_error",
				r.stdout.includes("phase5_attribution_io_error"),
			);
			check("references phase5_bad", r.stdout.includes("phase5_bad"));
			check(
				"no phase5_missing_independent_reviewer (good=complete, bad=io_error)",
				!r.stdout.includes("phase5_missing_independent_reviewer"),
			);
			check("stderr empty", r.stderr === "");
		}
	} finally {
		// Ensure permissions restored for cleanup
		try {
			chmodSync(join(td, "phase5_bad"), 0o755);
		} catch (_e) {
			// directory may have already been removed
		}
		rmSync(td, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// AC-10: read-only property (all tests above use zero-byte files)
// ---------------------------------------------------------------------------

console.log("AC-10 read-only verification");
withTempDir((td) => {
	// Create files with content; behavior must be identical to empty files (contents never read).
	buildWorkspace(td, {
		phase5_review: [
			"devils_advocate_report.md",
			"editor_in_chief_decision.md",
			"ethics_review.md",
		],
	});
	// Write content to the files
	writeFileSync(
		join(td, "phase5_review", "devils_advocate_report.md"),
		"non-empty content here",
	);
	writeFileSync(
		join(td, "phase5_review", "editor_in_chief_decision.md"),
		"more content",
	);
	writeFileSync(
		join(td, "phase5_review", "ethics_review.md"),
		"ethics content",
	);
	const r = run(td);
	check(
		"content in files doesn't affect outcome (no findings)",
		r.stdout.includes("No advisory findings."),
	);
});

// ---------------------------------------------------------------------------
// AC-11: text output format checks
// ---------------------------------------------------------------------------

console.log("AC-11 text output format");
withTempDir((td) => {
	buildWorkspace(td, {});
	const r = run(td);
	check(
		"header line present",
		r.stdout.includes("ARS pipeline integrity check (v3.9.2 advisory)"),
	);
	check("Workdir line present", r.stdout.includes("Workdir:"));
	check(
		"Phase dirs found line present",
		r.stdout.includes("Phase dirs found:"),
	);
	check(
		"No advisory findings literal",
		r.stdout.includes("No advisory findings."),
	);
});

console.log("AC-11 text output format (with findings)");
withTempDir((td) => {
	buildWorkspace(td, { phase5_review: ["review.md"] });
	const r = run(td);
	check("severity printed", r.stdout.includes("STRUCTURAL"));
	check(
		"rule printed",
		r.stdout.includes("phase5_missing_independent_reviewer"),
	);
	check("Phase line present", r.stdout.includes("Phase: 5"));
	check("Path line present", r.stdout.includes("Path:"));
	check(
		"reminder line present",
		r.stdout.includes("Reminder: this output is ADVISORY"),
	);
});

// ---------------------------------------------------------------------------
// Audit trail (best-effort)
// ---------------------------------------------------------------------------

console.log("audit trail");
{
	const { appendAudit } = await import("./pipeline-integrity-gate.js");
	const td = mkdtempSync(join(tmpdir(), "ars-pipeline-int-audit-"));
	try {
		const ctx = { cwd: td } as any;
		appendAudit(ctx, {
			source: "tool",
			workdir: td,
			strict: false,
			windowSeconds: 300,
			report: {
				workdir: td,
				phase_dirs: new Map([[5, [join(td, "phase5_review")]]]),
				findings: [
					{
						rule: "phase5_empty",
						severity: "ADVISORY" as const,
						phase: 5,
						path: join(td, "phase5_review"),
						message: "test message",
					},
				],
			},
		});
		const logPath = join(td, ".pi", "ars-pipeline-integrity-audit.jsonl");
		check("audit file written", existsSync(logPath));
		const entry = JSON.parse(
			(await import("node:fs")).readFileSync(logPath, "utf-8").trim(),
		);
		check("audit entry has ts", typeof entry.ts === "string");
		check("audit entry records source=tool", entry.source === "tool");
		check("audit entry records findingCount=1", entry.findingCount === 1);
		check(
			"audit entry has findings[0].rule",
			entry.findings[0]?.rule === "phase5_empty",
		);
	} finally {
		rmSync(td, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
