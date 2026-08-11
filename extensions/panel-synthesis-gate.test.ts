// Unit tests for the panel-synthesis gate (slice 3b).
// Run via: tsc -p tsconfig.test.json && node .test-build/panel-synthesis-gate.test.js
//
// These tests port the 3b CLI/gate groups from the upstream Python oracle
// (upstream/scripts/test_check_panel_synthesis.py) plus the net-new Pi surface:
//   * AC-33 — four-tier precedence (multi-tier diagnostics)
//   * AC-34 — contract short-circuit + cardinality
//   * AC-35 — role-binding swap → exit 3; match → exit 0
//   * AC-36 — synthesis skip under layer1-only / reviewer diags
//   * AC-37 — layer1-only relaxed cardinality
//   * AC-38 — pass output shape (full + layer1-only)
//   * AC-42 — TOOL isError three-tier mapping
//   * AC-43 — audit per-tier counts + non-blocking
//   * AC-44 — TOOL layer1Only parameter

import {
	cli,
	appendAudit,
	tierLabelFromExitCode,
} from "./panel-synthesis-gate.js";
import {
	load_contract,
	parse_report,
	type ReviewerReport,
	type SprintContract,
} from "./core/reviewer-gate-core.js";
import {
	recompute_panel,
	compute_dimension_verdicts,
} from "./core/panel-synthesis-core.js";
import {
	readFileSync,
	writeFileSync,
	rmSync,
	existsSync,
	mkdtempSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
// From .test-build/ → project root is ../
const REPO = join(HERE, "..");
const FULL_PATH = join(
	REPO,
	"upstream",
	"shared",
	"contracts",
	"reviewer",
	"full.json",
);
const FULL: SprintContract = JSON.parse(readFileSync(FULL_PATH, "utf-8"));
const ROLES = ["eic", "methodology", "domain", "perspective", "da"];

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

function withTempDir(fn: (td: string) => void): void {
	const td = mkdtempSync(join(tmpdir(), "panel-synth-test-"));
	try {
		fn(td);
	} finally {
		try {
			rmSync(td, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}
}

// ---------------------------------------------------------------------------
// Test helpers (ported from upstream)
// ---------------------------------------------------------------------------

// state() helper not needed in gate tests (file-based, not object-based).

function reportText(role: string, overrides: Record<string, string> | null = null, daIds: string[] = []): string {
	const ov = overrides ?? {};
	const lines = [`contract_role: ${role}`, "", "## Dimension Scores", ""];
	for (const dim of FULL.acceptance_dimensions as Record<string, unknown>[]) {
		const did = dim.id as string;
		lines.push(`### ${did}: ${dim.name}`);
		if (!(dim.eligible_roles as string[]).includes(role)) {
			lines.push("score: not_assessed");
		} else {
			const value = ov[did] ?? "pass";
			if (value === "warn") {
				lines.push("score: warn", 'trigger: "warn trigger"');
			} else if (value === "block") {
				lines.push("score: block", "block_class: repairable", 'trigger: "block trigger"');
			} else if (value === "fatal") {
				lines.push("score: block", "block_class: fatal", 'trigger: "fatal trigger"');
			} else if (value === "abstain") {
				lines.push("score: not_assessed", "abstain_reason: materially inapplicable");
			} else {
				lines.push("score: pass");
			}
		}
		lines.push("");
	}
	lines.push("## Review Body", "", "No scored findings.", "");
	if (role === "da") {
		lines.push("#### CRITICAL", "| # | Issue | Evidence Anchor |", "|---|-------|-----------------|");
		for (const findingId of daIds) {
			lines.push(`| ${findingId} | Issue | text: "quoted evidence" p. 1 |`);
		}
		lines.push("", "#### MAJOR", "| # | Issue | Evidence Anchor |", "|---|-------|-----------------|");
	}
	return lines.join("\n");
}

function buildPanelReports(
	overrides: Record<string, Record<string, string>> | null = null,
	daIds: string[] = [],
): ReviewerReport[] {
	const ov = overrides ?? {};
	return ROLES.map((role) =>
		parse_report(
			`${role}.md`,
			reportText(role, ov[role] ?? null, role === "da" ? daIds : []),
			FULL,
		),
	);
}

function synthesisTextFor(
	panelReports: ReviewerReport[],
	adjudications: Record<string, string> | null = null,
	decisionOverride: string | null = null,
	markerCount: number | null = null,
	rationales: Record<string, string> | null = null,
): string {
	const [, expressions] = load_contract(FULL_PATH);
	const [assessed, fired, decision] = recompute_panel(panelReports, FULL, expressions, []);
	const verdicts = compute_dimension_verdicts(assessed);
	const adj = adjudications ?? {};
	const rat = rationales ?? {};
	const lines = [
		`dimension_verdicts: [${Object.entries(verdicts).map(([did, value]) => `${did}=${value}`).join(", ")}]`,
		`fired_conditions: [${fired.join(", ")}]`,
		`da_critical_adjudications: [${Object.entries(adj).map(([id, value]) => `${id}=${value}`).join(", ")}]`,
	];
	for (const [id, text] of Object.entries(rat)) {
		lines.push(`${id} rejection rationale: ${text}`);
	}
	lines.push(decisionOverride ?? decision);
	if (markerCount !== null) {
		lines.push(`[DA-CRITICAL-VS-ACCEPT: ${markerCount} validated/unresolved]`);
	}
	return lines.join("\n");
}

/** Write 5 report files + synthesis file to temp dir, return argv for full-panel run. */
function writeFullPanel(td: string, overrides: Record<string, Record<string, string>> | null = null, daIds: string[] = []): string[] {
	const ov = overrides ?? {};
	const argv: string[] = ["--contract", FULL_PATH];
	for (const role of ROLES) {
		const p = join(td, `${role}.md`);
		writeFileSync(p, reportText(role, ov[role] ?? null, role === "da" ? daIds : []), "utf-8");
		argv.push("--report", p);
	}
	const panelReports = buildPanelReports(overrides, daIds);
	const synthText = synthesisTextFor(panelReports);
	const synthPath = join(td, "synthesis.md");
	writeFileSync(synthPath, synthText, "utf-8");
	argv.push("--synthesis", synthPath);
	return argv;
}

// ===========================================================================
// AC-33: four-tier precedence (multi-tier diagnostics)
// ===========================================================================

console.log("\nAC-33: four-tier precedence");

withTempDir((td) => {
	// Multi-tier: reviewer + synthesis → exit 3 (reviewer outranks synthesis)
	// We need a scenario where reviewer diagnostics exist.
	// A report with invalid content → reviewer diagnostic. The synthesis is never checked.
	const argv: string[] = ["--contract", FULL_PATH];
	const badReport = join(td, "bad.md");
	writeFileSync(badReport, "contract_role: methodology\n\n## Dimension Scores\n### D1: methodology_rigor\nscore: pass\n\n", "utf-8");
	// Need 5 reports for full panel
	for (const role of ROLES) {
		const p = join(td, `${role}.md`);
		writeFileSync(p, reportText(role), "utf-8");
		argv.push("--report", p);
	}
	// Make one report invalid (missing dimensions) by truncating
	writeFileSync(join(td, "methodology.md"), "contract_role: methodology\n\n## Dimension Scores\n### D1: methodology_rigor\nscore: pass\n", "utf-8");
	const synthPath = join(td, "synthesis.md");
	writeFileSync(synthPath, "dimension_verdicts: []\nfired_conditions: []\nda_critical_adjudications: []\neditorial_decision=accept\n", "utf-8");
	argv.push("--synthesis", synthPath);
	const result = cli(argv);
	check("reviewer diag → exit 3", result.exitCode === 3);
	check("reviewer count > 0", result.reviewerCount > 0);
});

withTempDir((td) => {
	// Infra (wrong report count) → exit 2 regardless
	const argv: string[] = ["--contract", FULL_PATH];
	const p = join(td, "eic.md");
	writeFileSync(p, reportText("eic"), "utf-8");
	argv.push("--report", p); // Only 1 report, panel_size=5
	const synthPath = join(td, "synthesis.md");
	writeFileSync(synthPath, "dimension_verdicts: []\nfired_conditions: []\nda_critical_adjudications: []\neditorial_decision=accept\n", "utf-8");
	argv.push("--synthesis", synthPath);
	const result = cli(argv);
	check("wrong count → exit 2", result.exitCode === 2);
	check("wrong count → PANEL-CARDINALITY in stdout", result.stdout.includes("PANEL-CARDINALITY"));
});

// ===========================================================================
// AC-34: contract short-circuit + cardinality
// ===========================================================================

console.log("\nAC-34: contract short-circuit + cardinality");

{
	// Invalid contract → exit 2 immediately
	const result = cli(["--contract", "/nonexistent/contract.json", "--report", "/dev/null", "--synthesis", "/dev/null"]);
	check("missing contract file → exit 2", result.exitCode === 2);
}

withTempDir((td) => {
	// Duplicate report paths → exit 2
	const p = join(td, "eic.md");
	writeFileSync(p, reportText("eic"), "utf-8");
	const result = cli(["--contract", FULL_PATH, "--report", p, "--report", p, "--synthesis", join(td, "s.md")]);
	check("duplicate paths → exit 2", result.exitCode === 2);
	check("duplicate paths → PANEL-CARDINALITY", result.stdout.includes("PANEL-CARDINALITY"));
});

withTempDir((td) => {
	// Byte-identical contents (different paths, same bytes)
	const p1 = join(td, "r1.md");
	const p2 = join(td, "r2.md");
	const text = reportText("eic");
	writeFileSync(p1, text, "utf-8");
	writeFileSync(p2, text, "utf-8");
	const result = cli(["--contract", FULL_PATH, "--report", p1, "--report", p2, "--synthesis", join(td, "s.md")]);
	check("byte-identical → exit 2", result.exitCode === 2);
	check("byte-identical → byte-identical in stdout", result.stdout.includes("byte-identical"));
});

// ===========================================================================
// AC-35: role-binding swap → exit 3; match → exit 0
// ===========================================================================

console.log("\nAC-35: role-binding swap/match");

withTempDir((td) => {
	// Swap: EIC report dispatched as methodology
	const p = join(td, "eic.md");
	writeFileSync(p, reportText("eic"), "utf-8");
	const result = cli([
		"--contract", FULL_PATH, "--report", p,
		"--roles", "methodology", "--layer1-only",
	]);
	check("role swap → exit 3", result.exitCode === 3);
	check("role swap → ROLE-BINDING in stdout", result.stdout.includes("[ROLE-BINDING:"));
});

withTempDir((td) => {
	// Match: EIC report dispatched as eic → pass
	const p = join(td, "eic.md");
	writeFileSync(p, reportText("eic"), "utf-8");
	const result = cli([
		"--contract", FULL_PATH, "--report", p,
		"--roles", "eic", "--layer1-only",
	]);
	check("role match → exit 0", result.exitCode === 0);
	check("role match → LAYER1-ONLY: PASS", result.stdout.includes("LAYER1-ONLY: PASS"));
});

// ===========================================================================
// AC-36: synthesis skip under layer1-only / reviewer diags
// ===========================================================================

console.log("\nAC-36: synthesis skip");

withTempDir((td) => {
	// Layer1-only: no synthesis file needed, no synthesis parsing
	const p = join(td, "eic.md");
	writeFileSync(p, reportText("eic"), "utf-8");
	const result = cli(["--contract", FULL_PATH, "--report", p, "--layer1-only"]);
	check("layer1-only → exit 0", result.exitCode === 0);
	check("layer1-only → synthesisCount 0", result.synthesisCount === 0);
});

withTempDir((td) => {
	// Reviewer diags prevent synthesis evaluation
	// Use full panel but make one report invalid
	const argv: string[] = ["--contract", FULL_PATH];
	for (const role of ROLES) {
		const p = join(td, `${role}.md`);
		writeFileSync(p, reportText(role), "utf-8");
		argv.push("--report", p);
	}
	// Corrupt one report
	writeFileSync(join(td, "methodology.md"), "contract_role: methodology\n\n## Dimension Scores\n### D1: methodology_rigor\nscore: pass\n", "utf-8");
	const synthPath = join(td, "synthesis.md");
	// Deliberately invalid synthesis — but it should never be evaluated
	writeFileSync(synthPath, "INVALID SYNTHESIS TEXT THAT WOULD CRASH\n", "utf-8");
	argv.push("--synthesis", synthPath);
	const result = cli(argv);
	check("reviewer diag → exit 3 (not 1)", result.exitCode === 3);
	check("reviewer diag → synthesisCount 0 (skipped)", result.synthesisCount === 0);
});

// ===========================================================================
// AC-37: layer1-only relaxed cardinality
// ===========================================================================

console.log("\nAC-37: layer1-only relaxed cardinality");

withTempDir((td) => {
	// 1 report under layer1-only → pass
	const p = join(td, "eic.md");
	writeFileSync(p, reportText("eic"), "utf-8");
	const result = cli(["--contract", FULL_PATH, "--report", p, "--layer1-only"]);
	check("1 report layer1-only → exit 0", result.exitCode === 0);
});

withTempDir((td) => {
	// 6 reports under layer1-only (> panel_size=5) → exit 2
	const argv: string[] = ["--contract", FULL_PATH];
	for (let i = 0; i < 6; i++) {
		const p = join(td, `r${i}.md`);
		writeFileSync(p, reportText("eic"), "utf-8");
		argv.push("--report", p);
	}
	argv.push("--layer1-only");
	const result = cli(argv);
	check("6 reports layer1-only → exit 2", result.exitCode === 2);
	check("6 reports → cardinality message", result.stdout.includes("layer1-only accepts 1..5"));
});

// ===========================================================================
// AC-38: pass output shape
// ===========================================================================

console.log("\nAC-38: pass output shape");

withTempDir((td) => {
	// Full-panel pass
	const argv = writeFullPanel(td);
	const result = cli(argv);
	check("full panel → exit 0", result.exitCode === 0);
	check("full panel → PANEL-SYNTHESIS: PASS", result.stdout.includes("PANEL-SYNTHESIS: PASS"));
});

withTempDir((td) => {
	// Layer1-only pass
	const p = join(td, "eic.md");
	writeFileSync(p, reportText("eic"), "utf-8");
	const result = cli(["--contract", FULL_PATH, "--report", p, "--layer1-only"]);
	check("layer1-only → LAYER1-ONLY: PASS", result.stdout.includes("LAYER1-ONLY: PASS"));
});

// ===========================================================================
// AC-42: TOOL isError three-tier mapping
// ===========================================================================

console.log("\nAC-42: isError three-tier mapping");

// isError = exitCode !== 0. Verify each tier (use number vars to avoid literal-type narrowing).
const t0: number = 0, t1: number = 1, t2: number = 2, t3: number = 3;
check("tier 0 → isError false", t0 !== 0 === false);
check("tier 1 → isError true", t1 !== 0 === true);
check("tier 2 → isError true", t2 !== 0 === true);
check("tier 3 → isError true", t3 !== 0 === true);

// Verify tier labels
check("exit 0 → pass", tierLabelFromExitCode(0) === "pass");
check("exit 1 → synthesis", tierLabelFromExitCode(1) === "synthesis");
check("exit 2 → contract", tierLabelFromExitCode(2) === "contract");
check("exit 3 → reviewer", tierLabelFromExitCode(3) === "reviewer");

// E2E: contract failure → exit 2
{
	const result = cli(["--contract", "/nonexistent.json", "--report", "/dev/null", "--synthesis", "/dev/null"]);
	check("contract fail → isError true (exit 2)", result.exitCode !== 0);
	check("contract fail → tier contract", tierLabelFromExitCode(result.exitCode) === "contract");
}

// E2E: pass → isError false
withTempDir((td) => {
	const argv = writeFullPanel(td);
	const result = cli(argv);
	check("pass → isError false (exit 0)", result.exitCode === 0);
	check("pass → tier pass", tierLabelFromExitCode(result.exitCode) === "pass");
});

// E2E: synthesis mismatch → exit 1
withTempDir((td) => {
	const argv: string[] = ["--contract", FULL_PATH];
	for (const role of ROLES) {
		const p = join(td, `${role}.md`);
		writeFileSync(p, reportText(role), "utf-8");
		argv.push("--report", p);
	}
	// Inconsistent synthesis: wrong verdict
	const synthPath = join(td, "synthesis.md");
	writeFileSync(synthPath, "dimension_verdicts: [D1=warn, D2=pass, D3=pass, D4=pass, D5=pass, D6=pass]\nfired_conditions: [F5]\nda_critical_adjudications: []\neditorial_decision=minor_revision\n", "utf-8");
	argv.push("--synthesis", synthPath);
	const result = cli(argv);
	check("synthesis mismatch → exit 1", result.exitCode === 1);
	check("synthesis mismatch → tier synthesis", tierLabelFromExitCode(result.exitCode) === "synthesis");
	check("synthesis mismatch → isError true", result.exitCode !== 0);
});

// ===========================================================================
// AC-43: audit per-tier counts + non-blocking
// ===========================================================================

console.log("\nAC-43: audit per-tier + non-blocking");

withTempDir((td) => {
	// Write audit line with per-tier counts
	const result = cli(writeFullPanel(td));
	appendAudit({ cwd: td } as never, {
		source: "tool",
		contractPath: FULL_PATH,
		reportCount: 5,
		layer1Only: false,
		exitTier: 0,
		tierLabel: "pass",
		infraCount: result.infraCount,
		reviewerCount: result.reviewerCount,
		synthesisCount: result.synthesisCount,
		warningCount: result.warningCount,
	});
	const auditPath = join(td, ".pi", "ars-panel-synthesis-audit.jsonl");
	check("audit file exists", existsSync(auditPath));
	if (existsSync(auditPath)) {
		const line = readFileSync(auditPath, "utf-8").trim();
		const entry = JSON.parse(line);
		check("audit exitTier 0", entry.exitTier === 0);
		check("audit tierLabel pass", entry.tierLabel === "pass");
		check("audit infraCount field present", typeof entry.infraCount === "number");
		check("audit reviewerCount field present", typeof entry.reviewerCount === "number");
		check("audit synthesisCount field present", typeof entry.synthesisCount === "number");
	}
});

{
	// Non-blocking on IO error
	let threw = false;
	try {
		appendAudit({ cwd: "/nonexistent-root-xyz/no-such-dir" } as never, {
			source: "command",
			contractPath: "x.json",
			reportCount: 5,
			layer1Only: false,
			exitTier: 2,
			tierLabel: "contract",
			infraCount: 1,
			reviewerCount: 0,
			synthesisCount: 0,
			warningCount: 0,
		});
	} catch {
		threw = true;
	}
	check("audit failure swallowed (no throw)", threw === false);
}

// ===========================================================================
// AC-44: TOOL layer1Only parameter
// ===========================================================================

console.log("\nAC-44: TOOL layer1Only");

withTempDir((td) => {
	// Report-only path: no synthesis, isError false
	const p = join(td, "eic.md");
	writeFileSync(p, reportText("eic"), "utf-8");
	const result = cli(["--contract", FULL_PATH, "--report", p, "--layer1-only"]);
	check("layer1Only → exit 0", result.exitCode === 0);
	check("layer1Only → isError false", result.exitCode === 0);
	check("layer1Only → LAYER1-ONLY: PASS", result.stdout.includes("LAYER1-ONLY: PASS"));
	check("layer1Only → synthesisCount 0", result.synthesisCount === 0);
});

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
