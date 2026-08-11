// Unit tests for the panel-synthesis core (slice 3b).
// Run via: tsc -p tsconfig.test.json && node .test-build/core/panel-synthesis-core.test.js
//
// These tests port the 3b-relevant groups from the upstream Python oracle
// (upstream/scripts/test_check_panel_synthesis.py) into the Pi TS test harness:
//   * AC-13     — majority thresholds (n=1, n=2)
//   * AC-14     — equal-severity tie → earliest ordinal
//   * AC-15     — denominator excludes ineligible seats
//   * AC-16     — dimension-unassessed aborts (ContractError)
//   * AC-17     — verdict mismatch → synthesis failure
//   * AC-18     — fatal precedence over repairable
//   * AC-19..22 — DA-CRITICAL terminal gate (parity/rationale/marker)
//   * AC-12     — synthesis fence hiding (malformed closer + unicode)
//   * AC-39     — boundary decisions + D3 split dynamics
//   * AC-41     — 12-profile methodology-focus exhaustive + MF semantics

import {
	ContractError,
	SynthesisError,
	load_contract,
	parse_report,
	type DimensionScore,
	type ReviewerReport,
	type ExpressionAtom,
	type SprintContract,
} from "./reviewer-gate-core.js";
import {
	quantifier_fires,
	evaluate_expression,
	resolve_decision,
	compute_dimension_verdicts,
	recompute_panel,
	parse_synthesis,
	layer2_check,
	ACTION_ENUM,
} from "./panel-synthesis-core.js";
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
const MF_PATH = join(
	REPO,
	"upstream",
	"shared",
	"contracts",
	"reviewer",
	"methodology_focus.json",
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

// ---------------------------------------------------------------------------
// Test helpers (ported from upstream test_check_panel_synthesis.py)
// ---------------------------------------------------------------------------

function state(value: string): DimensionScore {
	if (value === "fatal")
		return { score: "block", block_class: "fatal", trigger: "fatal trigger", abstain_reason: null };
	if (value === "block")
		return { score: "block", block_class: "repairable", trigger: "block trigger", abstain_reason: null };
	if (value === "warn")
		return { score: "warn", block_class: null, trigger: "warn trigger", abstain_reason: null };
	if (value === "abstain")
		return { score: "not_assessed", block_class: null, trigger: null, abstain_reason: "not applicable" };
	return { score: value, block_class: null, trigger: null, abstain_reason: null };
}

function report_text(role: string, overrides: Record<string, string> | null = null, daIds: string[] = []): string {
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

function reports(overrides: Record<string, Record<string, string>> | null = null, daIds: string[] = []): ReviewerReport[] {
	const ov = overrides ?? {};
	return ROLES.map((role) =>
		parse_report(
			`${role}.md`,
			report_text(role, ov[role] ?? null, role === "da" ? daIds : []),
			FULL,
		),
	);
}

function synthesis_for(
	panelReports: ReviewerReport[],
	adjudications: Record<string, string> | null = null,
	decisionOverride: string | null = null,
	markerCount: number | null = null,
	rationales: Record<string, string> | null = null,
): [string, Record<string, readonly ExpressionAtom[]>] {
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
	return [lines.join("\n"), expressions];
}

function evaluateProfile(
	contract: SprintContract,
	expressions: Record<string, readonly ExpressionAtom[]>,
	assessed: Record<string, DimensionScore[]>,
): [string[], string] {
	const failureConditions = contract.failure_conditions as Record<string, unknown>[];
	const fired = failureConditions
		.filter((condition) =>
			evaluate_expression(
				expressions[condition.condition_id as string],
				assessed,
				condition.cross_reviewer_quantifier as string,
				[],
			),
		)
		.map((condition) => condition.condition_id as string);
	const decision = resolve_decision(failureConditions, new Set(fired));
	return [fired, decision];
}

// ===========================================================================
// AC-13: majority thresholds
// ===========================================================================

console.log("\nAC-13: majority thresholds");

check("majority n=1 [True] → true", quantifier_fires("majority", [true], []) === true);
check("majority n=1 [False] → false", quantifier_fires("majority", [false], []) === false);
check("majority n=2 [True,False] → false", quantifier_fires("majority", [true, false], []) === false);
check("majority n=2 [True,True] → true", quantifier_fires("majority", [true, true], []) === true);
check("majority n=3 [T,T,F] → true (2>=2)", quantifier_fires("majority", [true, true, false], []) === true);
check("majority n=3 [T,F,F] → false (1<2)", quantifier_fires("majority", [true, false, false], []) === false);
check("any [T,F] → true", quantifier_fires("any", [true, false], []) === true);
check("all [T,T] → true", quantifier_fires("all", [true, true], []) === true);
check("all [T,F] → false", quantifier_fires("all", [true, false], []) === false);

// Empty indicators raises ContractError
try {
	quantifier_fires("any", [], []);
	check("empty indicators raises ContractError", false);
} catch (e) {
	check("empty indicators raises ContractError", e instanceof ContractError);
}

// ===========================================================================
// AC-14: equal-severity tie → earliest ordinal
// ===========================================================================

console.log("\nAC-14: equal-severity tie → earliest ordinal");

{
	const conditions = [
		{ condition_id: "F1", severity: 50, action: "editorial_decision=minor_revision" },
		{ condition_id: "F2", severity: 50, action: "editorial_decision=reject" },
	];
	check("tie order 1 → F1 action (minor_revision)", resolve_decision(conditions as never, new Set(["F1", "F2"])) === "editorial_decision=minor_revision");
}
{
	const conditions = [
		{ condition_id: "F1", severity: 50, action: "editorial_decision=reject" },
		{ condition_id: "F2", severity: 50, action: "editorial_decision=minor_revision" },
	];
	check("tie order 2 → F1 action (reject)", resolve_decision(conditions as never, new Set(["F1", "F2"])) === "editorial_decision=reject");
}

// ===========================================================================
// AC-15: denominator excludes ineligible seats
// ===========================================================================

console.log("\nAC-15: denominator excludes ineligible seats");

{
	const panelReports = reports({ methodology: { D1: "warn" } });
	const [, expressions] = load_contract(FULL_PATH);
	const [, fired, decision] = recompute_panel(panelReports, FULL, expressions, []);
	check("methodology D1=warn → F5 fired", fired.includes("F5"));
	check("methodology D1=warn → minor_revision", decision === "editorial_decision=minor_revision");
}
{
	const panelReports = reports();
	const eicReport = panelReports.find((r) => r.role === "eic")!;
	eicReport.scores["D1"] = state("fatal");
	const [contract, expressions] = load_contract(FULL_PATH);
	const [assessed, fired, decision] = recompute_panel(panelReports, contract, expressions, []);
	check("EIC fatal on D1 excluded: assessed D1 has 1 entry", assessed["D1"].length === 1);
	check("EIC fatal on D1 excluded: D1 score is pass", assessed["D1"][0].score === "pass");
	check("EIC fatal on D1 excluded: fired == [F0]", JSON.stringify(fired) === JSON.stringify(["F0"]));
	check("EIC fatal on D1 excluded: decision accept", decision === "editorial_decision=accept");
}

// ===========================================================================
// AC-16: dimension-unassessed aborts (ContractError)
// ===========================================================================

console.log("\nAC-16: dimension-unassessed aborts");

{
	const panelReports = reports({ methodology: { D3: "abstain" }, da: { D3: "abstain" } });
	const [, expressions] = load_contract(FULL_PATH);
	try {
		recompute_panel(panelReports, FULL, expressions, []);
		check("D3 all-abstain raises ContractError", false);
	} catch (e) {
		const err = e as Error;
		check("D3 all-abstain is ContractError", e instanceof ContractError);
		check("D3 all-abstain matches DIMENSION-UNASSESSED: D3", /DIMENSION-UNASSESSED: D3/.test(err.message));
	}
}

// ===========================================================================
// AC-17: verdict mismatch → synthesis failure
// ===========================================================================

console.log("\nAC-17: verdict mismatch");

{
	const panelReports = reports();
	const [text, expressions] = synthesis_for(panelReports);
	const mutated = text.replace("D1=pass", "D1=warn");
	const synth = parse_synthesis("s.md", mutated, FULL);
	const diags = layer2_check(panelReports, FULL, expressions, synth, []);
	check("mutated verdict → PANEL-SYNTHESIS-MISMATCH", diags.some((d) => d.includes("PANEL-SYNTHESIS-MISMATCH")));
}

// ===========================================================================
// AC-18: fatal precedence over repairable
// ===========================================================================

console.log("\nAC-18: fatal precedence over repairable");

{
	const panelReports = reports({ methodology: { D1: "fatal" }, domain: { D2: "block" } });
	const [text, expressions] = synthesis_for(panelReports);
	const synth = parse_synthesis("s.md", text, FULL);
	check("fatal+repairable → fired[:2] == [F1,F2]", JSON.stringify(synth.fired.slice(0, 2)) === JSON.stringify(["F1", "F2"]));
	check("fatal+repairable → reject", synth.decision === "editorial_decision=reject");
	check("fatal+repairable → layer2_check []", layer2_check(panelReports, FULL, expressions, synth, []).length === 0);
}

// ===========================================================================
// AC-19: DA-CRITICAL adjudication parity (omitted + phantom)
// ===========================================================================

console.log("\nAC-19: DA-CRITICAL adjudication parity");

{
	// Omitted C1
	const panelReports = reports(null, ["C1"]);
	const [text, expressions] = synthesis_for(panelReports, {});
	const synth = parse_synthesis("s.md", text, FULL);
	const diags = layer2_check(panelReports, FULL, expressions, synth, []);
	check("omitted C1 → MISMATCH", diags.some((d) => d.includes("MISMATCH")));
}
{
	// Phantom C3
	const panelReports = reports(null, ["C1"]);
	const [text, expressions] = synthesis_for(panelReports, { C1: "REJECTED", C3: "VALIDATED" }, null, 1, { C1: "rationale" });
	const synth = parse_synthesis("s.md", text, FULL);
	const diags = layer2_check(panelReports, FULL, expressions, synth, []);
	check("phantom C3 → MISMATCH", diags.some((d) => d.includes("MISMATCH")));
}

// ===========================================================================
// AC-20: REJECTED requires rationale; with rationale + no marker passes
// ===========================================================================

console.log("\nAC-20: DA-CRITICAL rationale");

{
	// Missing rationale
	const panelReports = reports(null, ["C1"]);
	const [text, expressions] = synthesis_for(panelReports, { C1: "REJECTED" });
	const synth = parse_synthesis("s.md", text, FULL);
	const diags = layer2_check(panelReports, FULL, expressions, synth, []);
	check("REJECTED without rationale → RATIONALE", diags.some((d) => d.includes("RATIONALE")));
}
{
	// With rationale, no marker → passes
	const panelReports = reports(null, ["C1"]);
	const [text, expressions] = synthesis_for(panelReports, { C1: "REJECTED" }, null, null, { C1: "The quoted sentence does not support the claim." });
	const synth = parse_synthesis("s.md", text, FULL);
	check("REJECTED with rationale + no marker → []", layer2_check(panelReports, FULL, expressions, synth, []).length === 0);
}

// ===========================================================================
// AC-21: accept + active requires counted marker
// ===========================================================================

console.log("\nAC-21: accept + active marker");

for (const adjudication of ["VALIDATED", "UNRESOLVED"] as const) {
	const panelReports = reports(null, ["C1"]);
	const [text, expressions] = synthesis_for(panelReports, { C1: adjudication }, null, 1);
	const synth = parse_synthesis("s.md", text, FULL);
	check(`${adjudication} + marker=1 → []`, layer2_check(panelReports, FULL, expressions, synth, []).length === 0);
	// Missing marker
	const missing = parse_synthesis("s.md", text.replace("\n[DA-CRITICAL-VS-ACCEPT: 1 validated/unresolved]", ""), FULL);
	const diagsMissing = layer2_check(panelReports, FULL, expressions, missing, []);
	check(`${adjudication} no marker → MARKER`, diagsMissing.some((d) => d.includes("MARKER")));
}
{
	// Wrong count
	const panelReports = reports(null, ["C1"]);
	const [text, expressions] = synthesis_for(panelReports, { C1: "VALIDATED" }, null, 2);
	const synth = parse_synthesis("s.md", text, FULL);
	const diags = layer2_check(panelReports, FULL, expressions, synth, []);
	check("VALIDATED marker=2 (should be 1) → MARKER", diags.some((d) => d.includes("MARKER")));
}

// ===========================================================================
// AC-22: marker forbidden under non-accept
// ===========================================================================

console.log("\nAC-22: marker forbidden under non-accept");

{
	const panelReports = reports({ methodology: { D1: "warn" } }, ["C1"]);
	const [text, expressions] = synthesis_for(panelReports, { C1: "VALIDATED" }, null, 1);
	const synth = parse_synthesis("s.md", text, FULL);
	check("non-accept decision is minor_revision", synth.decision === "editorial_decision=minor_revision");
	const diags = layer2_check(panelReports, FULL, expressions, synth, []);
	check("marker under non-accept → forbidden", diags.some((d) => d.includes("forbidden")));
}

// ===========================================================================
// AC-12 (synthesis portion): fence hiding
// ===========================================================================

console.log("\nAC-12 (synthesis): fence hiding");

{
	// Malformed fence closer keeps synthesis hidden
	const [synthText] = synthesis_for(reports());
	const hidden = `~~~text\n~~~not-a-close\n${synthText}\n~~~\n`;
	try {
		parse_synthesis("s.md", hidden, FULL);
		check("malformed fence hides synthesis → throws", false);
	} catch (e) {
		const err = e as Error;
		check("malformed fence → SynthesisError", e instanceof SynthesisError);
		check("malformed fence → matches fired_conditions", /fired_conditions/.test(err.message));
	}
}
for (const separator of ["\u0085", "\u2028", "\u2029"]) {
	const [synthText] = synthesis_for(reports());
	const hidden = `~~~text\n~~~${separator}${synthText}\n~~~\n`;
	try {
		parse_synthesis("hidden-synthesis.md", hidden, FULL);
		check(`unicode separator ${JSON.stringify(separator)} keeps synthesis fenced → throws`, false);
	} catch (e) {
		check(`unicode separator ${JSON.stringify(separator)} → SynthesisError`, e instanceof SynthesisError);
	}
}

// ===========================================================================
// AC-39: boundary decisions + D3 split dynamics
// ===========================================================================

console.log("\nAC-39: boundary decisions + D3 split dynamics");

{
	const [, expressions] = load_contract(FULL_PATH);
	const base: Record<string, DimensionScore[]> = {
		D1: [state("pass")], D2: [state("pass")], D4: [state("pass")],
		D5: [state("pass")], D6: [state("pass")], D3: [state("pass"), state("pass")],
	};
	const oneWarn = { ...base, D1: [state("warn")] };
	check("D1=warn → minor_revision", evaluateProfile(FULL, expressions, oneWarn)[1] === "editorial_decision=minor_revision");
	const normalBlock = { ...base, D5: [state("block")] };
	check("D5=block → minor_revision", evaluateProfile(FULL, expressions, normalBlock)[1] === "editorial_decision=minor_revision");
	const highBlock = { ...base, D4: [state("block")] };
	check("D4=block → major_revision", evaluateProfile(FULL, expressions, highBlock)[1] === "editorial_decision=major_revision");
	const fatalVenue = { ...base, D6: [state("fatal")] };
	check("D6=fatal → reject", evaluateProfile(FULL, expressions, fatalVenue)[1] === "editorial_decision=reject");
	// D3 split [block, pass] → F2 fired, F3 NOT fired
	const split = { ...base, D3: [state("block"), state("pass")] };
	const splitFired = evaluateProfile(FULL, expressions, split)[0];
	check("D3=[block,pass] → F2 fired", splitFired.includes("F2"));
	check("D3=[block,pass] → F3 NOT fired", !splitFired.includes("F3"));
	// Dynamic majority: D3=[warn] → F5 fires; D3=[pass] → F5 does not fire
	for (const assessedD3 of [[state("warn")], [state("pass")]]) {
		const dynamic = { ...base, D3: assessedD3 };
		const dynamicFired = evaluateProfile(FULL, expressions, dynamic)[0];
		check(`D3=[${assessedD3[0].score}] → F5 == ${assessedD3[0].score === "warn"}`, dynamicFired.includes("F5") === (assessedD3[0].score === "warn"));
	}
}

// n=2 majority split cannot harden
{
	const [, expressions] = load_contract(FULL_PATH);
	const assessed: Record<string, DimensionScore[]> = {
		D1: [state("warn")], D2: [state("pass")], D3: [state("warn"), state("pass")],
		D4: [state("pass")], D5: [state("pass")], D6: [state("pass")],
	};
	const [fired, decision] = evaluateProfile(FULL, expressions, assessed);
	check("n=2 split fired == [F5]", JSON.stringify(fired) === JSON.stringify(["F5"]));
	check("n=2 split decision == minor_revision", decision === "editorial_decision=minor_revision");
}

// ===========================================================================
// AC-41: 12-profile MF exhaustive + MF semantics
// ===========================================================================

console.log("\nAC-41: 12-profile MF exhaustive + MF semantics");

{
	const [contract, expressions] = load_contract(MF_PATH);
	const mandatorySingle = ["pass", "warn", "block", "fatal"];
	const nonmandatorySingle = ["pass", "warn", "block"];
	let count = 0;
	const decisions = new Set<string>();
	for (const d1 of mandatorySingle) {
		for (const d2 of nonmandatorySingle) {
			const [fired, decision] = evaluateProfile(contract, expressions, { D1: [state(d1)], D2: [state(d2)] });
			check(`MF d1=${d1} d2=${d2} fires ≥1`, fired.length > 0);
			check(`MF d1=${d1} d2=${d2} decision ∈ ACTION_ENUM`, ACTION_ENUM.has(decision));
			decisions.add(decision);
			count++;
		}
	}
	check("MF exhaustive count == 12", count === 12);
	check("MF decisions == ACTION_ENUM", decisions.size === ACTION_ENUM.size && [...decisions].every((d) => ACTION_ENUM.has(d)));
}
{
	// D1=warn → F3 → major_revision
	const [contract, expressions] = load_contract(MF_PATH);
	const [fired, decision] = evaluateProfile(contract, expressions, { D1: [state("warn")], D2: [state("pass")] });
	check("MF D1=warn → fired == [F3]", JSON.stringify(fired) === JSON.stringify(["F3"]));
	check("MF D1=warn → major_revision", decision === "editorial_decision=major_revision");
}
{
	// MF accept panel → empty DA gate → layer2_check []
	const [contract, expressions] = load_contract(MF_PATH);
	const panelReports: ReviewerReport[] = [];
	for (const role of ["eic", "methodology"]) {
		const lines = [`contract_role: ${role}`, "", "## Dimension Scores", ""];
		for (const dim of contract.acceptance_dimensions as Record<string, unknown>[]) {
			lines.push(`### ${dim.id}: ${dim.name}`);
			lines.push((dim.eligible_roles as string[]).includes(role) ? "score: pass" : "score: not_assessed");
			lines.push("");
		}
		lines.push("## Review Body", "", "No scored findings.", "");
		panelReports.push(parse_report(`${role}.md`, lines.join("\n"), contract));
	}
	const synth = parse_synthesis(
		"s.md",
		"dimension_verdicts: [D1=pass, D2=pass]\nfired_conditions: [F0]\nda_critical_adjudications: []\neditorial_decision=accept\n",
		contract,
	);
	check("MF accept → empty DA gate → layer2_check []", layer2_check(panelReports, contract, expressions, synth, []).length === 0);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
