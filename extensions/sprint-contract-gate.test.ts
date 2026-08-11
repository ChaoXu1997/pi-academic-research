// Unit tests for the sprint-contract gate (warn_suspicious, cli, runGate).
// Run via: tsc -p tsconfig.test.json && node .test-build/sprint-contract-gate.test.js
//
// These tests port the upstream warning/CLI oracle plus the net-new Pi fail-closed
// surface (AC-9, AC-1, AC-2, AC-10, AC-12, AC-13). They exercise the pure
// warn_suspicious() / cli() / runGate() functions directly — no Pi runtime.

import {
	warn_suspicious,
	cli,
	runGate,
	parseArgs,
	appendAudit,
	type GateResult,
} from "./sprint-contract-gate.js";
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { SprintContract } from "./core/sprint-contract-core.js";

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
const WRITER_PATH = join(
	REPO,
	"upstream",
	"shared",
	"contracts",
	"writer",
	"full.json",
);
const EVALUATOR_PATH = join(
	REPO,
	"upstream",
	"shared",
	"contracts",
	"evaluator",
	"full.json",
);

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

function load(path: string): SprintContract {
	return JSON.parse(readFileSync(path, "utf-8")) as SprintContract;
}

function full(): SprintContract {
	return load(FULL_PATH);
}

function clone<T>(x: T): T {
	return JSON.parse(JSON.stringify(x)) as T;
}

function withTempDir(fn: (dir: string) => void): void {
	const dir = join(
		tmpdir(),
		`ars-sprint-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// AC-9: 14 WARNING_CASES
// ---------------------------------------------------------------------------

const WARNING_CASES: [string, string, boolean][] = [
	["sc1_lag", "SC-1", true],
	["sc1_exact_two", "SC-1", false],
	["sc1_no_current", "SC-1", false],
	["sc2_single", "SC-2", true],
	["sc3_no_mandatory", "SC-3", true],
	["sc4_orphan", "SC-4", true],
	["sc5_missing_output", "SC-5", true],
	["sc7_conflict", "SC-7", true],
	["sc9_impossible", "SC-9", true],
	["sc10_unreferenced", "SC-10", true],
	["sc11_single", "SC-11", true],
	["sc11_mode_mismatch", "SC-11", true],
	["writer_no_sc5", "SC-5", false],
	["writer_no_sc11", "SC-11", false],
];

// Faithful port of upstream test_legacy_warning_boundaries setup.
function setupWarningCase(cas: string): {
	contract: SprintContract;
	current: string | null;
} {
	const contract = full();
	let current: string | null = null;
	const dims = contract.acceptance_dimensions as Record<string, unknown>[];
	const conds = contract.failure_conditions as Record<string, unknown>[];
	const mp = contract.measurement_procedure as Record<string, unknown>;

	if (cas === "sc1_lag") {
		contract.baseline_version = "v3.3.0";
		current = "v3.6.2";
	} else if (cas === "sc1_exact_two") {
		contract.baseline_version = "v3.4.0";
		current = "v3.6.2";
	} else if (cas === "sc1_no_current") {
		contract.baseline_version = "v3.3.0";
	} else if (cas === "sc2_single") {
		contract.acceptance_dimensions = dims.slice(0, 1);
	} else if (cas === "sc3_no_mandatory") {
		for (const dim of dims) dim.priority = "normal";
	} else if (cas === "sc4_orphan") {
		conds[0].expression = "D99 scores 'block'";
	} else if (cas === "sc5_missing_output") {
		mp.reviewer_must_output_before_paper = ["contract_paraphrase"];
	} else if (cas === "sc7_conflict") {
		conds[1].severity = conds[0].severity;
	} else if (cas === "sc9_impossible") {
		mp.paraphrase_minimum_dimensions = 99;
	} else if (cas === "sc10_unreferenced") {
		contract.failure_conditions = [
			{
				condition_id: "F0",
				severity: 0,
				cross_reviewer_quantifier: "all",
				expression: "every dimension scores 'pass'",
				action: "editorial_decision=accept",
			},
		];
	} else if (cas === "sc11_single") {
		contract.panel_size = 1;
	} else if (cas === "sc11_mode_mismatch") {
		contract.panel_size = 4;
	} else if (cas.startsWith("writer_")) {
		return { contract: load(WRITER_PATH), current };
	} else {
		throw new Error(`unknown warning case: ${cas}`);
	}
	return { contract, current };
}

console.log("test_legacy_warning_boundaries (14 cases)");
let warningPassCount = 0;
for (const [cas, fragment, present] of WARNING_CASES) {
	const { contract, current } = setupWarningCase(cas);
	const warnings = warn_suspicious(contract, current);
	const has = warnings.some((w) => w.startsWith(`${fragment} WARNING`));
	if (has === present) {
		warningPassCount++;
	} else {
		console.error(
			`    [FAIL] case '${cas}': expected ${fragment} ${present ? "present" : "absent"}, got ${has ? "present" : "absent"}`,
		);
	}
}
check(
	`all 14 WARNING_CASES correct (${warningPassCount}/14)`,
	warningPassCount === 14,
);

// ---------------------------------------------------------------------------
// AC-9: SC-1 boundary (lag exactly 2 → no fire) — explicit
// ---------------------------------------------------------------------------

console.log("test_sc1_boundary_lag_two_no_fire");
{
	const contract = full();
	contract.baseline_version = "v3.4.0";
	const warnings = warn_suspicious(contract, "v3.6.2");
	check(
		"no SC-1 at lag==2",
		!warnings.some((w) => w.startsWith("SC-1 WARNING")),
	);
}

// ---------------------------------------------------------------------------
// AC-9: SC-12 single-judge mandatory gate on shipped full
// ---------------------------------------------------------------------------

console.log("test_sc12_single_judge_mandatory_warning");
{
	const warnings = warn_suspicious(full(), "v3.20.0");
	const sc12Dims = new Set<string>();
	for (const w of warnings) {
		if (w.includes("SC-12")) {
			const m = /dimension (D\d+)/.exec(w);
			if (m) sc12Dims.add(m[1]);
		}
	}
	check(
		"SC-12 dims == {D1, D2, D6}",
		sc12Dims.size === 3 &&
			sc12Dims.has("D1") &&
			sc12Dims.has("D2") &&
			sc12Dims.has("D6"),
	);
}

// ---------------------------------------------------------------------------
// AC-9: SC-9 mode-specific source (writer / evaluator)
// ---------------------------------------------------------------------------

console.log("test_generator_sc9_reads_mode_specific_source");
{
	// writer
	const writer = load(WRITER_PATH);
	const pca = (writer.pre_commitment_artifacts as Record<string, unknown>)
		.acceptance_criteria_paraphrase as Record<string, unknown>;
	pca.minimum_dimensions = 99;
	check(
		"writer SC-9 fires (pmd source)",
		warn_suspicious(writer, null).some((w) => w.startsWith("SC-9 WARNING")),
	);
	// evaluator
	const evaluator = load(EVALUATOR_PATH);
	(
		evaluator.disagreement_handling as Record<string, unknown>
	).paraphrase_minimum_dimensions = 99;
	check(
		"evaluator SC-9 fires (pmd source)",
		warn_suspicious(evaluator, null).some((w) => w.startsWith("SC-9 WARNING")),
	);
}

// ---------------------------------------------------------------------------
// AC-9: writer/evaluator do NOT receive SC-5 or SC-11
// ---------------------------------------------------------------------------

console.log("test_generator_modes_do_not_receive_reviewer_only_warnings");
for (const [label, path] of [
	["writer", WRITER_PATH],
	["evaluator", EVALUATOR_PATH],
] as const) {
	const warnings = warn_suspicious(load(path), null);
	check(
		`${label} no SC-5`,
		!warnings.some((w) => w.startsWith("SC-5 WARNING")),
	);
	check(
		`${label} no SC-11`,
		!warnings.some((w) => w.startsWith("SC-11 WARNING")),
	);
}

// ---------------------------------------------------------------------------
// AC-1, AC-2: CLI exit codes
// ---------------------------------------------------------------------------

console.log("test_cli_valid_contract_exit0");
withTempDir((td) => {
	const path = join(td, "valid.json");
	writeFileSync(path, JSON.stringify(full()), "utf-8");
	const r = cli([path]);
	check("exit 0", r.exitCode === 0);
	check(
		"stdout has OK line",
		r.stdout.includes("is a valid sprint_contract (Schema 13.2)"),
	);
});

console.log("test_cli_ars_version_with_and_without_v");
withTempDir((td) => {
	const path = join(td, "valid.json");
	const contract = full();
	contract.baseline_version = "v3.3.0";
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const r1 = cli([path, "--ars-version", "v3.6.2"]);
	const r2 = cli([path, "--ars-version", "3.6.2"]);
	check("v-prefix SC-1 fires", r1.stderr.includes("SC-1 WARNING"));
	check(
		"no-v-prefix SC-1 fires (identical)",
		r2.stderr.includes("SC-1 WARNING"),
	);
	check("both exit 0", r1.exitCode === 0 && r2.exitCode === 0);
});

console.log("test_cli_missing_file_exit1");
withTempDir((td) => {
	const path = join(td, "missing.json");
	const r = cli([path]);
	check("exit 1", r.exitCode === 1);
	check("stderr has ERROR", r.stderr.includes("ERROR:"));
	check("stdout empty", r.stdout === "");
});

console.log("test_cli_bad_json_exit1");
withTempDir((td) => {
	const path = join(td, "bad.json");
	writeFileSync(path, "{", "utf-8");
	const r = cli([path]);
	check("exit 1", r.exitCode === 1);
	check("stderr has ERROR", r.stderr.includes("ERROR:"));
	check("stdout empty", r.stdout === "");
});

console.log("test_cli_schema_failure_exit1");
withTempDir((td) => {
	const contract = full();
	contract.mode = "reviewer_quick";
	const path = join(td, "bad_mode.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const r = cli([path]);
	check("exit 1", r.exitCode === 1);
	check(
		"stderr has ERROR + count",
		r.stderr.includes("ERROR:") && r.stderr.includes("schema violation"),
	);
	check("stdout empty", r.stdout === "");
});

console.log("test_cli_structural_failure_exit1");
withTempDir((td) => {
	const contract = full();
	(contract.acceptance_dimensions as Record<string, unknown>[])[1].id = "D1";
	const path = join(td, "dup.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const r = cli([path]);
	check("exit 1", r.exitCode === 1);
	check(
		"stderr has ERROR + count",
		r.stderr.includes("ERROR:") && r.stderr.includes("structural invariant"),
	);
	check("stdout empty", r.stdout === "");
});

console.log("test_cli_precedence_schema_short_circuits");
withTempDir((td) => {
	const contract = full();
	contract.mode = "reviewer_quick"; // schema error
	(contract.acceptance_dimensions as Record<string, unknown>[])[1].id = "D1"; // structural error
	const path = join(td, "both.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const r = cli([path]);
	check("exit 1", r.exitCode === 1);
	check(
		"only schema errors reported",
		r.stderr.includes("schema violation") &&
			!r.stderr.includes("structural invariant"),
	);
});

console.log("test_cli_pass_with_sc1_warning_exit0");
withTempDir((td) => {
	const contract = full();
	contract.baseline_version = "v3.3.0";
	const path = join(td, "lag.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const r = cli([path, "--ars-version", "v3.6.2"]);
	check("exit 0 (warning does not block)", r.exitCode === 0);
	check("warning on stderr", r.stderr.includes("SC-1 WARNING"));
	check("OK on stdout", r.stdout.includes("is a valid sprint_contract"));
});

// ---------------------------------------------------------------------------
// AC-10: output shape
// ---------------------------------------------------------------------------

console.log("test_output_shape_pass");
withTempDir((td) => {
	const path = join(td, "valid.json");
	writeFileSync(path, JSON.stringify(full()), "utf-8");
	const r = cli([path]);
	check(
		"stdout is OK line",
		r.stdout.startsWith("OK:") && r.stdout.includes("Schema 13.2"),
	);
});

console.log("test_output_shape_schema_failure");
withTempDir((td) => {
	const contract = full();
	contract.mode = "reviewer_quick";
	const path = join(td, "s.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const r = cli([path]);
	check(
		"stderr has N schema violation(s)",
		/schema violation\(s\)/.test(r.stderr),
	);
});

console.log("test_output_shape_structural_failure");
withTempDir((td) => {
	const contract = full();
	(contract.acceptance_dimensions as Record<string, unknown>[])[1].id = "D1";
	const path = join(td, "st.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const r = cli([path]);
	check(
		"stderr has N structural invariant violation(s)",
		/structural invariant violation\(s\)/.test(r.stderr),
	);
});

// ---------------------------------------------------------------------------
// AC-12: fail-closed TOOL isError posture (via runGate)
// ---------------------------------------------------------------------------

console.log("test_tool_isError_schema_failure");
withTempDir((td) => {
	const contract = full();
	contract.mode = "reviewer_quick";
	const path = join(td, "s.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const result = runGate(path, null);
	check("isError true on schema failure", result.isError === true);
	check("verdict schema_error", result.verdict === "schema_error");
});

console.log("test_tool_isError_structural_failure");
withTempDir((td) => {
	const contract = full();
	(contract.acceptance_dimensions as Record<string, unknown>[])[1].id = "D1";
	const path = join(td, "st.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const result = runGate(path, null);
	check("isError true on structural failure", result.isError === true);
	check("verdict structural_error", result.verdict === "structural_error");
});

console.log("test_tool_isError_file_error");
withTempDir((td) => {
	const path = join(td, "nope.json");
	const result = runGate(path, null);
	check("isError true on file error", result.isError === true);
	check("verdict file_error", result.verdict === "file_error");
});

console.log("test_tool_isError_false_on_pass_with_warnings");
withTempDir((td) => {
	const contract = full();
	contract.baseline_version = "v3.3.0";
	const path = join(td, "lag.json");
	writeFileSync(path, JSON.stringify(contract), "utf-8");
	const result = runGate(path, "v3.6.2");
	check("isError false on pass (warnings present)", result.isError === false);
	check("verdict pass", result.verdict === "pass");
	check(
		"warnings carried",
		result.warnings.some((w) => w.startsWith("SC-1 WARNING")),
	);
});

// ---------------------------------------------------------------------------
// AC-13: audit trail (best-effort, never blocks)
// ---------------------------------------------------------------------------

console.log("test_audit_line_written_on_pass");
withTempDir((td) => {
	const contractPath = join(td, "valid.json");
	writeFileSync(contractPath, JSON.stringify(full()), "utf-8");
	const result = runGate(contractPath, null);
	appendAudit({ cwd: td } as never, {
		source: "tool",
		contractPath,
		arsVersion: null,
		verdict: result.verdict,
		schemaErrorCount: result.schemaErrors.length,
		structuralErrorCount: result.structuralErrors.length,
		warningCount: result.warnings.length,
		warnings: result.warnings,
	});
	const auditPath = join(td, ".pi", "ars-sprint-contract-audit.jsonl");
	check("audit file exists", existsSync(auditPath));
	if (existsSync(auditPath)) {
		const line = readFileSync(auditPath, "utf-8").trim();
		const entry = JSON.parse(line);
		check("audit verdict pass", entry.verdict === "pass");
		check("audit source tool", entry.source === "tool");
	}
});

console.log("test_audit_failure_does_not_block");
{
	// appendAudit swallows errors; passing an unwritable ctx must not throw.
	let threw = false;
	try {
		appendAudit({ cwd: "/nonexistent-root-xyz/no-such-dir" } as never, {
			source: "command",
			contractPath: "x.json",
			arsVersion: null,
			verdict: "pass",
			schemaErrorCount: 0,
			structuralErrorCount: 0,
			warningCount: 0,
			warnings: [],
		});
	} catch {
		threw = true;
	}
	check("audit failure swallowed (no throw)", threw === false);
}

// ---------------------------------------------------------------------------
// parseArgs sanity
// ---------------------------------------------------------------------------

console.log("test_parseArgs");
{
	const a1 = parseArgs(["c.json", "--ars-version", "v3.6.2"]);
	check(
		"positional + flag",
		a1.contract === "c.json" && a1.arsVersion === "v3.6.2",
	);
	const a2 = parseArgs(["--ars-version=3.6.2", "c.json"]);
	check("equals form", a2.contract === "c.json" && a2.arsVersion === "3.6.2");
	const a3 = parseArgs(["c.json"]);
	check("no version", a3.contract === "c.json" && a3.arsVersion === null);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
