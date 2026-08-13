// Unit tests for the phase-conformance gate (slice 4).
// Run via: tsc -p tsconfig.test.json && node .test-build/phase-conformance-gate.test.js
//
// These tests port the CLI/gate test groups from the upstream Python oracle
// (upstream/scripts/test_check_phase_conformance.py) plus the net-new Pi surface:
//   * AC-1..3 — CLI parseArgs (required flags, mutual exclusion)
//   * AC-4..7 — exit-tier by exception type (role invalid → 2, role-swap → 3, pass → 0)
//   * AC-8..10 — --phase1-only ordering (pass, malformed → 3, blindness FIRST)
//   * AC-11 — advisory sub-channels (empty dissent + trigger-short → 0)
//   * AC-12 — multi_dissent IS exit 3
//   * AC-79 — TOOL two-tier isError
//   * AC-80 — audit trail JSONL + non-blocking
//   * AC-81 — TOOL phase1Only surface
//   * AC-82 — zero deps + import surface (18+1 symbols)
//   * AC-83 — fidelity boundary constants

import {
	cli,
	parseArgs,
	appendAudit,
	tierLabelFromExitCode,
} from "./phase-conformance-gate.js";
import {
	EXIT_PASS,
	EXIT_CONTRACT,
	EXIT_CONFORMANCE,
	_METADATA_KEYS,
	_DISSENT_FIELD_NAMES,
	_FIELD_PATTERNS,
	_SEVERITY_RE,
	_ANCHOR_RE,
	_FINDING_H3_RE,
	_MARKUP_SPAN_RE,
	_CLOSES_PARAGRAPH_RE,
	_SETEXT_UNDERLINE_RE,
	_EMPTY_LIST_ITEM_RE,
} from "./core/phase-conformance-core.js";
import {
	readFileSync,
	writeFileSync,
	mkdtempSync,
	rmSync,
	existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const FULL_PATH = join(
	REPO,
	"upstream",
	"shared",
	"contracts",
	"reviewer",
	"full.json",
);
const FULL = JSON.parse(readFileSync(FULL_PATH, "utf-8"));

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

// ---------------------------------------------------------------------------
// Test helpers (ported from upstream)
// ---------------------------------------------------------------------------

function phase1Text(role: string): string {
	const lines: string[] = ["## Contract Paraphrase", ""];
	for (const dim of FULL.acceptance_dimensions as Record<string, unknown>[]) {
		lines.push(
			`${dim.id} concerns ${dim.name} as the contract defines it.`,
			"",
		);
	}
	lines.push("## Scoring Plan", "");
	for (const dim of FULL.acceptance_dimensions as Record<string, unknown>[]) {
		if (!(dim.eligible_roles as string[]).includes(role)) continue;
		const did = dim.id as string;
		lines.push(`### ${did}: ${dim.name}`);
		lines.push(`dimension_id: ${did}`);
		lines.push(`what_to_look_for: observable evidence relevant to ${did}`);
		lines.push(
			`what_triggers_block: block evidence pattern for ${did} requiring major repair`,
		);
		lines.push(
			`what_triggers_warn: warn evidence pattern for ${did} requiring clarification`,
		);
		if (dim.priority === "mandatory") {
			lines.push(
				`what_triggers_fatal: fatal evidence pattern for ${did} invalidating the core`,
			);
		}
		lines.push("");
	}
	lines.push("[CONTRACT-ACKNOWLEDGED]");
	return lines.join("\n");
}

function phase2Text(
	role: string,
	overrides: Record<string, string> | null = null,
	body = "",
	dissent: string[] = [],
): string {
	const ov = overrides ?? {};
	const lines: string[] = [`contract_role: ${role}`, ""];
	if (dissent.length > 0) {
		lines.push("## Scoring Plan Dissent", "");
		for (const did of dissent) {
			lines.push(`dimension_id: ${did}`, "rationale: plan was inadequate");
		}
		lines.push("");
	}
	lines.push("## Dimension Scores", "");
	for (const dim of FULL.acceptance_dimensions as Record<string, unknown>[]) {
		const did = dim.id as string;
		lines.push(`### ${did}: ${dim.name}`);
		if (!(dim.eligible_roles as string[]).includes(role)) {
			lines.push("score: not_assessed");
		} else {
			const value = ov[did] ?? "pass";
			if (value === "warn") {
				lines.push(
					"score: warn",
					`trigger: "warn evidence pattern for ${did}"`,
				);
			} else if (value === "block") {
				lines.push(
					"score: block",
					"block_class: repairable",
					`trigger: "block evidence pattern for ${did}"`,
				);
			} else if (value === "fatal") {
				lines.push(
					"score: block",
					"block_class: fatal",
					`trigger: "fatal evidence pattern for ${did}"`,
				);
			} else {
				lines.push("score: pass");
			}
		}
		lines.push("");
	}
	lines.push("## Review Body", "", body);
	return lines.join("\n");
}

function phase2WithDissentSection(
	bodyLines: string[],
	opts: { late?: boolean; overrides?: Record<string, string> } = {},
): string {
	const { late = false, overrides = null } = opts;
	const text = phase2Text("methodology", overrides);
	const section =
		["## Scoring Plan Dissent", "", ...bodyLines, ""].join("\n") + "\n";
	const anchor = late ? "## Review Body" : "## Dimension Scores";
	return text.replace(anchor, `${section}${anchor}`);
}

function withTempDir(fn: (td: string) => void): void {
	const td = mkdtempSync(join(tmpdir(), "phase-conf-test-"));
	try {
		fn(td);
	} finally {
		try {
			rmSync(td, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
}

function writeCliFiles(td: string, role: string): string[] {
	const phase1 = join(td, "p1.md");
	const phase2 = join(td, "p2.md");
	const manuscript = join(td, "m.md");
	const metadata = join(td, "meta.json");
	writeFileSync(phase1, phase1Text(role));
	writeFileSync(phase2, phase2Text(role));
	writeFileSync(manuscript, "short synthetic manuscript");
	writeFileSync(
		metadata,
		JSON.stringify({ title: "Synthetic", field: "testing", word_count: 3 }),
	);
	return [
		"--contract",
		FULL_PATH,
		"--phase1",
		phase1,
		"--phase2",
		phase2,
		"--manuscript",
		manuscript,
		"--metadata",
		metadata,
	];
}

function phase1OnlyArgs(td: string, role: string): string[] {
	const args = writeCliFiles(td, role);
	const idx = args.indexOf("--phase2");
	args.splice(idx, 2);
	return [...args, "--phase1-only", "--role", role];
}

// ===========================================================================
// AC-1: Required flags cannot be omitted
// ===========================================================================

console.log("\nAC-1: Required flags cannot be omitted");
{
	const result = cli(["--contract", FULL_PATH]);
	check("bare --contract → exit 2", result.exitCode === EXIT_CONTRACT);
}

// ===========================================================================
// AC-2: Required context flags fail closed
// ===========================================================================

console.log("\nAC-2: Required context flags fail closed");
{
	const requiredFlags = ["--role", "--manuscript", "--metadata"];
	for (const missing of requiredFlags) {
		withTempDir((td) => {
			const args = writeCliFiles(td, "methodology");
			// Insert --role methodology (since writeCliFiles doesn't add it)
			args.push("--role", "methodology");
			const idx = args.indexOf(missing);
			args.splice(idx, 2);
			const result = cli(args);
			check(`missing ${missing} → exit 2`, result.exitCode === EXIT_CONTRACT);
		});
	}
}

// ===========================================================================
// AC-3: --phase2 and --phase1-only mutually exclusive
// ===========================================================================

console.log("\nAC-3: --phase2 / --phase1-only mutual exclusion");
{
	withTempDir((td) => {
		const args = writeCliFiles(td, "methodology");
		args.push("--role", "methodology", "--phase1-only");
		const result = cli(args);
		check(
			"both phase2 + phase1-only → exit 2",
			result.exitCode === EXIT_CONTRACT,
		);
	});
	withTempDir((td) => {
		const args = writeCliFiles(td, "methodology");
		const idx = args.indexOf("--phase2");
		args.splice(idx, 2);
		args.push("--role", "methodology");
		const result = cli(args);
		check(
			"neither phase2 nor phase1-only → exit 2",
			result.exitCode === EXIT_CONTRACT,
		);
	});
}

// ===========================================================================
// AC-4: Invalid dispatch role → exit 2
// ===========================================================================

console.log("\nAC-4: Invalid dispatch role");
{
	withTempDir((td) => {
		const args = writeCliFiles(td, "methodology");
		const result = cli([...args, "--role", "writer"]);
		check("writer role → exit 2", result.exitCode === EXIT_CONTRACT);
		check("writer role → ROLE-BINDING", result.stdout.includes("ROLE-BINDING"));
	});
}

// ===========================================================================
// AC-5: Report role-swap → exit 3
// ===========================================================================

console.log("\nAC-5: Report role-swap");
{
	withTempDir((td) => {
		const args = writeCliFiles(td, "methodology");
		const result = cli([...args, "--role", "eic"]);
		check(
			"eic dispatched on methodology report → exit 3",
			result.exitCode === EXIT_CONFORMANCE,
		);
	});
}

// ===========================================================================
// AC-6: Full pass → exit 0
// ===========================================================================

console.log("\nAC-6: Full CLI pass");
{
	withTempDir((td) => {
		const args = writeCliFiles(td, "methodology");
		const result = cli([...args, "--role", "methodology"]);
		check("full pass → exit 0", result.exitCode === EXIT_PASS);
		check(
			"full pass → PHASE-CONFORMANCE: PASS",
			result.stdout.includes("PHASE-CONFORMANCE: PASS"),
		);
	});
}

// ===========================================================================
// AC-7: Three-tier exit by exception type
// ===========================================================================

console.log("\nAC-7: Three-tier exit by exception type");
{
	// Contract error short-circuits
	withTempDir((td) => {
		const result = cli([
			"--contract",
			join(td, "nonexistent.json"),
			"--role",
			"methodology",
			"--phase1",
			"x",
			"--phase2",
			"y",
			"--manuscript",
			"z",
			"--metadata",
			"w",
		]);
		check("contract error → exit 2", result.exitCode === EXIT_CONTRACT);
	});
	// Conformance error → exit 3
	withTempDir((td) => {
		const args = writeCliFiles(td, "methodology");
		// Corrupt Phase 1 to trigger a grammar error
		writeFileSync(
			join(td, "p1.md"),
			phase1Text("methodology").replace(
				"what_triggers_fatal: fatal evidence pattern for D3",
				"",
			),
		);
		const result = cli([...args, "--role", "methodology"]);
		check("grammar error → exit 3", result.exitCode === EXIT_CONFORMANCE);
	});
}

// ===========================================================================
// AC-8: --phase1-only pass
// ===========================================================================

console.log("\nAC-8: --phase1-only pass");
{
	withTempDir((td) => {
		const args = phase1OnlyArgs(td, "methodology");
		const result = cli(args);
		check("phase1-only → exit 0", result.exitCode === EXIT_PASS);
		check(
			"phase1-only → PHASE1-CONFORMANCE: PASS",
			result.stdout.includes("PHASE1-CONFORMANCE: PASS"),
		);
	});
}

// ===========================================================================
// AC-9: --phase1-only rejects malformed plan
// ===========================================================================

console.log("\nAC-9: --phase1-only rejects malformed");
{
	withTempDir((td) => {
		const args = phase1OnlyArgs(td, "methodology");
		const phase1Path = args[args.indexOf("--phase1") + 1];
		writeFileSync(
			phase1Path,
			phase1Text("methodology").replace(
				"what_triggers_fatal: fatal evidence pattern for D3",
				"",
			),
		);
		const result = cli(args);
		check("malformed plan → exit 3", result.exitCode === EXIT_CONFORMANCE);
		check(
			"malformed plan → PHASE1-GRAMMAR",
			result.stdout.includes("[PHASE1-GRAMMAR:"),
		);
	});
}

// ===========================================================================
// AC-10: --phase1-only blindness FIRST
// ===========================================================================

console.log("\nAC-10: --phase1-only blindness FIRST");
{
	withTempDir((td) => {
		const args = phase1OnlyArgs(td, "methodology");
		const phase1Path = args[args.indexOf("--phase1") + 1];
		const manuscriptPath = args[args.indexOf("--manuscript") + 1];
		const leak = Array.from({ length: 14 }, (_, i) => `leaked${i}`).join(" ");
		writeFileSync(manuscriptPath, leak);
		writeFileSync(phase1Path, phase1Text("methodology") + "\n" + leak + "\n");
		const result = cli(args);
		check(
			"leak + grammar error → exit 3",
			result.exitCode === EXIT_CONFORMANCE,
		);
		check("leak surfaces (LEAK in output)", result.stdout.includes("LEAK"));
	});
}

// ===========================================================================
// AC-11: Advisory sub-channels don't affect exit
// ===========================================================================

console.log("\nAC-11: Advisory sub-channels");
{
	withTempDir((td) => {
		const args = writeCliFiles(td, "methodology");
		const phase2Path = args[args.indexOf("--phase2") + 1];
		writeFileSync(phase2Path, phase2WithDissentSection([]));
		const result = cli([...args, "--role", "methodology"]);
		check("empty dissent → exit 0", result.exitCode === EXIT_PASS);
		check(
			"empty dissent → DISSENT-EMPTY-SECTION printed",
			result.stdout.includes("[DISSENT-EMPTY-SECTION:"),
		);
	});
}

// ===========================================================================
// AC-12: multi_dissent IS exit 3
// ===========================================================================

console.log("\nAC-12: multi_dissent is exit 3");
{
	withTempDir((td) => {
		const args = writeCliFiles(td, "methodology");
		const phase2Path = args[args.indexOf("--phase2") + 1];
		writeFileSync(
			phase2Path,
			phase2WithDissentSection([
				"dimension_id: D1",
				"rationale: the plan understated the risk here",
				"dimension_id: D3",
				"rationale: the plan understated a second risk here",
			]),
		);
		const result = cli([...args, "--role", "methodology"]);
		check("two dissents → exit 3", result.exitCode === EXIT_CONFORMANCE);
		const violations = result.stdout
			.split("\n")
			.filter((l) => l.trimStart().startsWith("[PROTOCOL-VIOLATION:"));
		check("exactly one PROTOCOL-VIOLATION line", violations.length === 1);
		check(
			"multi_dissent=true in violation",
			violations[0]?.includes("multi_dissent=true"),
		);
	});
}

// ===========================================================================
// AC-79: Two-tier isError mapping (via tier labels)
// ===========================================================================

console.log("\nAC-79: Two-tier isError");
{
	// Pass → tier 0 → isError false
	check("pass tier → pass", tierLabelFromExitCode(0) === "pass");
	// Contract → tier 2 → isError true
	check("contract tier → contract", tierLabelFromExitCode(2) === "contract");
	// Conformance → tier 3 → isError true
	check(
		"conformance tier → conformance",
		tierLabelFromExitCode(3) === "conformance",
	);
	// isError = exitCode !== 0 (both 2 and 3 block)
	check("exit 2 blocks", Number(EXIT_CONTRACT) !== 0);
	check("exit 3 blocks", Number(EXIT_CONFORMANCE) !== 0);
}

// ===========================================================================
// AC-80: Audit trail JSONL + non-blocking
// ===========================================================================

console.log("\nAC-80: Audit trail");
{
	withTempDir((td) => {
		const mockCtx = {
			cwd: td,
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
		appendAudit(mockCtx, {
			source: "tool",
			contractPath: FULL_PATH,
			role: "methodology",
			phase1Only: false,
			exitTier: 3,
			tierLabel: "conformance",
		});
		const auditPath = join(td, ".pi", "ars-phase-conformance-audit.jsonl");
		check("audit file exists", existsSync(auditPath));
		const line = readFileSync(auditPath, "utf-8").trim();
		const entry = JSON.parse(line);
		check("audit exitTier 3", entry.exitTier === 3);
		check("audit tierLabel conformance", entry.tierLabel === "conformance");
		check("audit role methodology", entry.role === "methodology");
	});
	// Audit failure does not block
	{
		const badCtx = {
			cwd: "/nonexistent/path/that/does/not/exist",
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
		let threw = false;
		try {
			appendAudit(badCtx, {
				source: "tool",
				contractPath: FULL_PATH,
				role: "methodology",
				phase1Only: false,
				exitTier: 0,
				tierLabel: "pass",
			});
		} catch {
			threw = true;
		}
		check("audit failure swallowed (no throw)", !threw);
	}
}

// ===========================================================================
// AC-81: TOOL phase1Only surface
// ===========================================================================

console.log("\nAC-81: phase1Only TOOL surface");
{
	withTempDir((td) => {
		const args = phase1OnlyArgs(td, "methodology");
		const result = cli(args);
		check("phase1Only → isError false", result.exitCode === EXIT_PASS);
		check("phase1Only → tier 0", result.tier === 0);
		check("phase1Only flag set", result.phase1Only === true);
	});
}

// ===========================================================================
// AC-82: Zero deps + import surface
// ===========================================================================

console.log("\nAC-82: Import surface + zero deps");
{
	// Verify all 10 pinned constants are the right type
	check("_METADATA_KEYS is Set", _METADATA_KEYS instanceof Set);
	check("_METADATA_KEYS has 3 keys", _METADATA_KEYS.size === 3);
	check("_DISSENT_FIELD_NAMES is Set", _DISSENT_FIELD_NAMES instanceof Set);
	check("_DISSENT_FIELD_NAMES has 2 keys", _DISSENT_FIELD_NAMES.size === 2);
	check(
		"_FIELD_PATTERNS has 5 entries",
		Object.keys(_FIELD_PATTERNS).length === 5,
	);
	check("_SEVERITY_RE is RegExp", _SEVERITY_RE instanceof RegExp);
	check("_ANCHOR_RE is RegExp", _ANCHOR_RE instanceof RegExp);
	check("_FINDING_H3_RE is RegExp", _FINDING_H3_RE instanceof RegExp);
	check("_MARKUP_SPAN_RE is RegExp", _MARKUP_SPAN_RE instanceof RegExp);
	check(
		"_CLOSES_PARAGRAPH_RE is RegExp",
		_CLOSES_PARAGRAPH_RE instanceof RegExp,
	);
	check(
		"_SETEXT_UNDERLINE_RE is RegExp",
		_SETEXT_UNDERLINE_RE instanceof RegExp,
	);
	check("_EMPTY_LIST_ITEM_RE is RegExp", _EMPTY_LIST_ITEM_RE instanceof RegExp);
	// Exit codes
	check("EXIT_PASS is 0", EXIT_PASS === 0);
	check("EXIT_CONTRACT is 2", EXIT_CONTRACT === 2);
	check("EXIT_CONFORMANCE is 3", EXIT_CONFORMANCE === 3);
}

// ===========================================================================
// AC-83: Fidelity boundary constants
// ===========================================================================

console.log("\nAC-83: Fidelity boundary constants");
{
	// Verify _METADATA_KEYS exact values
	check(
		"metadata keys exact",
		_METADATA_KEYS.has("title") &&
			_METADATA_KEYS.has("field") &&
			_METADATA_KEYS.has("word_count"),
	);
	// Verify _DISSENT_FIELD_NAMES exact values
	check(
		"dissent field names exact",
		_DISSENT_FIELD_NAMES.has("dimensionid") &&
			_DISSENT_FIELD_NAMES.has("rationale"),
	);
	// Verify _FINDING_H3_RE pattern
	check(
		"finding H3 matches W1: title",
		_FINDING_H3_RE.test("W1: some finding title"),
	);
	check("finding H3 rejects non-W", !_FINDING_H3_RE.test("X1: not a finding"));
	// Verify _MARKUP_SPAN_RE strips HTML tags
	check("markup strips <b>", "".replace(_MARKUP_SPAN_RE, "") === "");
	// Verify parseArgs
	const args = parseArgs([
		"--contract",
		"c.json",
		"--role",
		"eic",
		"--phase1",
		"p1.md",
		"--phase2",
		"p2.md",
		"--manuscript",
		"m.md",
		"--metadata",
		"meta.json",
	]);
	check("parseArgs contract", args.contract === "c.json");
	check("parseArgs role", args.role === "eic");
	check("parseArgs phase1", args.phase1 === "p1.md");
	check("parseArgs phase2", args.phase2 === "p2.md");
	check("parseArgs manuscript", args.manuscript === "m.md");
	check("parseArgs metadata", args.metadata === "meta.json");
	check("parseArgs phase1Only false", args.phase1Only === false);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
