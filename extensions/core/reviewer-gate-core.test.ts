// Unit tests for the reviewer-gate shared core (slice 3a).
// Run via: tsc -p tsconfig.test.json && node .test-build/core/reviewer-gate-core.test.js
//
// These tests port the 3a-relevant groups from the upstream Python oracle
// (upstream/scripts/test_check_panel_synthesis.py) into the Pi TS test harness:
//   * AC-1/2/3  — evidence-anchor validator (~38 cases)
//   * AC-4/5    — expression grammar parse + fail-closed (14 cases)
//   * AC-6..12  — report parsing: role-scope, out-of-role, abstention,
//                 block-class, trigger, V1-retired, fence/unicode (core)
//   * AC-23..32 — DA table parsing: heading/separator/ID/terminal/HTML-comment/
//                 shadow/visible-text/escaped-pipe/invisible-fullwidth/anchor-wired
//
// DA tests that upstream routes through layer2_check are adapted to call
// parse_da_tables / parse_da_critical_table directly — the errors originate
// in those 3a functions.

import {
	ContractError,
	ReportError,
	parse_expression,
	validate_evidence_anchor,
	parse_report,
	parse_da_tables,
	parse_da_critical_table,
	type SprintContract,
} from "./reviewer-gate-core.js";
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

const FULL: SprintContract = JSON.parse(readFileSync(FULL_PATH, "utf-8"));

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

function assertReportError(
	fn: () => void,
	pattern: RegExp,
	name: string,
): void {
	try {
		fn();
		check(`${name} (should throw ReportError)`, false);
	} catch (e) {
		const err = e as Error;
		check(`${name} is ReportError`, err instanceof ReportError);
		check(`${name} matches /${pattern}/`, pattern.test(err.message));
	}
}

function assertContractError(
	fn: () => void,
	pattern: RegExp,
	name: string,
): void {
	try {
		fn();
		check(`${name} (should throw ContractError)`, false);
	} catch (e) {
		const err = e as Error;
		check(`${name} is ContractError`, err instanceof ContractError);
		check(`${name} matches /${pattern}/`, pattern.test(err.message));
	}
}

function assertNoThrow(fn: () => void, name: string): void {
	try {
		fn();
		check(`${name} (no throw)`, true);
	} catch (e) {
		check(`${name} (no throw)`, false);
		console.error(`    unexpected: ${(e as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// Test helper: report_text (ported from upstream)
// ---------------------------------------------------------------------------

function report_text(
	role: string,
	overrides?: Record<string, string>,
	da_ids: string[] = [],
): string {
	const ov = overrides ?? {};
	const dims = FULL.acceptance_dimensions as Record<string, unknown>[];
	const lines: string[] = [`contract_role: ${role}`, "", "## Dimension Scores", ""];
	for (const dim of dims) {
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
		lines.push(
			"#### CRITICAL",
			"| # | Issue | Evidence Anchor |",
			"|---|-------|-----------------|",
		);
		for (const findingId of da_ids) {
			lines.push(`| ${findingId} | Issue | text: "quoted evidence" p. 1 |`);
		}
		lines.push(
			"",
			"#### MAJOR",
			"| # | Issue | Evidence Anchor |",
			"|---|-------|-----------------|",
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AC-1: anchor validator rejects incomplete/unpaired shapes (~24)
// ---------------------------------------------------------------------------

const ANCHOR_REJECTS = [
	"absence: x",
	"absence: Methods \u2014 expected ethics;checked appendix",
	"absence: Methods \u2014 expected ethics;  checked appendix",
	"absence: Methods \u2014 expected ; checked appendix \u2014 expected ethics; checked supplement",
	"absence: Methods; checked appendix \u2014 expected ethics",
	"equation: Eq. ]3[",
	"absence: Methods \u2014 expected ethics; checked appendix]",
	"[absence: Methods \u2014 expected ethics; checked appendix",
	'text: \u00a7References, six DOI strings in list order',
	'[ text: \u00a75 "short exact quote" ]',
	'` text: \u00a75 "short exact quote" `',
	'`text: \u00a75 "short exact quote"',
	'text: \u00a75 "short exact quote"`',
	'text: \u00a75 "short exact quote"]',
	'text: \u00a75 "short exact quote"`]',
	'[text: \u00a75 "short exact quote"] trailing]',
	'[[text: \u00a75 "short exact quote"]]',
	'``text: \u00a75 "short exact quote"``',
	'text: \u00a75 "short exact quote\u201d',
	'text: \u00a75 \u201cshort exact quote"',
	'text: \u00a75 "outer \u201cinner"',
	'text: \u00a75 \u201couter "inner\u201d"',
	'text: \u00a75 \u201couter \u201c\u201d tail\u201d',
];

console.log("AC-1: anchor_validator_rejects_incomplete_or_unpaired_shapes");
{
	let n = 0;
	for (const anchor of ANCHOR_REJECTS) {
		n++;
		assertReportError(
			() => validate_evidence_anchor(anchor, "probe"),
			/ANCHOR-INVALID/,
			`reject #${n}`,
		);
	}
}

// ---------------------------------------------------------------------------
// AC-2: anchor validator accepts complete paired shapes (~11)
// ---------------------------------------------------------------------------

const ANCHOR_ACCEPTS = [
	"absence: Methods \u2014 expected an ethics statement; checked Methods, appendix",
	'`text: \u00a75 "short exact quote"`',
	"text: \u00a75 \u201cshort exact quote\u201d",
	"equation: Eq. [3]",
	"table: Table 2 [Panel B]",
	"[equation: Eq. [3]]",
	'text: \u00a74 "short quote" [emphasis added]',
	'text: \u00a73 "short quote" per `df`',
	'`text: \u00a73 "short quote" per `df``',
	'text: \u00a72 \u201cthe term \u201cquality culture\u201d is undefined\u201d',
	'text: \u00a72 "he said \u201cquality culture\u201d often"',
];

console.log("AC-2: anchor_validator_accepts_complete_paired_shapes");
{
	let n = 0;
	for (const anchor of ANCHOR_ACCEPTS) {
		n++;
		assertNoThrow(
			() => validate_evidence_anchor(anchor, "inverse"),
			`accept #${n}`,
		);
	}
}

// ---------------------------------------------------------------------------
// AC-3: anchor 25/26-word boundary + differential
// ---------------------------------------------------------------------------

console.log("AC-3: anchor_nested_quote_word_limit_per_pair");
{
	const words25 = Array(25).fill("word").join(" ");
	const words26 = Array(26).fill("word").join(" ");
	assertNoThrow(
		() => validate_evidence_anchor(`text: \u00a72 \u201c\u201c${words25}\u201d\u201d`, "nested-25"),
		"25-word nested passes",
	);
	assertReportError(
		() => validate_evidence_anchor(`text: \u00a72 \u201c\u201c${words26}\u201d\u201d`, "nested-26"),
		/at most 25 words/,
		"26-word nested rejects",
	);
	const outerWords = Array(24).fill("outer").join(" ");
	assertReportError(
		() => validate_evidence_anchor(`text: \u00a72 \u201c${outerWords} \u201cinner\u201d tail\u201d`, "nested-differential"),
		/at most 25 words/,
		"differential outer-26-inner-1 rejects",
	);
}

// ---------------------------------------------------------------------------
// AC-4: expression grammar — 10 valid patterns parse
// ---------------------------------------------------------------------------

const EXPRESSION_VALID = [
	"any mandatory dimension scores 'block'",
	"two or more mandatory dimensions score 'warn' or worse",
	"every mandatory dimension scores 'pass'",
	"D1 scores 'block'",
	"D1 scores 'warn' AND every high dimension scores 'pass'",
	"any mandatory dimension has a fatal block",
	"D1 has a fatal block",
	"any dimension scores 'warn' or worse",
	"D2 scores 'warn' or worse",
	"every dimension scores 'pass'",
];

console.log("AC-4: expression_patterns_parse");
{
	const dims: Record<string, Record<string, unknown>> = {};
	for (const d of FULL.acceptance_dimensions as Record<string, unknown>[]) {
		dims[d.id as string] = d;
	}
	let n = 0;
	for (const expr of EXPRESSION_VALID) {
		n++;
		const atoms = parse_expression(expr, dims, "Fx");
		check(`expression #${n} parses to non-empty atoms`, atoms.length > 0);
	}
}

// ---------------------------------------------------------------------------
// AC-5: expression grammar — 4 invalid patterns fail-closed
// ---------------------------------------------------------------------------

const EXPRESSION_INVALID = [
	"some dimension fails",
	"D99 scores 'pass'",
	"any high dimension has a fatal block",
	"D4 has a fatal block",
];

console.log("AC-5: expression_fail_closed");
{
	const dims: Record<string, Record<string, unknown>> = {};
	for (const d of FULL.acceptance_dimensions as Record<string, unknown>[]) {
		dims[d.id as string] = d;
	}
	let n = 0;
	for (const expr of EXPRESSION_INVALID) {
		n++;
		assertContractError(
			() => parse_expression(expr, dims, "Fx"),
			/./,
			`invalid expression #${n}`,
		);
	}
}

// ---------------------------------------------------------------------------
// AC-6: report parsing — role-scoping and structural abstention
// ---------------------------------------------------------------------------

console.log("AC-6: parse_report_role_scope_and_structural_abstention");
{
	const report = parse_report("eic.md", report_text("eic"), FULL);
	check('EIC D1 == "not_assessed"', report.scores["D1"].score === "not_assessed");
	check('EIC D5 == "pass"', report.scores["D5"].score === "pass");
}

// ---------------------------------------------------------------------------
// AC-7: out-of-role real score rejected
// ---------------------------------------------------------------------------

console.log("AC-7: out_of_role_real_score_rejected");
{
	const text = report_text("eic").replace(
		"### D1: methodology_rigor\nscore: not_assessed",
		"### D1: methodology_rigor\nscore: pass",
	);
	assertReportError(
		() => parse_report("eic.md", text, FULL),
		/OUT-OF-ROLE/,
		"EIC scores ineligible D1",
	);
}

// ---------------------------------------------------------------------------
// AC-8: eligible abstention requires a reason
// ---------------------------------------------------------------------------

console.log("AC-8: eligible_abstention_requires_reason");
{
	const text = report_text("eic", { D5: "abstain" }).replace(
		"\nabstain_reason: materially inapplicable",
		"",
	);
	assertReportError(
		() => parse_report("eic.md", text, FULL),
		/abstain_reason/,
		"eligible abstention without reason",
	);
}

// ---------------------------------------------------------------------------
// AC-9: non-mandatory block cannot carry block_class
// ---------------------------------------------------------------------------

console.log("AC-9: nonmandatory_block_cannot_carry_block_class");
{
	const text = report_text("perspective", { D4: "pass" }).replace(
		"### D4: cross_disciplinary_relevance\nscore: pass",
		'### D4: cross_disciplinary_relevance\nscore: block\nblock_class: repairable\ntrigger: "block trigger"',
	);
	assertReportError(
		() => parse_report("p.md", text, FULL),
		/BLOCK-CLASS/,
		"non-mandatory block with block_class",
	);
}

// ---------------------------------------------------------------------------
// AC-10: trigger required iff block or warn
// ---------------------------------------------------------------------------

console.log("AC-10a: eligible_nonpass_score_requires_trigger");
for (const score of ["warn", "block"] as const) {
	const text = report_text("methodology", { D1: score }).replace(
		`trigger: "${score} trigger"\n`,
		"",
	);
	assertReportError(
		() => parse_report("methodology.md", text, FULL),
		/TRIGGER-GRAMMAR/,
		`${score} without trigger`,
	);
}

console.log("AC-10b: nontriggering_score_forbids_trigger");
{
	// methodology D1 pass + trigger
	const text1 = report_text("methodology").replace(
		"score: pass",
		'score: pass\ntrigger: "post hoc trigger"',
	);
	assertReportError(
		() => parse_report("methodology.md", text1, FULL),
		/TRIGGER-GRAMMAR/,
		"pass with trigger (methodology D1)",
	);
	// eic D1 structural abstention + trigger
	const text2 = report_text("eic").replace(
		"score: not_assessed",
		'score: not_assessed\ntrigger: "post hoc trigger"',
	);
	assertReportError(
		() => parse_report("eic.md", text2, FULL),
		/TRIGGER-GRAMMAR/,
		"not_assessed with trigger (eic D1)",
	);
}

// ---------------------------------------------------------------------------
// AC-11: V1-retired grammar rejected
// ---------------------------------------------------------------------------

console.log("AC-11a: v1_sections_fail_loudly");
{
	const text = report_text("eic") + "\n## Failure Condition Checks\n";
	assertReportError(
		() => parse_report("eic.md", text, FULL),
		/V1-GRAMMAR-RETIRED/,
		"retired H2 section",
	);
}

console.log("AC-11b: v1_bare_decision_line_fails_loudly");
for (const action of ["reject", "Reject", "reject-or-major-revision", "unknown_v1_value"]) {
	const key = "editorial_decision";
	const text = report_text("eic") + `\n${key}=${action}\n`;
	assertReportError(
		() => parse_report("eic.md", text, FULL),
		/V1-GRAMMAR-RETIRED/,
		`bare decision ${action}`,
	);
}
{
	const key = "Editorial_Decision";
	const text = report_text("eic") + `\n${key}=mixed_key_case\n`;
	assertReportError(
		() => parse_report("eic.md", text, FULL),
		/V1-GRAMMAR-RETIRED/,
		"case-variant key",
	);
}

console.log("AC-11c: indented_v1_bare_decision_line_fails_loudly");
for (const indent of ["  ", "\t"]) {
	const text = report_text("eic") + `\n${indent}editorial_decision=accept\n`;
	assertReportError(
		() => parse_report("eic.md", text, FULL),
		/V1-GRAMMAR-RETIRED/,
		`indented decision (${indent === "\t" ? "tab" : "2-space"})`,
	);
}

// ---------------------------------------------------------------------------
// AC-12: CommonMark fence & unicode-separator hiding (report core)
// ---------------------------------------------------------------------------

console.log("AC-12a: fenced_v1_bare_decision_decoy_is_ignored");
{
	const text = report_text("eic") + "\n```text\neditorial_decision=Reject\n```\n";
	assertNoThrow(
		() => parse_report("eic.md", text, FULL),
		"fenced decoy ignored",
	);
}

console.log("AC-12b: malformed_fence_closer_does_not_expose_bare_decision");
for (const fence of ["```", "~~~"]) {
	const text =
		report_text("eic") +
		`\n${fence}text\n${fence}not-a-close\neditorial_decision=accept\n${fence}\n`;
	assertNoThrow(
		() => parse_report("eic.md", text, FULL),
		`malformed closer (${fence})`,
	);
}

console.log("AC-12c: malformed_fence_closer_keeps_reviewer_report_hidden");
{
	const text = "```text\n```not-a-close\n" + report_text("eic") + "\n```\n";
	assertReportError(
		() => parse_report("eic.md", text, FULL),
		/Dimension Scores/,
		"malformed closer hides report body",
	);
}

console.log("AC-12d: unicode_separator_cannot_close_commonmark_fence");
for (const sep of ["\x85", "\u2028", "\u2029"]) {
	const text =
		"```text\n```" +
		sep +
		report_text("methodology", { D1: "fatal" }) +
		"\n```\n";
	assertReportError(
		() => parse_report("hidden-methodology.md", text, FULL),
		/Dimension Scores/,
		`unicode separator ${sep === "\x85" ? "NEL" : sep === "\u2028" ? "LS" : "PS"}`,
	);
}

// ---------------------------------------------------------------------------
// AC-23: DA heading drift — CRITICAL/MAJOR
// ---------------------------------------------------------------------------

console.log("AC-23a: da_critical_section_drift_fails_closed");
{
	const baseText = report_text("da");
	const mutations: [string, string][] = [
		["#### Critical", "case-variant"],
		["#### CRITICAL ISSUES", "renamed"],
	];
	for (const [newHeading, label] of mutations) {
		const text = baseText.replace("#### CRITICAL", newHeading);
		assertReportError(
			() => parse_da_critical_table(text, "da.md"),
			/exactly one #### CRITICAL/,
			`CRITICAL heading drift: ${label}`,
		);
	}
	// duplicate CRITICAL
	const dupText = baseText.replace(
		"#### CRITICAL",
		"#### CRITICAL\n| # | Issue | Evidence Anchor |\n|---|-------|-----------------|\n\n#### CRITICAL",
	);
	assertReportError(
		() => parse_da_critical_table(dupText, "da.md"),
		/exactly one #### CRITICAL/,
		"CRITICAL heading drift: duplicate",
	);
}

console.log("AC-23b: da_major_section_drift_fails");
{
	const baseText = report_text("da");
	const mutations: [string, string][] = [
		["#### Major", "case-variant"],
		["", "removed"],
	];
	for (const [newHeading, label] of mutations) {
		const text = baseText.replace("#### MAJOR", newHeading);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			/DA-MAJOR-PARSE/,
			`MAJOR heading drift: ${label}`,
		);
	}
	// duplicate MAJOR
	const dupText = baseText.replace(
		"#### MAJOR",
		"#### MAJOR\n| # | Issue | Evidence Anchor |\n|---|-------|-----------------|\n\n#### MAJOR",
	);
	assertReportError(
		() => parse_da_tables(dupText, "da.md"),
		/DA-MAJOR-PARSE/,
		"MAJOR heading drift: duplicate",
	);
}

// ---------------------------------------------------------------------------
// AC-24: DA separator/header validation + AC-25: CRITICAL ID grammar
// ---------------------------------------------------------------------------

console.log("AC-24: da_separator_drift_fails");
{
	const baseText = report_text("da", undefined, ["C1"]);
	const sepMutations: [string, string, string][] = [
		["|---|-------|-----------------|", "", "removed"],
		["|---|-------|-----------------|", "|--|-------|-----------------|", "too short"],
		["|---|-------|-----------------|", "|---|-------|", "column mismatch"],
	];
	for (const [old, newSep, label] of sepMutations) {
		const text = baseText.replace(old, newSep);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			/separator/,
			`separator drift: ${label}`,
		);
	}
}

console.log("AC-24/25: da_header_and_critical_id_gates_fail");
{
	const baseText = report_text("da", undefined, ["C1", "C2"]);
	const headerMutations: [string, string, string][] = [
		["| # | Issue | Evidence Anchor |", "| # | # | Evidence Anchor |", "exactly one #"],
		["| # | Issue | Evidence Anchor |", "| # | Evidence Anchor | Evidence Anchor |", "exactly one #"],
		["| # | Issue | Evidence Anchor |", "| ID | Issue | Anchor |", "missing table header"],
		["| C2 | Issue |", "| C1 | Issue |", "duplicate CRITICAL ID"],
		["| C2 | Issue |", "| X2 | Issue |", "invalid CRITICAL ID"],
	];
	for (const [old, newVal, fragment] of headerMutations) {
		const text = baseText.replace(old, newVal);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			new RegExp(fragment),
			`header/id gate: ${fragment}`,
		);
	}
}

console.log("AC-25: da_empty_major_id_fails");
{
	const baseText = report_text("da");
	const marker = "|---|-------|-----------------|";
	const idx = baseText.lastIndexOf(marker);
	const text =
		baseText.slice(0, idx + marker.length) +
		'\n|  | Issue | text: "quote" |' +
		baseText.slice(idx + marker.length);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/empty MAJOR # cell/,
		"empty MAJOR ID",
	);
}

// ---------------------------------------------------------------------------
// AC-26: DA terminal-band enforcement
// ---------------------------------------------------------------------------

const DA_TERMINAL_LATE_SURFACES = [
	'| C2 | Late issue | text: "late quoted evidence" p. 2 |',
	"| X9 | Bogus issue |  |",
	"| # | Issue | Evidence Anchor |\n|---|-------|-----------------|\n| C9 | Shadow issue |  |",
	'C2 | Late issue | text: "late quoted evidence" p. 2',
	"\u2014 | Late issue | text: \"late quoted evidence\"",
	"# | Issue | Evidence Anchor",
	"C2\nLate issue without pipes\nfigure: Figure 2",
	"- C2\n- Late critical issue\n- figure: Figure 2",
	"> Ordinary post-table commentary",
	"##### Additional commentary",
	"### Closing note\nOrdinary late prose",
];

console.log("AC-26a: da_post_critical_table_prose_fails");
{
	const baseText = report_text("da");
	const text = baseText.replace(
		"\n\n#### MAJOR",
		"\n\n*None. Ordinary adversarial commentary.*\n\n#### MAJOR",
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/issue tables are terminal/,
		"post-CRITICAL prose",
	);
}

console.log("AC-26b: da_post_boundary_table_surfaces_fail (after CRITICAL, before MAJOR)");
{
	let n = 0;
	for (const lateSurface of DA_TERMINAL_LATE_SURFACES) {
		n++;
		const baseText = report_text("da", undefined, ["C1"]);
		const text = baseText.replace(
			"\n\n#### MAJOR",
			`\n\n${lateSurface}\n\n#### MAJOR`,
		);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			/issue tables are terminal/,
			`post-CRITICAL surface #${n}`,
		);
	}
}

console.log("AC-26c: da_post_major_table_surfaces_fail");
{
	let n = 0;
	for (const lateSurface of DA_TERMINAL_LATE_SURFACES) {
		n++;
		const baseText = report_text("da", undefined, ["C1"]);
		const text = baseText + `\n\n${lateSurface}`;
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			/issue tables are terminal/,
			`post-MAJOR surface #${n}`,
		);
	}
}

console.log("AC-26d: da_fenced_payload_after_major_fails");
{
	const baseText = report_text("da", undefined, ["C1"]);
	const text =
		baseText +
		'\n\n```markdown\n| C2 | Hidden critical issue | text: "hidden evidence" p. 2 |\n```';
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/issue tables are terminal/,
		"fenced payload after MAJOR",
	);
}

console.log("AC-26e: da_pre_table_prose_passes");
{
	const baseText = report_text("da", undefined, ["C1"]);
	const text = baseText.replace(
		"#### CRITICAL",
		"Ordinary adversarial commentary precedes the terminal tables.\n\n#### CRITICAL",
	);
	assertNoThrow(
		() => parse_da_tables(text, "da.md"),
		"pre-table prose passes",
	);
}

console.log("AC-26f: da_bare_comment_closer_passes");
{
	let baseText = report_text("da", undefined, ["C1"]);
	baseText = baseText.replace(
		"#### CRITICAL",
		"The reported N moves 41 --> 38 without explanation.\n\n#### CRITICAL",
	);
	baseText = baseText.replace(
		'text: "quoted evidence" p. 1',
		'text: "N moves 41 --> 38" p. 1',
	);
	assertNoThrow(
		() => parse_da_tables(baseText, "da.md"),
		"bare comment-closer passes",
	);
}

console.log("AC-26g: da_trailing_row_without_outer_pipes_fails");
{
	const baseText = report_text("da", undefined, ["C1", "C2"]);
	const text = baseText.replace(
		'| C2 | Issue | text: "quoted evidence" p. 1 |',
		'C2 | Issue | text: "quoted evidence" p. 1',
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/outer-pipe-delimited/,
		"trailing row without outer pipes",
	);
}

// ---------------------------------------------------------------------------
// AC-27: HTML-comment prohibition
// ---------------------------------------------------------------------------

console.log("AC-27a: da_html_comment_inside_fence_fails");
{
	const baseText = report_text("da");
	const text = baseText + "\n\n```\n<!-- hidden adjudication payload -->\n```";
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/HTML comments are forbidden/,
		"HTML comment inside fence",
	);
}

console.log("AC-27b: da_html_commented_tables_fail");
{
	let baseText = report_text("da");
	baseText = baseText.replace("#### CRITICAL", "<!--\n#### CRITICAL");
	baseText = baseText + "\n-->";
	assertReportError(
		() => parse_da_tables(baseText, "da.md"),
		/HTML comments are forbidden/,
		"HTML-commented table",
	);
}

console.log("AC-27c: da_escaped_pipe_cell_evasion_fails");
{
	const baseText = report_text("da");
	const block =
		"#### ADDITIONAL CRITICAL FINDINGS\n" +
		"| [\\#<!--\\|-->](https://x.test) | Issue | " +
		"[Evidence<!--\\|--> Anchor](https://x.test) |\n" +
		"|---|---|---|\n" +
		'| [C<!--\\|-->9](https://x.test) | impossible df | ' +
		'[text<!--\\|-->: "n=41" p. 4](https://x.test) |\n\n';
	const text = baseText.replace("#### MAJOR", block + "#### MAJOR");
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/HTML comments are forbidden/,
		"escaped-pipe comment evasion",
	);
}

// ---------------------------------------------------------------------------
// AC-28: shadow issue-table detection
// ---------------------------------------------------------------------------

console.log("AC-28a: da_shadow_table_fails");
{
	const baseText = report_text("da", undefined, ["C1"]);
	const canonical =
		"| # | Issue | Evidence Anchor |\n" +
		"|---|-------|-----------------|\n" +
		'| C1 | Issue | text: "quoted evidence" p. 1 |';
	const shadowed =
		"| ID | Issue | Anchor |\n" +
		"|---|-------|--------|\n" +
		'| C1 | Issue | text: "quoted evidence" p. 1 |\n\n' +
		"| # | Issue | Evidence Anchor |\n" +
		"|---|-------|-----------------|";
	const text = baseText.replace(canonical, shadowed);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/first nonblank line/,
		"shadow table prepended",
	);
}

console.log("AC-28b: da_standalone_critical_fails");
{
	const baseText = report_text("da");
	const text = baseText.replace(
		"#### CRITICAL",
		"### Further adversarial challenge\n" +
			"- **Severity**: Critical | **Confidence**: 5 (statistics)\n\n" +
			"#### CRITICAL",
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/standalone Severity/,
		"standalone Severity declaration",
	);
}

console.log("AC-28c: da_case_variant_standalone_critical_fails");
for (const label of ["severity", "sEvErItY"]) {
	const baseText = report_text("da");
	const text = baseText.replace(
		"#### CRITICAL",
		`### Further adversarial challenge\nThis is **${label}**: Critical and no revision cures it.\n\n#### CRITICAL`,
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/standalone Severity/,
		`case-variant standalone (${label})`,
	);
}

console.log("AC-28d: da_extra_issue_table_band_fails");
{
	const baseText = report_text("da");
	const text = baseText.replace(
		"#### MAJOR",
		"#### ADDITIONAL CRITICAL FINDINGS\n" +
			"| # | Issue | Evidence Anchor |\n" +
			"|---|-------|-----------------|\n" +
			'| C1 | impossible df | text: "n=41" p. 4 |\n\n' +
			"#### MAJOR",
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/unexpected issue-table band/,
		"extra issue-table band",
	);
}

console.log("AC-28e: da_disguised_extra_issue_table_band_fails");
{
	const cases: [string, string][] = [
		["The following issues invalidate the claim:\n\n", "| # | Issue | Evidence Anchor |"],
		["", "| # | Issue | evidence anchor |"],
		["", "# | Issue | Evidence Anchor"],
	];
	let n = 0;
	for (const [leadIn, header] of cases) {
		n++;
		const baseText = report_text("da");
		const text = baseText.replace(
			"#### MAJOR",
			`#### ADDITIONAL CRITICAL FINDINGS\n${leadIn}${header}\n|---|-------|-----------------|\n| C9 | impossible df | text: "n=41" p. 4 |\n\n#### MAJOR`,
		);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			/unexpected issue-table/,
			`disguised band #${n}`,
		);
	}
}

console.log("AC-28f: da_issue_table_outside_canonical_bands_fails");
for (const placement of ["preamble", "extra_h2"] as const) {
	const baseText = report_text("da");
	const table =
		"| # | Issue | Evidence Anchor |\n" +
		"|---|-------|-----------------|\n" +
		'| C9 | impossible df | text: "n=41" p. 4 |\n';
	let text: string;
	if (placement === "preamble") {
		text = baseText.replace("#### CRITICAL", table + "\n#### CRITICAL");
	} else {
		text = baseText + "\n## Appendix\n" + table;
	}
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/unexpected issue-table/,
		`issue-table ${placement}`,
	);
}

console.log("AC-28g: da_internal_header_whitespace_fails");
{
	const baseText = report_text("da");
	const text = baseText.replace(
		"#### MAJOR",
		"#### ADDITIONAL CRITICAL FINDINGS\n" +
			"# | Issue | Evidence   Anchor\n" +
			"---|-------|-----------------\n" +
			'C9 | impossible df | text: "n=41" p. 4\n\n' +
			"#### MAJOR",
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/unexpected issue-table/,
		"internal header whitespace",
	);
}

console.log("AC-28h: da_raw_html_issue_table_fails");
{
	const baseText = report_text("da");
	const block =
		"#### ADDITIONAL CRITICAL FINDINGS\n" +
		"<table><tr><th>ID</th><th>Evidence</th></tr>" +
		"<tr><td>C9</td><td>text: n=41</td></tr></table>\n\n";
	const text = baseText.replace("#### MAJOR", block + "#### MAJOR");
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/raw HTML issue-table/,
		"raw HTML issue table",
	);
}

console.log("AC-28i: da_nested_html_issue_table_in_canonical_row_fails");
{
	const baseText = report_text("da");
	const nested =
		'real issue <table><tr><th>#</th><th>Evidence Anchor</th></tr>' +
		'<tr><td>C9</td><td>text: "impossible df" p. 4</td></tr></table>';
	const text = baseText.replace(
		"#### MAJOR\n| # | Issue | Evidence Anchor |\n|---|-------|-----------------|",
		`#### MAJOR\n| # | Issue | Evidence Anchor |\n|---|-------|-----------------|\n| M1 | ${nested} | text: "quote" p. 1 |`,
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/raw HTML issue-table/,
		"nested HTML in canonical row",
	);
}

console.log("AC-28j: da_bare_html_row_fails");
{
	const baseText = report_text("da");
	const block =
		"#### ADDITIONAL CRITICAL FINDINGS\n" +
		"<tr><td>C9</td><td>text: n=41</td></tr>\n\n";
	const text = baseText.replace("#### MAJOR", block + "#### MAJOR");
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/raw HTML issue-table/,
		"bare HTML row",
	);
}

// ---------------------------------------------------------------------------
// AC-29: CommonMark visible-text header normalization
// ---------------------------------------------------------------------------

console.log("AC-29a: da_commonmark_visible_issue_header_fails");
{
	const headers = [
		"| ID | Issue | [Evidence Anchor][anchor] |",
		"| \\# | Issue | Evidence |",
		'| ID | Issue | <span title="x>y">Evidence Anchor</span> |',
	];
	let n = 0;
	for (const header of headers) {
		n++;
		const baseText = report_text("da");
		const text = baseText.replace(
			"#### MAJOR",
			`#### ADDITIONAL CRITICAL FINDINGS\n${header}\n|---|-------|-----------------|\n| C9 | impossible df | text: "n=41" p. 4 |\n\n#### MAJOR`,
		);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			/unexpected issue-table/,
			`commonmark visible header #${n}`,
		);
	}
}

console.log("AC-29b: da_balanced_link_destination_header_fails");
{
	const baseText = report_text("da");
	const header =
		"| [\\#](<https://x.test/a(b)>) | Issue | " +
		"[Evidence Anchor](<https://x.test/a(b)>) |";
	const text = baseText.replace(
		"#### MAJOR",
		`#### ADDITIONAL CRITICAL FINDINGS\n${header}\n|---|-------|-----------------|\n| C9 | impossible df | text: "n=41" p. 4 |\n\n#### MAJOR`,
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/unexpected issue-table/,
		"balanced link destination header",
	);
}

console.log("AC-29c: da_partial_or_formatted_issue_header_fails");
{
	const headers = [
		"| ID | Issue | Evidence Anchor |",
		"| # | Issue | Evidence |",
		"| **#** | Issue | **Evidence Anchor** |",
		"| `#` | Issue | `Evidence Anchor` |",
	];
	let n = 0;
	for (const header of headers) {
		n++;
		const baseText = report_text("da");
		const text = baseText.replace(
			"#### MAJOR",
			`#### ADDITIONAL CRITICAL FINDINGS\n${header}\n|---|-------|-----------------|\n| C9 | impossible df | text: "n=41" p. 4 |\n\n#### MAJOR`,
		);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			/unexpected issue-table/,
			`partial/formatted header #${n}`,
		);
	}
}

console.log("AC-29d: da_typed_anchor_payload_alone_fails");
{
	const baseText = report_text("da");
	const header =
		"| [\\#](<https://x.test/a(b)>) | Issue | " +
		"[Evidence Anchor](<https://x.test/a(b)>) |";
	const text = baseText.replace(
		"#### MAJOR",
		`#### ADDITIONAL CRITICAL FINDINGS\n${header}\n|---|-------|-----------------|\n| 1 | impossible df | \`text: "n=41" p. 4\` |\n\n#### MAJOR`,
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/unexpected issue-table/,
		"typed anchor payload alone",
	);
}

// ---------------------------------------------------------------------------
// AC-30: escaped-pipe handling
// ---------------------------------------------------------------------------

console.log("AC-30: da_canonical_rows_allow_escaped_pipes");
{
	let text = report_text("da", undefined, ["C1"]).replace(
		"| C1 | Issue |",
		"| C1 | Issue \\| detail |",
	);
	text += '\n| M1 | Issue \\| detail | text: "quoted evidence" p. 1 |';
	const [critical, major] = parse_da_tables(text, "da.md");
	check("critical has C1", Object.keys(critical).length === 1 && "C1" in critical);
	check('major anchor extracted', major.length === 1 && major[0] === 'text: "quoted evidence" p. 1');
}

// ---------------------------------------------------------------------------
// AC-31: invisible & fullwidth character detection
// ---------------------------------------------------------------------------

console.log("AC-31a: da_invisible_issue_payload_fails");
for (const invisible of ["\u0600", "\u200b", "\u034f", "\ufe0e", "\u3164", "\ufff0"]) {
	const baseText = report_text("da");
	const block =
		"#### ADDITIONAL CRITICAL FINDINGS\n" +
		`| #${invisible} | Issue | Evidence${invisible} Anchor |\n` +
		"|---|---|---|\n" +
		`| C${invisible}9 | impossible df | text${invisible}: "n=41" p. 4 |\n\n`;
	const text = baseText.replace("#### MAJOR", block + "#### MAJOR");
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/unexpected issue-table/,
		`invisible char U+${invisible.codePointAt(0)!.toString(16).toUpperCase()}`,
	);
}

console.log("AC-31b: da_fullwidth_issue_payload_fails");
{
	const baseText = report_text("da");
	const block =
		"#### ADDITIONAL CRITICAL FINDINGS\n" +
		"| \uFF03 | Issue | \uFF25\uFF56\uFF49\uFF44\uFF45\uFF4E\uFF43\uFF45 \uFF21\uFF4E\uFF43\uFF48\uFF4F\uFF52 |\n" +
		"|---|---|---|\n" +
		"| \uFF23\uFF19 | impossible df | \uFF54\uFF45\uFF58\uFF54\uFF1A \"n=41\" p. 4 |\n\n";
	const text = baseText.replace("#### MAJOR", block + "#### MAJOR");
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/unexpected issue-table/,
		"fullwidth shadow header",
	);
}

// ---------------------------------------------------------------------------
// AC-32: evidence-anchor validation wired into DA tables
// ---------------------------------------------------------------------------

console.log("AC-32a: da_empty_critical_anchor_fails");
{
	const baseText = report_text("da", undefined, ["C1"]);
	const text = baseText.replace(
		'| C1 | Issue | text: "quoted evidence" p. 1 |',
		"| C1 | Issue |  |",
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/ANCHOR-MISSING/,
		"empty CRITICAL anchor",
	);
}

console.log("AC-32b: da_major_anchor_fails");
{
	const cases: [string, string][] = [
		["", "ANCHOR-MISSING"],
		["see page 3", "ANCHOR-INVALID"],
	];
	for (const [anchor, fragment] of cases) {
		const baseText = report_text("da");
		const marker = "|---|-------|-----------------|";
		const idx = baseText.lastIndexOf(marker);
		const text =
			baseText.slice(0, idx + marker.length) +
			`\n| M1 | Issue | ${anchor} |` +
			baseText.slice(idx + marker.length);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			new RegExp(fragment),
			`MAJOR anchor "${anchor || "(empty)"}" → ${fragment}`,
		);
	}
}

console.log("AC-32c: da_valid_major_anchor_passes");
{
	const baseText = report_text("da");
	const marker = "|---|-------|-----------------|";
	const idx = baseText.lastIndexOf(marker);
	const text =
		baseText.slice(0, idx + marker.length) +
		'\n| M1 | Issue | text: "short quote" |' +
		baseText.slice(idx + marker.length);
	assertNoThrow(
		() => parse_da_tables(text, "da.md"),
		"valid MAJOR anchor passes",
	);
}

console.log("AC-32d: da_repeated_absence_separators_fail");
{
	const malformed =
		"absence: Methods \u2014 expected ; checked appendix " +
		"\u2014 expected ethics; checked supplement";
	const text = report_text("da", undefined, ["C1"]).replace(
		'text: "quoted evidence" p. 1',
		malformed,
	);
	assertReportError(
		() => parse_da_tables(text, "da.md"),
		/ANCHOR-INVALID/,
		"repeated absence separators",
	);
}

console.log("AC-32e: da_misordered_absence_or_padded_wrapper_fails");
{
	const malformedAnchors = [
		"absence: Methods; checked appendix \u2014 expected ethics",
		'[ text: \u00a75 "short exact quote" ]',
		"equation: Eq. ]3[",
	];
	let n = 0;
	for (const malformed of malformedAnchors) {
		n++;
		const text = report_text("da", undefined, ["C1"]).replace(
			'text: "quoted evidence" p. 1',
			malformed,
		);
		assertReportError(
			() => parse_da_tables(text, "da.md"),
			/ANCHOR-INVALID/,
			`malformed anchor #${n}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
