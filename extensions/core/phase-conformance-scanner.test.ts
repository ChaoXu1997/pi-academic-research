// Unit tests for the phase-conformance dissent scanner (slice 4).
// Run via: tsc -p tsconfig.test.json && node .test-build/core/phase-conformance-scanner.test.js
//
// These tests port the scanner test groups from the upstream Python oracle
// (upstream/scripts/test_check_phase_conformance.py):
//   * AC-46 — _comment_state_after ORDER resolution (~30 cases)
//   * AC-47 — CommonMark empty comments hide nothing
//   * AC-48 — comment reopened on opening/closing line still hides
//   * AC-49 — container-prefixed openers still hide (14 variants)
//   * AC-50 — indented markers are code (9 variants, _expandtabs4 column math)
//   * AC-51 — only start-at-1 ordered markers interrupt a paragraph
//   * AC-52 — paragraph-closing line restores every marker
//   * AC-53 — comment/setext/orphan/lone-bullet state rules
//   * AC-54 — exotic whitespace is not a blank line
//   * AC-55 — fence hiding channel + fence state agreement
//   * AC-56 — HTML comment hiding channel
//   * AC-57 — field-shaped H2 heading hiding channel
//   * AC-58 — commented heading ends span (accepted miss)
//   * AC-59 — comment/fence/inline-code markers inert in containers
//   * AC-60 — decoration-agnostic field-shape detection
//   * AC-61 — prose carrying a colon stays tolerated (English + CJK)
//   * AC-62 — declared limits (accepted misses)
//   * AC-63 — diagnostic counts fenced placeholder prose
//   * AC-64 — bulleted multi-dissent cannot bypass cardinality gate
//   * AC-44 — non-canonical field shapes abort (fences/comments/headings/decoration)
//   * AC-45 — canonical dissent cannot hide a second laundered one

import {
	parse_dissent_dimensions,
	_comment_state_after,
	_lines_with_fence_state,
} from "./phase-conformance-core.js";
import { strip_fences } from "./reviewer-gate-core.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// From .test-build/core/ → project root is ../../
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

// ---------------------------------------------------------------------------
// Test helpers (ported from upstream)
// ---------------------------------------------------------------------------

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

function phase2WithDissentSection(
	bodyLines: string[],
	opts: {
		late?: boolean;
		role?: string;
		overrides?: Record<string, string>;
	} = {},
): string {
	const { late = false, role = "methodology", overrides = null } = opts;
	const text = phase2Text(role, overrides);
	const section =
		["## Scoring Plan Dissent", "", ...bodyLines, ""].join("\n") + "\n";
	const anchor = late ? "## Review Body" : "## Dimension Scores";
	return text.replace(anchor, `${section}${anchor}`);
}

// ===========================================================================
// AC-46: _comment_state_after resolves by ORDER not presence (~30 cases)
// ===========================================================================

console.log("\nAC-46: _comment_state_after ORDER resolution");
{
	const cases: Array<[string, boolean, boolean]> = [
		["<!--", false, true],
		["- <!--", false, true],
		["> <!--", false, true],
		["1. <!--", false, true],
		["- <!-- a -->", false, false],
		["- text <!--", false, false],
		["    <!--", false, false],
		["    - <!--", false, false],
		["     > <!--", false, false],
		["-     <!--", false, false],
		[">     <!--", false, false],
		["   - <!--", false, true],
		[">    <!--", false, true],
		["- `<!--`", false, false],
		["<!-->", false, false],
		["<!--->", false, false],
		["<!-- -->", false, false],
		["<!--x-->", false, false],
		["<!-- a --> <!--", false, true],
		["<!-- a --><!--", false, true],
		["<!-- a --> <!-- b -->", false, false],
		["   <!--", false, true],
		["    <!--", false, false],
		["prose <!--", false, false],
		["plain prose", false, false],
		["still inside", true, true],
		["--> out", true, false],
		["--> out <!--", true, true],
		["-->", true, false],
	];
	for (const [line, entering, expected] of cases) {
		check(
			`(${entering ? "in" : "out"}) ${JSON.stringify(line)} → ${expected}`,
			_comment_state_after(line, entering) === expected,
		);
	}
}

// ===========================================================================
// AC-47: CommonMark empty comments hide nothing after
// ===========================================================================

console.log("\nAC-47: CommonMark empty comments hide nothing");
{
	for (const emptyComment of ["<!-->", "<!--->", "<!-- -->"]) {
		const text = phase2WithDissentSection([
			emptyComment,
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		const dims = parse_dissent_dimensions(text).dimensions;
		check(`empty ${JSON.stringify(emptyComment)} → D1 visible`, dims.has("D1"));
	}
	// Closed and reopened then closed
	{
		const text = phase2WithDissentSection([
			"<!-- drafted --> <!-- reviewed -->",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			"closed-reopened-closed → D1 visible",
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
}

// ===========================================================================
// AC-48: Comment reopened on its opening/closing line still hides
// ===========================================================================

console.log("\nAC-48: Comment reopened on opening/closing line still hides");
{
	for (const openerLine of [
		"<!-- an aside --> <!--",
		"<!-- an aside --><!--",
	]) {
		const text = phase2WithDissentSection([
			openerLine,
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"-->",
		]);
		check(
			`reopened on opening line ${JSON.stringify(openerLine)} → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	{
		const text = phase2WithDissentSection([
			"<!--",
			"an aside",
			"--> visible again <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"-->",
		]);
		check(
			"reopened on closing line → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// AC-49: Container-prefixed openers still hide (14 variants)
// ===========================================================================

console.log("\nAC-49: Container-prefixed openers still hide");
{
	const openers = [
		"- <!--",
		"* <!--",
		"+ <!--",
		"1. <!--",
		"1) <!--",
		"> <!--",
		"> - <!--",
		"  - <!--",
		"-   <!--",
		"-    <!--",
		">   <!--",
		">    <!--",
		">\t<!--",
		" >\t<!--",
	];
	for (const opener of openers) {
		const text = phase2WithDissentSection([
			opener,
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`opener ${JSON.stringify(opener)} → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// AC-50: Indented container markers are code, not comment (9 variants)
// ===========================================================================

console.log("\nAC-50: Indented markers are code (tab expansion)");
{
	const indented = [
		"    - <!-- a draft this seat withdrew",
		"     > <!--",
		"    1. <!--",
		"\t- <!--",
		"-     <!--",
		">     <!--",
		"> - \t<!--",
		"  - \t<!--",
		" 1. \t<!--",
	];
	for (const line of indented) {
		const text = phase2WithDissentSection([
			line,
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`indented ${JSON.stringify(line)} → D1 visible`,
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Also indented comment marker
	{
		const text = phase2WithDissentSection([
			"    <!-- an indented example with no closer",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			"indented comment marker → D1 visible",
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
}

// ===========================================================================
// AC-51: Only start-at-1 ordered markers interrupt a paragraph
// ===========================================================================

console.log("\nAC-51: Ordered marker paragraph interruption");
{
	// Non-1 ordered marker after paragraph does NOT hide
	for (const marker of ["2.", "9)", "10.", "  2."]) {
		const text = phase2WithDissentSection([
			"Reviewed the plan and stand by it.",
			`${marker} <!--`,
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`non-1 ${marker} after paragraph → D1 visible`,
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Paragraph-interrupting markers DO hide (at block start)
	for (const marker of ["1.", "1)", "2.", "10.", "-", ">"]) {
		const text = phase2WithDissentSection([
			`${marker} <!--`,
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`block-start ${marker} → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Paragraph-interrupting markers from within paragraph
	for (const marker of ["1.", "1)", "-", "*", ">"]) {
		const text = phase2WithDissentSection([
			"Reviewed the plan and stand by it.",
			`${marker} <!--`,
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`interrupting ${marker} from paragraph → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// AC-52: Paragraph-closing line restores every marker
// ===========================================================================

console.log("\nAC-52: Paragraph-closing line restores marker");
{
	const closers: Array<[string, string]> = [
		["---", "2."],
		["***", "9)"],
		["___", "10."],
		["### an aside", "2."],
		["#### deeper", "2."],
		["#", "2."],
		["-", "2."],
	];
	for (const [closer, marker] of closers) {
		const text = phase2WithDissentSection([
			"Reviewed the plan and stand by it.",
			closer,
			`${marker} <!--`,
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"<!-- -->",
		]);
		check(
			`closer ${JSON.stringify(closer)} + ${marker} → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// AC-53: Comment block / setext / lone-bullet / lone-marker state rules
// ===========================================================================

console.log("\nAC-53: Comment/setext/orphan/lone-bullet state rules");
{
	// Comment block → block start
	for (const block of [
		["<!-- an aside -->"],
		["<!--", "an aside", "-->"],
		["<!-- an aside", "-->"],
	]) {
		const text = phase2WithDissentSection([
			...block,
			"2. <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`comment block ${JSON.stringify(block[0])} → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Orphan setext → paragraph text
	for (const orphan of ["==", "--", "=", "===="]) {
		const text = phase2WithDissentSection([
			orphan,
			"2. <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`orphan setext ${JSON.stringify(orphan)} → D1 visible`,
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Lone bullet at block start → empty list item
	for (const marker of ["-", "*", "+"]) {
		const text = phase2WithDissentSection([
			marker,
			"2. <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`lone bullet ${marker} → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Lone marker cannot interrupt a paragraph
	for (const marker of ["*", "+", "2.", "10)"]) {
		const text = phase2WithDissentSection([
			"Standing by the plan.",
			marker,
			"2. <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`lone marker ${marker} after paragraph → D1 visible`,
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Setext underline closes paragraph above
	{
		const text = phase2WithDissentSection([
			"An underlined heading",
			"===",
			"2. <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"<!-- -->",
		]);
		check(
			"setext underline → 2. aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// AC-54: Exotic whitespace is not a blank line
// ===========================================================================

console.log("\nAC-54: Exotic whitespace is not blank");
{
	for (const ws of ["\u3000", "\u00a0", "\u2003", "\x0c"]) {
		const text = phase2WithDissentSection([
			"Reviewed the plan and stand by it.",
			ws,
			"2. <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`whitespace ${JSON.stringify(ws)} → D1 visible`,
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
}

// ===========================================================================
// AC-55: Fence hiding channel + fence state agreement
// ===========================================================================

console.log("\nAC-55: Fence hiding channel");
{
	// Fenced heading does not end scanned span
	{
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"```",
			"## Notes",
			"dimension_id: D3",
			"rationale: second plan was inadequate",
			"```",
		]);
		check(
			"fenced heading → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Fenced structural heading (3 fence chars)
	for (const fence of ["```", "~~~", "````"]) {
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: plan was inadequate",
			fence,
			"## Dimension Scores",
			"dimension_id: D3",
			"rationale: second plan was inadequate",
			fence,
		]);
		check(
			`fenced structural heading ${fence} → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Backtick fence with backtick info string is NOT a fence
	{
		const text = phase2WithDissentSection([
			"```py`",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			"backtick info fence → D1 visible",
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Local fence state agrees with shared stripper (7 samples)
	{
		const samples = [
			"a\n```\nb\n```\nc",
			"a\n~~~\nb\n~~~\nc",
			"a\n````\nb\n```\nc\n````\nd",
			"a\n```py`\nb\n",
			"a\n   ```\nb\n```\nc",
			"a\n```\nb",
			"x\r\ny\n```\nz\n```\n",
		];
		for (const sample of samples) {
			const unfenced = _lines_with_fence_state(sample)
				.filter(([, f]) => !f)
				.map(([l]) => l);
			check(
				`fence state agrees ${JSON.stringify(sample)}`,
				JSON.stringify(unfenced) === JSON.stringify(strip_fences(sample)),
			);
		}
	}
	// Duplicate field hidden in fence is counted not matched
	{
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"```",
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"```",
		]);
		check(
			"dup field in fence → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// AC-56: HTML comment hiding channel
// ===========================================================================

console.log("\nAC-56: HTML comment hiding channel");
{
	// Commented-out dissent is not credited as one
	{
		const text = phase2WithDissentSection([
			"<!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"-->",
		]);
		check(
			"commented-out dissent → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Comment opened before heading credits no dissent
	{
		const text = phase2Text("methodology").replace(
			"## Dimension Scores",
			"<!--\n\n## Scoring Plan Dissent\n\ndimension_id: D1\n" +
				"rationale: plan was inadequate\n\n-->\n\n## Dimension Scores",
		);
		check(
			"comment before heading → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// AC-57: Field-shaped H2 heading hiding channel
// ===========================================================================

console.log("\nAC-57: Field-shaped H2 heading hiding");
{
	// Field-shaped heading inside span aborts (the "hidden from sanitizers" H2 case)
	{
		const text = phase2WithDissentSection([
			"## dimension_id: D1",
			"## rationale: plan was inadequate",
		]);
		check(
			"field-shaped H2 inside span → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Field-shaped heading OUTSIDE span is not a dissent
	{
		const text = phase2WithDissentSection(["*(omitted)*"]).replace(
			"## Review Body",
			"## Rationale: Additional notes\n\nprose\n\n## Review Body",
		);
		const parsed = parse_dissent_dimensions(text);
		check(
			"field-shaped H2 outside span → no dims",
			parsed.dimensions.size === 0,
		);
		check(
			"field-shaped H2 outside span → 1 diagnostic",
			parsed.diagnostics.length === 1,
		);
	}
}

// ===========================================================================
// AC-58: Commented heading ends span (accepted miss)
// ===========================================================================

console.log("\nAC-58: Commented heading ends span (accepted miss)");
{
	const text = phase2WithDissentSection([
		"<!--",
		"## Notes",
		"dimension_id: D1",
		"rationale: plan was inadequate",
		"-->",
	]);
	const parsed = parse_dissent_dimensions(text);
	check("commented heading → no dims", parsed.dimensions.size === 0);
}

// ===========================================================================
// AC-59: Comment/fence/inline-code markers inert in containers
// ===========================================================================

console.log("\nAC-59: Markers inert in containers");
{
	// Comment marker inside fence doesn't leak span
	{
		const text = phase2WithDissentSection([
			"```",
			"<!-- an unmatched marker in an example",
			"```",
		]).replace(
			"## Review Body\n\n",
			"## Review Body\n\nrationale: the seat explains itself here\n\n",
		);
		const parsed = parse_dissent_dimensions(text);
		check("comment marker in fence → no dims", parsed.dimensions.size === 0);
		check(
			"comment marker in fence → 1 diagnostic",
			parsed.diagnostics.length === 1,
		);
	}
	// Inline code comment marker doesn't open
	{
		const text = phase2WithDissentSection([
			"The literal `<!--` token is discussed here without a closer.",
		]).replace(
			"## Review Body\n\n",
			"## Review Body\n\nrationale: the seat explains itself here\n\n",
		);
		const parsed = parse_dissent_dimensions(text);
		check("inline code marker → no dims", parsed.dimensions.size === 0);
		check("inline code marker → 1 diagnostic", parsed.diagnostics.length === 1);
	}
	// Balanced container-prefixed comment hides nothing after
	{
		const text = phase2WithDissentSection([
			"- <!-- drafted and withdrawn -->",
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			"balanced container comment → D1 visible",
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
}

// ===========================================================================
// AC-60: Decoration-agnostic field-shape detection
// ===========================================================================

console.log("\nAC-60: Decoration-agnostic field-shape");
{
	// Nested-paren link destination is a declared limit (tolerated)
	for (const line of [
		"[dimension_id](https://e/x_(y_(z))w): D1",
		'<span title="x>y">dimension_id</span>: D1',
		"dimension_id&#58; D1",
	]) {
		const text = phase2WithDissentSection([line]);
		check(
			`declared limit ${JSON.stringify(line)} → no dims`,
			parse_dissent_dimensions(text).dimensions.size === 0,
		);
	}
	// One nesting level in link destination still aborts
	{
		const text = phase2WithDissentSection([
			"[dimension_id](https://e/x_(y)z): D1",
		]);
		check(
			"one nesting link → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Angle-bracket field label read as prose
	{
		const text = phase2WithDissentSection(["<dimension_id>: D1"]);
		const parsed = parse_dissent_dimensions(text);
		check("angle-bracket label → no dims", parsed.dimensions.size === 0);
		check(
			"angle-bracket label → 1 diagnostic",
			parsed.diagnostics.length === 1,
		);
	}
}

// ===========================================================================
// AC-61: Prose carrying a colon stays tolerated (English + CJK)
// ===========================================================================

console.log("\nAC-61: Prose with colon tolerated");
{
	const proseLines = [
		"No dissent, so there is no dimension_id: line under this heading.",
		"I dissent from D1: the plan held after all, so nothing is claimed.",
		"Note: the Phase 1 plan holds.",
		"Dissent: none.",
		"\u7121\u7570\u8b70\uff0cdimension_id \u5df2\u7701\u7565\uff1aPhase 1 \u8a08\u753b\u7dad\u6301\u4e0d\u8b8a",
		"\u7570\u8b70\u306a\u3057\uff1adimension_id \u306f\u7701\u7565\u3057\u307e\u3057\u305f\u3002",
		"\uc774\uacac \uc5c6\uc74c: dimension_id \uc904\uc740 \uc0dd\ub7b5\ud588\uc2b5\ub2c8\ub2e4.",
	];
	for (const prose of proseLines) {
		const text = phase2WithDissentSection([prose]);
		const parsed = parse_dissent_dimensions(text);
		check(
			`prose ${JSON.stringify(prose).slice(0, 40)} → no dims`,
			parsed.dimensions.size === 0,
		);
		check(
			`prose ${JSON.stringify(prose).slice(0, 40)} → 1 diag`,
			parsed.diagnostics.length === 1,
		);
	}
	// Canonical rationale may mention comment syntax
	{
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: the seat wrote `<!--` and `-->` in its explanation",
		]);
		check(
			"rationale mentions comment syntax → D1",
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
}

// ===========================================================================
// AC-62: Declared limits (accepted misses)
// ===========================================================================

console.log("\nAC-62: Declared limits (tolerated)");
{
	// Nested marker after paragraph
	for (const nested of ["- 2. <!--", "> 2. <!--", "> - 2. <!--"]) {
		const text = phase2WithDissentSection([
			"Standing by the plan.",
			nested,
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		check(
			`nested marker ${JSON.stringify(nested)} → D1 visible`,
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Opener inside open container
	for (const [container, opener] of [
		["- an earlier note", "2. <!--"],
		["- an earlier note", "    <!--"],
		["- an earlier note", "\t<!--"],
		["- an earlier note", "- 2. <!--"],
		["> an earlier note", "> 2. <!--"],
		["> an earlier note", ">     <!--"],
	] as Array<[string, string]>) {
		const text = phase2WithDissentSection([
			container,
			opener,
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"-->",
		]);
		check(
			`container opener ${JSON.stringify(container)} + ${JSON.stringify(opener)} → D1 visible`,
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Indented opener continuing paragraph
	{
		const text = phase2WithDissentSection([
			"Reviewed the plan and stand by it.",
			"    <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"-->",
		]);
		check(
			"indented continuation → D1 visible",
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Comment opened after prose on its line
	{
		const text = phase2WithDissentSection([
			"an aside <!--",
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"-->",
		]);
		check(
			"comment after prose → D1 visible",
			parse_dissent_dimensions(text).dimensions.has("D1"),
		);
	}
	// Unbackticked marker in rationale
	{
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: the card left an unclosed <!-- marker in its own output",
			"dimension_id: D2",
			"rationale: the second plan was inadequate too",
		]);
		const dims = parse_dissent_dimensions(text).dimensions;
		check("unbackticked marker → D1 visible", dims.has("D1"));
		check("unbackticked marker → D2 visible", dims.has("D2"));
	}
}

// ===========================================================================
// AC-63: Diagnostic counts fenced placeholder prose
// ===========================================================================

console.log("\nAC-63: Diagnostic counts fenced prose");
{
	{
		const text = phase2WithDissentSection([
			"```",
			"(omitted \u2014 the Phase 1 plan holds)",
			"```",
		]);
		const diag = parse_dissent_dimensions(text).diagnostics[0];
		check(
			"fenced prose diagnostic doesn't say 0",
			!diag.includes("0 non-blank line(s)"),
		);
	}
	// Fenced block in Review Body doesn't affect dissent
	{
		const text = phase2WithDissentSection(["*(omitted)*"]).replace(
			"## Review Body",
			"## Review Body\n\n```\ndimension_id: D1\n```",
		);
		const parsed = parse_dissent_dimensions(text);
		check("fenced block elsewhere → no dims", parsed.dimensions.size === 0);
		check("fenced block elsewhere → 1 diag", parsed.diagnostics.length === 1);
	}
	// Wrapper carrying no field stays tolerated
	for (const body of [
		["```", "(omitted \u2014 the Phase 1 plan holds)", "```"],
		["<!-- no dissent; the Phase 1 plan holds -->"],
	]) {
		const text = phase2WithDissentSection(body);
		const parsed = parse_dissent_dimensions(text);
		check(
			`wrapper ${JSON.stringify(body)[0]}... → no dims`,
			parsed.dimensions.size === 0,
		);
		check(
			`wrapper ${JSON.stringify(body)[0]}... → 1 diag`,
			parsed.diagnostics.length === 1,
		);
	}
}

// ===========================================================================
// AC-64: Bulleted multi-dissent cannot bypass cardinality gate
// ===========================================================================

console.log("\nAC-64: Bulleted multi-dissent cardinality gate");
{
	const text = phase2WithDissentSection([
		"- dimension_id: D1",
		"- rationale: first plan was inadequate",
		"- dimension_id: D3",
		"- rationale: second plan was inadequate",
	]);
	check(
		"bulleted multi-dissent → aborts",
		expectThrows(() => parse_dissent_dimensions(text), "canonical unbulleted"),
	);
}

// ===========================================================================
// AC-44: Non-canonical field shapes abort (fences, comments, headings, decoration)
// ===========================================================================

console.log("\nAC-44: Non-canonical field shapes abort");
{
	// Hidden from sanitizers (3 wrappers: fence/comment/heading)
	for (const hidden of [
		["```", "dimension_id: D1", "rationale: plan was inadequate", "```"],
		["<!-- dimension_id: D1 -->", "<!-- rationale: plan was inadequate -->"],
		["## dimension_id: D1", "## rationale: plan was inadequate"],
	]) {
		const text = phase2WithDissentSection(hidden);
		check(
			`hidden ${hidden[0].slice(0, 10)}... → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Non-canonical field shapes (26 variants)
	const fieldLines = [
		"- dimension_id: D1",
		"* dimension_id: D1",
		"+ dimension_id: D1",
		"> dimension_id: D1",
		"1. dimension_id: D1",
		"**dimension_id**: D1",
		"`dimension_id`: D1",
		"  dimension_id: D1",
		"dimension_id\uff1aD1",
		"- [ ] dimension_id: D1",
		"- [x] dimension_id: D1",
		"* [X] rationale: the phase 1 plan was inadequate",
		"| dimension_id: D1 |",
		"[dimension_id]: D1",
		"_dimension_id_: D1",
		"dimension id: D1",
		"- rationale: the phase 1 plan was inadequate",
		"**rationale**: the phase 1 plan was inadequate",
		"| rationale: the phase 1 plan was inadequate |",
		"[dimension_id](#dissent): D1",
		"[rationale][note]: the phase 1 plan was inadequate",
		"<b>dimension_id</b>: D1",
		"[dimension_id](https://example.com/a:b): D1",
		"[rationale](https://example.com): the phase 1 plan was inadequate",
		"> | dimension_id: D1 |",
		"\tdimension_id: D1",
	];
	for (const fieldLine of fieldLines) {
		const text = phase2WithDissentSection([fieldLine]);
		check(
			`field ${JSON.stringify(fieldLine).slice(0, 40)} → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// AC-45: Canonical dissent cannot hide a second laundered one
// ===========================================================================

console.log("\nAC-45: Canonical cannot hide second laundered");
{
	// H2/comment/fence wrappers
	for (const wrapper of [
		["## dimension_id: D3", "## rationale: second plan was inadequate"],
		["<!-- dimension_id: D3 -->", "<!-- rationale: second -->"],
		["```", "dimension_id: D3", "rationale: second", "```"],
	]) {
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: plan was inadequate",
			...wrapper,
		]);
		check(
			`laundered ${wrapper[0].slice(0, 10)}... → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
	// Decorated wrappers
	for (const wrapper of [
		["- dimension_id: D3", "- rationale: second plan was inadequate"],
		["| dimension_id: D3 |", "| rationale: second plan was inadequate |"],
		["- [ ] dimension_id: D3", "- [ ] rationale: second plan was inadequate"],
		["[dimension_id](#d): D3", "[rationale](#d): second plan was inadequate"],
		["[dimension_id](https://e.com): D3", "[rationale](https://e.com): second"],
	]) {
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: plan was inadequate",
			...wrapper,
		]);
		check(
			`decorated ${wrapper[0].slice(0, 20)}... → aborts`,
			expectThrows(
				() => parse_dissent_dimensions(text),
				"canonical unbulleted",
			),
		);
	}
}

// ===========================================================================
// Additional scanner edge cases from upstream
// ===========================================================================

console.log("\nAdditional scanner edge cases");
{
	// Empty dissent section → no dissent + diagnostic
	{
		const text = phase2WithDissentSection([]);
		const parsed = parse_dissent_dimensions(text);
		check("empty section → no dims", parsed.dimensions.size === 0);
		check("empty section → 1 diagnostic", parsed.diagnostics.length === 1);
		check(
			"empty section diagnostic has tag",
			parsed.diagnostics[0].includes("[DISSENT-EMPTY-SECTION:"),
		);
	}
	// Empty section diagnostic reports non-blank line count
	{
		const text = phase2WithDissentSection(["prose one", "", "prose two"]);
		const diag = parse_dissent_dimensions(text).diagnostics[0];
		check("diagnostic has 2 non-blank", diag.includes("2 non-blank line(s)"));
	}
	// Absent dissent section → no diagnostic
	{
		const parsed = parse_dissent_dimensions(phase2Text("methodology"));
		check("absent section → no dims", parsed.dimensions.size === 0);
		check("absent section → no diagnostics", parsed.diagnostics.length === 0);
	}
	// Canonical dissent parses without diagnostic
	{
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: plan was inadequate",
		]);
		const parsed = parse_dissent_dimensions(text);
		check("canonical dissent → D1", parsed.dimensions.has("D1"));
		check(
			"canonical dissent → no diagnostics",
			parsed.diagnostics.length === 0,
		);
	}
	// Placeholder words are not a dissent
	for (const placeholder of ["none", "omitted", "not applicable", "N/A"]) {
		const text = phase2WithDissentSection([placeholder]);
		const parsed = parse_dissent_dimensions(text);
		check(`placeholder ${placeholder} → no dims`, parsed.dimensions.size === 0);
		check(
			`placeholder ${placeholder} → 1 diag`,
			parsed.diagnostics.length === 1,
		);
	}
	// Claimed dissent without dimension_id aborts
	{
		const text = phase2WithDissentSection(["rationale: plan was inadequate"]);
		check(
			"rationale without dim_id → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"must name dimension_id",
			),
		);
	}
	// Duplicate dimension_id aborts
	{
		const text = phase2WithDissentSection([
			"dimension_id: D1",
			"rationale: plan was inadequate",
			"dimension_id: D1",
			"rationale: plan was inadequate again",
		]);
		check(
			"duplicate dim_id → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"duplicate dimension_id",
			),
		);
	}
	// Late dissent after Dimension Scores aborts
	{
		const text = phase2WithDissentSection(
			["dimension_id: D1", "rationale: plan was inadequate"],
			{ late: true },
		);
		check(
			"late dissent → aborts",
			expectThrows(() => parse_dissent_dimensions(text), "must precede"),
		);
	}
	// Duplicate empty dissent headings abort
	{
		let text = phase2WithDissentSection([]);
		text = text.replace(
			"## Scoring Plan Dissent",
			"## Scoring Plan Dissent\n\n## Scoring Plan Dissent",
		);
		check(
			"duplicate dissent heading → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"duplicate ## Scoring Plan Dissent",
			),
		);
	}
	// Dissent requires rationale
	{
		const text = phase2WithDissentSection(["dimension_id: D1"]);
		check(
			"dissent without rationale → aborts",
			expectThrows(
				() => parse_dissent_dimensions(text),
				"requires one rationale",
			),
		);
	}
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
