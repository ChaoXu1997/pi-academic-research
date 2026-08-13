// Unit tests for the phase-conformance core logic (slice 4).
// Run via: tsc -p tsconfig.test.json && node .test-build/core/phase-conformance-core.test.js
//
// These tests port the core-logic test groups from the upstream Python oracle
// (upstream/scripts/test_check_phase_conformance.py):
//   * AC-13/14 — metadata envelope shape + value validation
//   * AC-15..28 — Phase 1 plan grammar (sections, terminal ack, H2 sequence,
//     paragraph floor, zero-content blocks, multiline comments, trigger fields,
//     trigger collision, trigger-short advisory, scope, fence hiding)
//   * AC-29..31 — manuscript blindness (12-word shingle, exemptions)
//   * AC-32..38 — trigger binding (drift, required-iff, fatal binds fatal,
//     ambiguity, dissent exemption, cap/committed/known, fatality)
//   * AC-39..43 — dissent grammar/cardinality (late, duplicate, dim_id grammar,
//     empty section diagnostic, empty-still-binds)

import {
	parse_phase1,
	validate_metadata_envelope,
	check_manuscript_leakage,
	check_trigger_binding,
	check_scoring_seat_anchors,
	check_da_anchors,
	type PhaseOnePlan,
} from "./phase-conformance-core.js";
import { parse_report, type ReviewerReport } from "./reviewer-gate-core.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
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

function expectThrows(fn: () => void, fragment: string): boolean {
	try {
		fn();
		return false;
	} catch (exc) {
		return (exc as Error).message.includes(fragment);
	}
}

function expectNoThrow(fn: () => void): boolean {
	try {
		fn();
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Test helpers (ported from upstream)
// ---------------------------------------------------------------------------

function phase1Text(
	role: string,
	overrides: Record<string, Record<string, string | null>> | null = null,
): string {
	const ov = overrides ?? {};
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
		const fields: Record<string, string | null> = {
			dimension_id: did,
			what_to_look_for: `observable evidence relevant to ${did}`,
			what_triggers_block: `block evidence pattern for ${did} requiring major repair`,
			what_triggers_warn: `warn evidence pattern for ${did} requiring clarification`,
		};
		if (dim.priority === "mandatory") {
			fields.what_triggers_fatal = `fatal evidence pattern for ${did} invalidating the core`;
		}
		Object.assign(fields, ov[did] ?? {});
		lines.push(`### ${did}: ${dim.name}`);
		for (const [key, value] of Object.entries(fields)) {
			if (value !== null) lines.push(`${key}: ${value}`);
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
			} else if (value === "abstain") {
				lines.push(
					"score: not_assessed",
					"abstain_reason: materially inapplicable",
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

function parsePlan(
	role = "methodology",
	overrides: Record<string, Record<string, string | null>> | null = null,
): PhaseOnePlan {
	return parse_phase1("p1.md", phase1Text(role, overrides), FULL, role);
}

function parseReport(
	role = "methodology",
	overrides: Record<string, string> | null = null,
	body = "",
	dissent: string[] = [],
): [ReviewerReport, string] {
	const text = phase2Text(role, overrides, body, dissent);
	return [parse_report("p2.md", text, FULL), text];
}

function dimsMap(): Record<string, Record<string, unknown>> {
	const m: Record<string, Record<string, unknown>> = {};
	for (const d of FULL.acceptance_dimensions as Record<string, unknown>[])
		m[d.id as string] = d;
	return m;
}

// ===========================================================================
// AC-13/14: Metadata envelope shape + value validation
// ===========================================================================

console.log("\nAC-13/14: Metadata envelope");
{
	// Extra key rejected
	check(
		"extra key → METADATA-INVALID",
		expectThrows(
			() =>
				validate_metadata_envelope({
					title: "Synthetic",
					field: "testing",
					word_count: 12,
					unexpected_body:
						"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
				}),
			"METADATA-INVALID",
		),
	);
	// Missing key rejected
	check(
		"missing key → METADATA-INVALID",
		expectThrows(
			() =>
				validate_metadata_envelope({ title: "Synthetic", field: "testing" }),
			"METADATA-INVALID",
		),
	);
	// Bool word_count rejected
	check(
		"bool word_count → METADATA-INVALID",
		expectThrows(
			() =>
				validate_metadata_envelope({
					title: "Synthetic",
					field: "testing",
					word_count: true,
				}),
			"METADATA-INVALID",
		),
	);
	// Valid envelope passes
	check(
		"valid envelope → no throw",
		expectNoThrow(() =>
			validate_metadata_envelope({
				title: "Synthetic",
				field: "testing",
				word_count: 3,
			}),
		),
	);
}

// ===========================================================================
// AC-15: Paraphrase section required
// ===========================================================================

console.log("\nAC-15: Paraphrase section required");
{
	const text = phase1Text("methodology").replace(
		/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
		"",
	);
	check(
		"no paraphrase → error",
		expectThrows(
			() => parse_phase1("p1.md", text, FULL, "methodology"),
			"Contract Paraphrase",
		),
	);
}

// ===========================================================================
// AC-16: Scoring Plan section + duplicate subsection
// ===========================================================================

console.log("\nAC-16: Scoring Plan section + duplicate");
{
	const text = phase1Text("methodology").replace(
		"\n[CONTRACT-ACKNOWLEDGED]",
		"\n### D3: argumentative_coherence\n[CONTRACT-ACKNOWLEDGED]",
	);
	check(
		"duplicate subsection → error",
		expectThrows(
			() => parse_phase1("p1.md", text, FULL, "methodology"),
			"duplicate scoring-plan subsection: D3: argumentative_coherence",
		),
	);
}

// ===========================================================================
// AC-17: Terminal acknowledgement
// ===========================================================================

console.log("\nAC-17: Terminal acknowledgement");
{
	const text =
		phase1Text("methodology").replace("[CONTRACT-ACKNOWLEDGED]", "").trimEnd() +
		"\n";
	check(
		"no ack → error",
		expectThrows(
			() => parse_phase1("p1.md", text, FULL, "methodology"),
			"CONTRACT-ACKNOWLEDGED",
		),
	);
}

// ===========================================================================
// AC-18: Exact H2 sequence
// ===========================================================================

console.log("\nAC-18: Exact H2 sequence");
{
	const good = phase1Text("methodology");
	// Reordered
	let reordered = good.replace("## Contract Paraphrase", "## ZZZ");
	reordered = reordered.replace("## Scoring Plan", "## Contract Paraphrase");
	reordered = reordered.replace("## ZZZ", "## Scoring Plan");
	check(
		"reordered → error",
		expectThrows(
			() => parse_phase1("p1.md", reordered, FULL, "methodology"),
			"H2 sections",
		),
	);
	// Extra section
	const extra = good.replace(
		"## Scoring Plan",
		"## Reviewer Notes\n\nan extra section\n\n## Scoring Plan",
	);
	check(
		"extra H2 → error",
		expectThrows(
			() => parse_phase1("p1.md", extra, FULL, "methodology"),
			"H2 sections",
		),
	);
}

// ===========================================================================
// AC-19: Paraphrase paragraph floor
// ===========================================================================

console.log("\nAC-19: Paraphrase paragraph floor");
{
	const text = phase1Text("methodology").replace(
		/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
		"## Contract Paraphrase\n\nAll dimensions understood.\n\n",
	);
	check(
		"one-line paraphrase → fewer than",
		expectThrows(
			() => parse_phase1("p1.md", text, FULL, "methodology"),
			"fewer than",
		),
	);
}

// ===========================================================================
// AC-20: Zero-content blocks don't count toward floor
// ===========================================================================

console.log("\nAC-20: Zero-content blocks");
{
	for (const filler of ["---", "- - -", "***", "<!-- noted -->"]) {
		const dims = FULL.acceptance_dimensions as Record<string, unknown>[];
		const blocks = Array(dims.length).fill(filler).join("\n\n");
		const text = phase1Text("methodology").replace(
			/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
			`## Contract Paraphrase\n\n${blocks}\n\n`,
		);
		check(
			`zero-content ${JSON.stringify(filler)} → fewer than`,
			expectThrows(
				() => parse_phase1("p1.md", text, FULL, "methodology"),
				"fewer than",
			),
		);
	}
	// Heading-only paraphrase
	{
		const dims = FULL.acceptance_dimensions as Record<string, unknown>[];
		const headings = dims.map((d) => `### ${d.id}`).join("\n\n");
		const text = phase1Text("methodology").replace(
			/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
			`## Contract Paraphrase\n\n${headings}\n\n`,
		);
		check(
			"heading-only → fewer than",
			expectThrows(
				() => parse_phase1("p1.md", text, FULL, "methodology"),
				"fewer than",
			),
		);
	}
	// Lone list markers
	for (const marker of ["-", "*", "+"]) {
		const dims = FULL.acceptance_dimensions as Record<string, unknown>[];
		const blocks = Array(dims.length).fill(marker).join("\n\n");
		const text = phase1Text("methodology").replace(
			/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
			`## Contract Paraphrase\n\n${blocks}\n\n`,
		);
		check(
			`lone marker ${marker} → fewer than`,
			expectThrows(
				() => parse_phase1("p1.md", text, FULL, "methodology"),
				"fewer than",
			),
		);
	}
}

// ===========================================================================
// AC-21: Multi-line HTML comments don't count
// ===========================================================================

console.log("\nAC-21: Multi-line HTML comments");
{
	const dims = FULL.acceptance_dimensions as Record<string, unknown>[];
	const block = "<!--\nhidden not-a-paraphrase\n-->";
	const blocks = Array(dims.length).fill(block).join("\n\n");
	const text = phase1Text("methodology").replace(
		/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
		`## Contract Paraphrase\n\n${blocks}\n\n`,
	);
	check(
		"multi-line comments → fewer than",
		expectThrows(
			() => parse_phase1("p1.md", text, FULL, "methodology"),
			"fewer than",
		),
	);
	// Prose mentioning comment opener still counts
	{
		const body = dims
			.map(
				(d) =>
					`${d.id} concerns ${d.name}; authors sometimes hide text with <!-- markers --> in drafts.`,
			)
			.join("\n\n");
		const text2 = phase1Text("methodology").replace(
			/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
			`## Contract Paraphrase\n\n${body}\n\n`,
		);
		check(
			"prose mentioning opener → passes",
			expectNoThrow(() => parse_phase1("p1.md", text2, FULL, "methodology")),
		);
	}
}

// ===========================================================================
// AC-22: Bulleted paraphrase counts; headings separate paragraphs
// ===========================================================================

console.log("\nAC-22: Bulleted paraphrase + heading separation");
{
	const dims = FULL.acceptance_dimensions as Record<string, unknown>[];
	// Bulleted paraphrase
	{
		const bullets = dims
			.map((d) => `- ${d.id} concerns ${d.name} as the contract defines it.`)
			.join("\n\n");
		const text = phase1Text("methodology").replace(
			/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
			`## Contract Paraphrase\n\n${bullets}\n\n`,
		);
		check(
			"bulleted paraphrase → passes",
			expectNoThrow(() => parse_phase1("p1.md", text, FULL, "methodology")),
		);
	}
	// Heading + prose counts
	{
		const body = dims
			.map(
				(d) =>
					`### ${d.id}\n${d.id} concerns ${d.name} as the contract defines it.`,
			)
			.join("\n\n");
		const text = phase1Text("methodology").replace(
			/## Contract Paraphrase[\s\S]*?(?=## Scoring Plan)/,
			`## Contract Paraphrase\n\n${body}\n\n`,
		);
		check(
			"heading + prose → passes",
			expectNoThrow(() => parse_phase1("p1.md", text, FULL, "methodology")),
		);
	}
}

// ===========================================================================
// AC-23: Canonical trigger fields
// ===========================================================================

console.log("\nAC-23: Canonical trigger fields");
{
	check(
		"missing fatal trigger → error",
		expectThrows(
			() => parsePlan("methodology", { D1: { what_triggers_fatal: null } }),
			"what_triggers_fatal: line for dimension D1, found 0",
		),
	);
	// Noncanonical line forms
	for (const [label, mutation] of [
		[
			"bulleted",
			(t: string) =>
				t.replace("what_triggers_fatal:", "- what_triggers_fatal:"),
		],
		[
			"em-dash",
			(t: string) =>
				t.replace("what_triggers_fatal:", "what_triggers_fatal \u2014"),
		],
	] as Array<[string, (t: string) => string]>) {
		const text = mutation(phase1Text("methodology"));
		check(
			`noncanonical ${label} → PHASE1-GRAMMAR`,
			expectThrows(
				() => parse_phase1("p1.md", text, FULL, "methodology"),
				"PHASE1-GRAMMAR",
			),
		);
	}
	// Canonical passes
	check(
		"canonical form → passes",
		expectNoThrow(() => parsePlan()),
	);
}

// ===========================================================================
// AC-24: Fatal trigger on non-mandatory dimension forbidden
// ===========================================================================

console.log("\nAC-24: Fatal trigger on non-mandatory");
{
	const text = phase1Text("eic").replace(
		"what_triggers_warn: warn evidence pattern for D5 requiring clarification",
		"what_triggers_warn: warn evidence pattern for D5 requiring clarification\nwhat_triggers_fatal: forbidden fatal trigger",
	);
	check(
		"fatal on non-mandatory → forbidden",
		expectThrows(() => parse_phase1("p1.md", text, FULL, "eic"), "forbidden"),
	);
}

// ===========================================================================
// AC-25: Trigger collision (pairwise distinct)
// ===========================================================================

console.log("\nAC-25: Trigger collision");
{
	for (const [a, b] of [
		["what_triggers_warn", "what_triggers_block"],
		["what_triggers_fatal", "what_triggers_block"],
		["what_triggers_fatal", "what_triggers_warn"],
	] as Array<[string, string]>) {
		const ov: Record<string, Record<string, string>> = { D1: {} };
		ov.D1[a] = "same";
		ov.D1[b] = "same";
		check(
			`collision ${a}=${b} → TRIGGER-COLLISION`,
			expectThrows(() => parsePlan("methodology", ov), "TRIGGER-COLLISION"),
		);
	}
	// Pairwise distinct passes
	{
		const plan = parsePlan();
		check(
			"pairwise distinct → D1+D3",
			Object.keys(plan.commitments).length === 2 &&
				"D1" in plan.commitments &&
				"D3" in plan.commitments,
		);
	}
}

// ===========================================================================
// AC-26: Trigger-short is advisory
// ===========================================================================

console.log("\nAC-26: Trigger-short advisory");
{
	const plan = parsePlan("methodology", {
		D1: { what_triggers_warn: "short warning trigger" },
	});
	check(
		"short trigger → warning",
		plan.warnings.some((w) =>
			w.includes("D1 what_triggers_warn has fewer than 8 words"),
		),
	);
}

// ===========================================================================
// AC-27: Eligible-dimension scope exact match
// ===========================================================================

console.log("\nAC-27: Eligible scope");
{
	const plan = parsePlan();
	const keys = new Set(Object.keys(plan.commitments));
	check(
		"scope == {D1, D3}",
		keys.size === 2 && keys.has("D1") && keys.has("D3"),
	);
}

// ===========================================================================
// AC-28: Fence/unicode hiding
// ===========================================================================

console.log("\nAC-28: Fence/unicode hiding");
{
	const text = "```text\n```not-a-close\n" + phase1Text("eic") + "\n```\n";
	check(
		"malformed fence closer → Scoring Plan required",
		expectThrows(
			() => parse_phase1("p1.md", text, FULL, "eic"),
			"Scoring Plan required",
		),
	);
	for (const sep of ["\x85", "\u2028", "\u2029"]) {
		const text2 = "```text\n```" + sep + phase1Text("eic") + "\n```\n";
		check(
			`unicode separator ${JSON.stringify(sep)} → Scoring Plan required`,
			expectThrows(
				() => parse_phase1("p1.md", text2, FULL, "eic"),
				"Scoring Plan required",
			),
		);
	}
}

// ===========================================================================
// AC-29: 12-word shingle detection
// ===========================================================================

console.log("\nAC-29: Manuscript 12-word shingle");
{
	const manuscript =
		"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
	const leaked =
		phase1Text("methodology") +
		"\nalpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
	check(
		"12-word shingle → MANUSCRIPT-LEAK",
		expectThrows(
			() =>
				check_manuscript_leakage(
					leaked,
					manuscript,
					{ title: "Synthetic", field: "testing", word_count: 14 },
					FULL,
				),
			"MANUSCRIPT-LEAK",
		),
	);
}

// ===========================================================================
// AC-30: Metadata title exemption
// ===========================================================================

console.log("\nAC-30: Metadata title exemption");
{
	const title =
		"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
	check(
		"title shingle exempt → no throw",
		expectNoThrow(() =>
			check_manuscript_leakage(
				phase1Text("methodology") + "\n" + title,
				title + "\nBody words begin here.",
				{ title, field: "testing", word_count: 4 },
				FULL,
			),
		),
	);
}

// ===========================================================================
// AC-31: Contract JSON exemption
// ===========================================================================

console.log("\nAC-31: Contract JSON exemption");
{
	// D5's description is exactly 12 words — use it as the shingle
	const d5 = (FULL.acceptance_dimensions as Record<string, unknown>[]).find(
		(d) => d.id === "D5",
	)!;
	const desc = d5.description as string; // 12 words
	const manuscript = desc + " extra body text here.";
	const phase1 = phase1Text("methodology") + "\n" + desc;
	check(
		"contract description shingle exempt → no throw",
		expectNoThrow(() =>
			check_manuscript_leakage(
				phase1,
				manuscript,
				{ title: "Synthetic", field: "testing", word_count: 3 },
				FULL,
			),
		),
	);
}

// ===========================================================================
// AC-32: Trigger drift
// ===========================================================================

console.log("\nAC-32: Trigger drift");
{
	const [report] = parseReport("methodology", { D1: "warn" });
	report.scores["D1"] = {
		score: "warn",
		block_class: null,
		trigger: "a completely new threshold",
		abstain_reason: null,
	};
	check(
		"trigger drift → TRIGGER-DRIFT",
		expectThrows(
			() => check_trigger_binding(report, parsePlan(), dimsMap(), new Set()),
			"TRIGGER-DRIFT",
		),
	);
}

// ===========================================================================
// AC-33: Trigger required iff defense-in-depth
// ===========================================================================

console.log("\nAC-33: Trigger required-iff recheck");
{
	// Warn without trigger
	{
		const [report] = parseReport("methodology", { D1: "warn" });
		report.scores["D1"] = {
			score: "warn",
			block_class: null,
			trigger: null,
			abstain_reason: null,
		};
		check(
			"warn without trigger → TRIGGER-GRAMMAR",
			expectThrows(
				() => check_trigger_binding(report, parsePlan(), dimsMap(), new Set()),
				"TRIGGER-GRAMMAR",
			),
		);
	}
	// Pass with surplus trigger
	{
		const [report] = parseReport("methodology");
		report.scores["D1"] = {
			score: "pass",
			block_class: null,
			trigger: "surplus post hoc trigger",
			abstain_reason: null,
		};
		check(
			"pass with trigger → TRIGGER-GRAMMAR",
			expectThrows(
				() => check_trigger_binding(report, parsePlan(), dimsMap(), new Set()),
				"TRIGGER-GRAMMAR",
			),
		);
	}
	// EIC not_assessed with surplus trigger
	{
		const [report] = parseReport("eic");
		report.scores["D1"] = {
			score: "not_assessed",
			block_class: null,
			trigger: "surplus structural trigger",
			abstain_reason: null,
		};
		check(
			"not_assessed with trigger → TRIGGER-GRAMMAR",
			expectThrows(
				() =>
					check_trigger_binding(report, parsePlan("eic"), dimsMap(), new Set()),
				"TRIGGER-GRAMMAR",
			),
		);
	}
}

// ===========================================================================
// AC-34: Fatal block binds to fatal, not warn
// ===========================================================================

console.log("\nAC-34: Fatal block binds fatal");
{
	const [report] = parseReport("methodology", { D1: "fatal" });
	report.scores["D1"] = {
		score: "block",
		block_class: "fatal",
		trigger: "warn evidence pattern for D1",
		abstain_reason: null,
	};
	check(
		"fatal with warn trigger → TRIGGER-DRIFT",
		expectThrows(
			() => check_trigger_binding(report, parsePlan(), dimsMap(), new Set()),
			"TRIGGER-DRIFT",
		),
	);
}

// ===========================================================================
// AC-35: Trigger must match exactly ONE field kind
// ===========================================================================

console.log("\nAC-35: Trigger ambiguity");
{
	const shared = "shared evidence pattern appears";
	for (const [score, sharedFields] of [
		["fatal", ["what_triggers_block", "what_triggers_fatal"]],
		["block", ["what_triggers_block", "what_triggers_warn"]],
		["warn", ["what_triggers_warn", "what_triggers_fatal"]],
	] as Array<[string, string[]]>) {
		const overrides: Record<string, Record<string, string>> = {
			D1: {
				what_triggers_block:
					"repairable evidence pattern requires bounded revision",
				what_triggers_warn:
					"warning evidence pattern requires clarification only",
				what_triggers_fatal:
					"fatal evidence pattern proves the core cannot recover",
			},
		};
		for (const field of sharedFields) {
			overrides.D1[field] = `${shared} and then diverges for ${field}`;
		}
		const plan = parsePlan("methodology", overrides);
		const [report] = parseReport("methodology", { D1: score });
		report.scores["D1"] = {
			score: score === "warn" ? "warn" : "block",
			block_class:
				score === "fatal" ? "fatal" : score === "block" ? "repairable" : null,
			trigger: shared,
			abstain_reason: null,
		};
		check(
			`ambiguity ${score} → TRIGGER-AMBIGUOUS`,
			expectThrows(
				() => check_trigger_binding(report, plan, dimsMap(), new Set()),
				"TRIGGER-AMBIGUOUS",
			),
		);
	}
}

// ===========================================================================
// AC-36: Dissent exempts trigger binding
// ===========================================================================

console.log("\nAC-36: Dissent exemption");
{
	const [report] = parseReport("methodology", { D1: "block" }, "", ["D1"]);
	check(
		"dissent repairable block → no throw",
		expectNoThrow(() =>
			check_trigger_binding(report, parsePlan(), dimsMap(), new Set(["D1"])),
		),
	);
}

// ===========================================================================
// AC-37: Dissent cap, committed, known
// ===========================================================================

console.log("\nAC-37: Dissent cap/committed/known");
{
	// Two dissent dimensions
	{
		const [report] = parseReport("methodology", {}, "", ["D1", "D3"]);
		check(
			"two dissents → multi_dissent",
			expectThrows(
				() =>
					check_trigger_binding(
						report,
						parsePlan(),
						dimsMap(),
						new Set(["D1", "D3"]),
					),
				"multi_dissent",
			),
		);
	}
	// Uncommitted dimension
	{
		const [report] = parseReport("methodology", {}, "", ["D2"]);
		check(
			"uncommitted dissent → not committed",
			expectThrows(
				() =>
					check_trigger_binding(
						report,
						parsePlan(),
						dimsMap(),
						new Set(["D2"]),
					),
				"not committed by this seat",
			),
		);
	}
}

// ===========================================================================
// AC-38: Dissent cannot mint fatality
// ===========================================================================

console.log("\nAC-38: Dissent fatality");
{
	const [report] = parseReport("methodology", { D1: "fatal" }, "", ["D1"]);
	check(
		"dissent fatal → DISSENT-FATALITY",
		expectThrows(
			() =>
				check_trigger_binding(report, parsePlan(), dimsMap(), new Set(["D1"])),
			"DISSENT-FATALITY",
		),
	);
}

// ===========================================================================
// AC-65/66: Scoring-seat anchor failures + compliant pass
// ===========================================================================

console.log("\nAC-65/66: Scoring-seat anchors");
{
	const failBodies = [
		"### W1: no anchor\n**Severity**: Critical\n**Problem**: no anchor",
		'### W1: long quote\n**Severity**: Major\n**Evidence Anchor**: text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix"',
		"### W1: empty absence\n**Severity**: Critical\n**Evidence Anchor**: absence:",
		"### W1: incomplete absence\n**Severity**: Critical\n**Evidence Anchor**: absence: x",
		"### W1: missing expected item\n**Severity**: Critical\n**Evidence Anchor**: absence: Methods \u2014 expected ; checked appendix",
		"### W1: missing checked surfaces\n**Severity**: Critical\n**Evidence Anchor**: absence: Methods \u2014 expected ethics statement; checked",
		"### W1: missing separator space\n**Severity**: Critical\n**Evidence Anchor**: absence: Methods \u2014 expected ethics statement;checked appendix",
		"### W1: doubled separator space\n**Severity**: Critical\n**Evidence Anchor**: absence: Methods \u2014 expected ethics statement;  checked appendix",
		"### W1: repeated separators\n**Severity**: Critical\n**Evidence Anchor**: absence: Methods \u2014 expected ; checked appendix \u2014 expected ethics statement; checked supplement",
		"### W1: reversed separators\n**Severity**: Critical\n**Evidence Anchor**: absence: Methods; checked appendix \u2014 expected ethics statement",
	];
	for (const body of failBodies) {
		const [report] = parseReport("eic", null, body);
		check(
			`anchor fail ${body.slice(0, 30)}... → error`,
			expectThrows(() => check_scoring_seat_anchors(report), ""),
		);
	}
	// Compliant pass
	const passBodies = [
		'### W1: quoted defect\n**Severity**: Critical\n**Evidence Anchor**: text: "short exact quote" p. 2',
		"### W1: missing surfaces\n**Severity**: Major\n**Evidence Anchor**: absence: Methods \u2014 expected an ethics statement; checked Methods, appendix, and supplement",
	];
	for (const body of passBodies) {
		const [report] = parseReport("eic", null, body);
		check(
			`compliant ${body.slice(0, 30)}... → passes`,
			expectNoThrow(() => check_scoring_seat_anchors(report)),
		);
	}
	// Two independently anchored findings pass
	{
		const body =
			'### W1: first\n**Severity**: Critical\n**Evidence Anchor**: text: "first quote" p. 1\n### W2: second\n**Severity**: Major\n**Evidence Anchor**: absence: Methods \u2014 expected an ethics statement; checked Methods and appendix';
		const [report] = parseReport("eic", null, body);
		check(
			"two findings pass → no throw",
			expectNoThrow(() => check_scoring_seat_anchors(report)),
		);
	}
}

// ===========================================================================
// AC-67: Severity uniqueness
// ===========================================================================

console.log("\nAC-67: Severity uniqueness");
{
	// Multiple minor severities in one finding
	{
		const body =
			"### W1: bundled\n**Severity**: Minor\nfirst\n**Severity**: Minor\nsecond";
		const [report] = parseReport("eic", null, body);
		check(
			"multiple minors → FINDING-GRAMMAR",
			expectThrows(() => check_scoring_seat_anchors(report), "FINDING-GRAMMAR"),
		);
	}
	// Same-line duplicate severity
	{
		const body =
			"### W1: hidden\n**Severity**: Minor and **Severity**: Critical";
		const [report] = parseReport("eic", null, body);
		check(
			"same-line dup severity → FINDING-GRAMMAR",
			expectThrows(() => check_scoring_seat_anchors(report), "FINDING-GRAMMAR"),
		);
	}
	// Two findings share one anchor
	{
		const body =
			'### W1: first\n**Severity**: Critical\n**Evidence Anchor**: text: "first quote" p. 1\n**Severity**: Major\n### W2: second\n**Severity**: Major';
		const [report] = parseReport("eic", null, body);
		check(
			"two findings share anchor → error",
			expectThrows(() => check_scoring_seat_anchors(report), ""),
		);
	}
}

// ===========================================================================
// AC-68: Finding heading grammar
// ===========================================================================

console.log("\nAC-68: Finding heading grammar");
{
	// Noncanonical heading + label
	{
		const body = "### Weakness 1: fabricated\n**Severity:** Critical";
		const [report] = parseReport("eic", null, body);
		check(
			"noncanonical heading → FINDING-GRAMMAR",
			expectThrows(() => check_scoring_seat_anchors(report), "FINDING-GRAMMAR"),
		);
	}
	// H4 under generic H3
	{
		const body =
			'### Commentary\n#### W1: hidden\n**Severity**: Critical\n**Evidence Anchor**: text: "quote" p. 1';
		const [report] = parseReport("eic", null, body);
		check(
			"H4 under generic H3 → own ### W<n>",
			expectThrows(() => check_scoring_seat_anchors(report), "own ### W<n>"),
		);
	}
	// Severity outside Review Body
	{
		const [report, text] = parseReport("eic");
		const report2 = {
			...report,
			text:
				text +
				'\n## Appendix\n### W1: misplaced\n**Severity**: Critical\n**Evidence Anchor**: text: "quote" p. 1',
		};
		check(
			"severity outside → outside",
			expectThrows(() => check_scoring_seat_anchors(report2), "outside"),
		);
	}
	// Flat severity without heading
	{
		const [report] = parseReport(
			"eic",
			null,
			'**Severity**: Critical\n**Evidence Anchor**: text: "quote" p. 1',
		);
		check(
			"flat severity → own ### finding",
			expectThrows(() => check_scoring_seat_anchors(report), "own ### finding"),
		);
	}
	// Case variant severity
	for (const label of ["severity", "sEvErItY"]) {
		const [report] = parseReport(
			"eic",
			null,
			`Commentary line with **${label}**: Critical`,
		);
		check(
			`case variant ${label} → own ### finding`,
			expectThrows(() => check_scoring_seat_anchors(report), "own ### finding"),
		);
	}
	// Case variant anchor declaration
	for (const label of ["evidence anchor", "eViDeNcE aNcHoR"]) {
		const [report] = parseReport(
			"eic",
			null,
			`### W1: malformed\n**Severity**: Minor\n**${label}**: text: "quote"`,
		);
		check(
			`case variant anchor ${label} → FINDING-GRAMMAR`,
			expectThrows(() => check_scoring_seat_anchors(report), "FINDING-GRAMMAR"),
		);
	}
	// Missing Review Body
	{
		const [report] = parseReport("eic");
		const report2 = {
			...report,
			text: report.text.replace("## Review Body", "## Commentary"),
		};
		check(
			"missing Review Body → REVIEW-BODY-MISSING",
			expectThrows(
				() => check_scoring_seat_anchors(report2),
				"REVIEW-BODY-MISSING",
			),
		);
	}
}

// ===========================================================================
// AC-69: Wrapped template anchors normalized and accepted
// ===========================================================================

console.log("\nAC-69: Wrapped template anchors");
{
	const anchors = [
		'`text: \u00a75 "short exact quote"`',
		'[`text: \u00a75 "short exact quote"`]',
		'[text: \u00a75 "short exact quote"]',
		"text: \u00a75 \u201cshort exact quote\u201d",
		"equation: Eq. [3]",
		"[equation: Eq. [3]]",
		'text: \u00a75 "short exact quote" per `df`',
		'`text: \u00a75 "short exact quote" per `df``',
		"text: \u00a72 \u201cthe term \u201cquality culture\u201d is undefined\u201d",
		'text: \u00a72 "he said \u201cquality culture\u201d often"',
	];
	for (const anchor of anchors) {
		const body = `### W1: template\n**Severity**: Critical\n**Evidence Anchor**: ${anchor}`;
		const [report] = parseReport("eic", null, body);
		check(
			`wrapped ${anchor.slice(0, 30)}... → passes`,
			expectNoThrow(() => check_scoring_seat_anchors(report)),
		);
	}
	// Combined template fields
	{
		const body =
			"### W1: combined\n  - **Severity**: Major | **Evidence Anchor**: `absence: Methods \u2014 expected an ethics statement; checked Methods and appendix` | **Confidence**: 4";
		const [report] = parseReport("eic", null, body);
		check(
			"combined template → passes",
			expectNoThrow(() => check_scoring_seat_anchors(report)),
		);
	}
}

// ===========================================================================
// AC-70: Unpaired/repeated/hybrid wrappers rejected
// ===========================================================================

console.log("\nAC-70: Unpaired/repeated/hybrid rejected");
{
	const unpaired = [
		'`text: \u00a75 "short exact quote"',
		'text: \u00a75 "short exact quote"`',
		'[text: \u00a75 "short exact quote"',
		'text: \u00a75 "short exact quote"]',
		'text: \u00a75 "short exact quote"`]',
		'[text: \u00a75 "short exact quote"] trailing]',
		'[ text: \u00a75 "short exact quote" ]',
		'[[text: \u00a75 "short exact quote"]]',
		'``text: \u00a75 "short exact quote"``',
		'` text: \u00a75 "short exact quote" `',
		'[`text: \u00a75 "short exact quote"]',
		'[text: \u00a75 "short exact quote"`]',
		"equation: Eq. ]3[",
	];
	for (const anchor of unpaired) {
		const body = `### W1: malformed\n**Severity**: Critical\n**Evidence Anchor**: ${anchor}`;
		const [report] = parseReport("eic", null, body);
		check(
			`unpaired ${anchor.slice(0, 30)}... → ANCHOR-INVALID`,
			expectThrows(() => check_scoring_seat_anchors(report), "ANCHOR-INVALID"),
		);
	}
	// Hybrid double-quote pairs
	const hybrids = [
		'text: \u00a75 "short exact quote\u201d',
		'text: \u00a75 \u201cshort exact quote"',
		'text: \u00a75 "outer \u201cinner"',
		'text: \u00a75 \u201couter "inner\u201d"',
	];
	for (const anchor of hybrids) {
		const body = `### W1: mismatched\n**Severity**: Critical\n**Evidence Anchor**: ${anchor}`;
		const [report] = parseReport("eic", null, body);
		check(
			`hybrid ${anchor.slice(0, 30)}... → ANCHOR-INVALID`,
			expectThrows(() => check_scoring_seat_anchors(report), "ANCHOR-INVALID"),
		);
	}
	// Type-only wrapping
	for (const anchor of [
		'[`text`: \u00a75 "short exact quote"]',
		'`text` \u2014 \u00a75 "short exact quote"',
	]) {
		const body = `### W1: type wrapping\n**Severity**: Critical\n**Evidence Anchor**: ${anchor}`;
		const [report] = parseReport("eic", null, body);
		check(
			`type-only ${anchor.slice(0, 30)}... → ANCHOR-INVALID`,
			expectThrows(() => check_scoring_seat_anchors(report), "ANCHOR-INVALID"),
		);
	}
	// Same-line duplicate anchor declarations
	{
		const body =
			'### W1: dup\n**Severity**: Critical\n**Evidence Anchor**: text: "first" and **Evidence Anchor**: text: "second"';
		const [report] = parseReport("eic", null, body);
		check(
			"dup anchors → ANCHOR-MISSING",
			expectThrows(() => check_scoring_seat_anchors(report), "ANCHOR-MISSING"),
		);
	}
	// Same-line duplicate minor anchors
	{
		const body =
			'### W1: dup minor\n**Severity**: Minor\n**Evidence Anchor**: text: "first" and **Evidence Anchor**: text: "second"';
		const [report] = parseReport("eic", null, body);
		check(
			"dup minor anchors → FINDING-GRAMMAR",
			expectThrows(() => check_scoring_seat_anchors(report), "FINDING-GRAMMAR"),
		);
	}
	// Malformed minor anchor
	{
		const body =
			'### W1: malformed minor\n**Severity**: Minor\n**Evidence Anchor:** text: "quote"';
		const [report] = parseReport("eic", null, body);
		check(
			"malformed minor → FINDING-GRAMMAR",
			expectThrows(() => check_scoring_seat_anchors(report), "FINDING-GRAMMAR"),
		);
	}
	// Indented bullet fields still enforce
	{
		const body =
			"### W1: indented\n      - **Severity**: Critical\n      - **Confidence**: 5";
		const [report] = parseReport("eic", null, body);
		check(
			"indented bullet → ANCHOR-MISSING",
			expectThrows(() => check_scoring_seat_anchors(report), "ANCHOR-MISSING"),
		);
	}
}

// ===========================================================================
// AC-71: Minor findings
// ===========================================================================

console.log("\nAC-71: Minor findings");
{
	// Minor with one valid anchor passes
	{
		const body =
			'### W1: minor\n**Severity**: Minor\n**Evidence Anchor**: text: "quote" p. 1';
		const [report] = parseReport("eic", null, body);
		check(
			"minor with anchor → passes",
			expectNoThrow(() => check_scoring_seat_anchors(report)),
		);
	}
	// Minor with no anchor passes
	{
		const body = "### W1: minor\n**Severity**: Minor\nsome observation";
		const [report] = parseReport("eic", null, body);
		check(
			"minor no anchor → passes",
			expectNoThrow(() => check_scoring_seat_anchors(report)),
		);
	}
}

// ===========================================================================
// AC-72..78: DA anchors
// ===========================================================================

function daText(
	ids: string[] = ["C1"],
	anchors: Record<string, string> | null = null,
	majorRows: string[] = [],
): string {
	const anchorMap =
		anchors ?? Object.fromEntries(ids.map((id) => [id, 'text: "quote" p. 1']));
	const rows = ids
		.map((id) => `| ${id} | Issue | ${anchorMap[id] ?? ""} |`)
		.join("\n");
	return phase2Text(
		"da",
		null,
		"#### CRITICAL\n| # | Issue | Evidence Anchor |\n|---|-------|-----------------|\n" +
			rows +
			"\n\n" +
			"#### MAJOR\n| # | Issue | Evidence Anchor |\n|---|-------|-----------------|\n" +
			majorRows.join("\n"),
	);
}

console.log("\nAC-72: DA empty anchor + dense IDs");
{
	// Empty critical anchor
	{
		const report = parse_report("da.md", daText(undefined, { C1: "" }), FULL);
		check(
			"empty critical anchor → ANCHOR-MISSING",
			expectThrows(() => check_da_anchors(report), "ANCHOR-MISSING"),
		);
	}
	// IDs must be dense
	{
		const report = parse_report("da.md", daText(["C2"]), FULL);
		check(
			"non-dense IDs → dense",
			expectThrows(() => check_da_anchors(report), "dense"),
		);
	}
	// Conforming table passes
	{
		const report = parse_report("da.md", daText(["C1", "C2"]), FULL);
		check(
			"conforming table → passes",
			expectNoThrow(() => check_da_anchors(report)),
		);
	}
}

console.log("\nAC-73: DA header/ID/separator gates");
{
	for (const [old, newV, fragment] of [
		[
			"| # | Issue | Evidence Anchor |",
			"| # | # | Evidence Anchor |",
			"exactly one #",
		],
		[
			"| # | Issue | Evidence Anchor |",
			"| # | Evidence Anchor | Evidence Anchor |",
			"exactly one #",
		],
		[
			"| # | Issue | Evidence Anchor |",
			"| ID | Issue | Anchor |",
			"missing table header",
		],
		["| C2 | Issue |", "| C1 | Issue |", "duplicate CRITICAL ID"],
		["| C2 | Issue |", "| X2 | Issue |", "invalid CRITICAL ID"],
	] as Array<[string, string, string]>) {
		const report = parse_report(
			"da.md",
			daText(["C1", "C2"]).replace(old, newV),
			FULL,
		);
		check(
			`gate ${fragment} → error`,
			expectThrows(() => check_da_anchors(report), fragment),
		);
	}
	// Separator drift
	for (const [old, newV] of [
		["|---|-------|-----------------|", ""],
		["|---|-------|-----------------|", "|--|-------|-----------------|"],
	] as Array<[string, string]>) {
		const report = parse_report("da.md", daText().replace(old, newV), FULL);
		check(
			"separator drift → separator",
			expectThrows(() => check_da_anchors(report), "separator"),
		);
	}
	// Row without outer pipes
	{
		const report = parse_report(
			"da.md",
			daText().replace(
				'| C1 | Issue | text: "quote" p. 1 |',
				'C1 | Issue | text: "quote" p. 1',
			),
			FULL,
		);
		check(
			"no outer pipes → outer-pipe",
			expectThrows(() => check_da_anchors(report), "outer-pipe"),
		);
	}
}

console.log("\nAC-74: DA shadow/extra/disguised/raw-HTML");
{
	// Shadow table
	{
		const canonical =
			'| # | Issue | Evidence Anchor |\n|---|-------|-----------------|\n| C1 | Issue | text: "quote" p. 1 |';
		const shadowed =
			'| ID | Issue | Anchor |\n|---|-------|--------|\n| C1 | Issue | text: "quoted evidence" p. 1 |\n\n| # | Issue | Evidence Anchor |\n|---|-------|-----------------|';
		const report = parse_report(
			"da.md",
			daText(["C1"]).replace(canonical, shadowed),
			FULL,
		);
		check(
			"shadow table → first nonblank",
			expectThrows(() => check_da_anchors(report), "first nonblank line"),
		);
	}
	// Standalone critical
	{
		const text = daText().replace(
			"#### CRITICAL",
			"### Further adversarial challenge\n- **Severity**: Critical | **Confidence**: 5\n\n#### CRITICAL",
		);
		const report = parse_report("da.md", text, FULL);
		check(
			"standalone Severity → standalone Severity",
			expectThrows(() => check_da_anchors(report), "standalone Severity"),
		);
	}
	// Case variant standalone critical
	for (const label of ["severity", "sEvErItY"]) {
		const text = daText().replace(
			"#### CRITICAL",
			`### Further\nThis is **${label}**: Critical.\n\n#### CRITICAL`,
		);
		const report = parse_report("da.md", text, FULL);
		check(
			`case variant standalone ${label}`,
			expectThrows(() => check_da_anchors(report), "standalone Severity"),
		);
	}
	// Extra issue-table band
	{
		const text = daText().replace(
			"#### MAJOR",
			'#### ADDITIONAL CRITICAL FINDINGS\n| # | Issue | Evidence Anchor |\n|---|-------|-----------------|\n| C1 | impossible | text: "n=41" p. 4 |\n\n#### MAJOR',
		);
		const report = parse_report("da.md", text, FULL);
		check(
			"extra band → unexpected issue-table",
			expectThrows(() => check_da_anchors(report), "unexpected issue-table"),
		);
	}
	// Raw HTML issue table
	{
		const text = daText().replace(
			"#### MAJOR",
			"#### ADDITIONAL\n<table><tr><th>ID</th></tr><tr><td>C9</td></tr></table>\n\n#### MAJOR",
		);
		const report = parse_report("da.md", text, FULL);
		check(
			"raw HTML → raw HTML",
			expectThrows(() => check_da_anchors(report), "raw HTML"),
		);
	}
}

console.log("\nAC-76: DA MAJOR row gates");
{
	for (const [row, fragment] of [
		["| M1 | Issue |  |", "ANCHOR-MISSING"],
		["| M1 | Issue | see page 3 |", "ANCHOR-INVALID"],
		['|  | Issue | text: "quote" |', "empty MAJOR # cell"],
	] as Array<[string, string]>) {
		const report = parse_report("da.md", daText(undefined, null, [row]), FULL);
		check(
			`MAJOR ${fragment} → error`,
			expectThrows(() => check_da_anchors(report), fragment),
		);
	}
	// Valid MAJOR row passes
	{
		const report = parse_report(
			"da.md",
			daText(undefined, null, ['| M1 | Issue | text: "short quote" |']),
			FULL,
		);
		check(
			"valid MAJOR → passes",
			expectNoThrow(() => check_da_anchors(report)),
		);
	}
}

console.log("\nAC-77: DA terminal-band enforcement");
{
	// Post-critical prose fails
	{
		const text = daText([]).replace(
			"\n\n#### MAJOR",
			"\n\n*None.*\n\n#### MAJOR",
		);
		const report = parse_report("da.md", text, FULL);
		check(
			"post-critical prose → terminal",
			expectThrows(() => check_da_anchors(report), "issue tables are terminal"),
		);
	}
	// Pre-table prose passes
	{
		const text = daText(undefined, null, [
			'| M1 | Issue | text: "short quote" |',
		]).replace(
			"#### CRITICAL",
			"Ordinary prose precedes the tables.\n\n#### CRITICAL",
		);
		const report = parse_report("da.md", text, FULL);
		check(
			"pre-table prose → passes",
			expectNoThrow(() => check_da_anchors(report)),
		);
	}
	// Bare comment closer passes
	{
		const text = daText(["C1"])
			.replace("#### CRITICAL", "N moves 41 --> 38.\n\n#### CRITICAL")
			.replace('text: "quote" p. 1', 'text: "N moves 41 --> 38" p. 1');
		const report = parse_report("da.md", text, FULL);
		check(
			"bare comment closer → passes",
			expectNoThrow(() => check_da_anchors(report)),
		);
	}
}

console.log("\nAC-78: DA required sections fail closed");
{
	for (const [old, newV, fragment] of [
		["#### CRITICAL", "#### Critical", "DA-CRITICAL-PARSE"],
		["#### MAJOR", "#### Major", "DA-MAJOR-PARSE"],
		["#### MAJOR", "#### MAJOR\n\n#### MAJOR", "DA-MAJOR-PARSE"],
	] as Array<[string, string, string]>) {
		const report = parse_report("da.md", daText().replace(old, newV), FULL);
		check(
			`section drift ${fragment} → error`,
			expectThrows(() => check_da_anchors(report), fragment),
		);
	}
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
