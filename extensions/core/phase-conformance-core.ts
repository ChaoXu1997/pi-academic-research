/**
 * ARS phase-conformance core — pure TypeScript port of the phase-conformance
 * logic of `upstream/scripts/check_phase_conformance.py`.
 *
 * This module holds ALL phase-conformance-specific pure logic: the Phase 1 plan
 * parser, manuscript blindness checker, dissent raw-span scanner + parser,
 * trigger binding, and evidence anchors. No Pi registration (TOOL/command/audit)
 * — that lives in `extensions/phase-conformance-gate.ts`.
 *
 * Public API (PINNED — design Decision 4): error class (1), types (3),
 * scanner functions (5), check/parse functions (7), constants (10). Everything
 * else is `@internal`.
 *
 * ZERO new npm dependencies. `_expandtabs4()` column-stop helper replaces
 * Python `str.expandtabs(4)`. `NFKC` → `String.normalize("NFKC")`.
 * `str.isalpha` → `/\p{L}/u`. `casefold()` → `toLowerCase()` (D7c boundary).
 * The comment state machine is a VERBATIM line-by-line port (Decision 3).
 */

import {
	ContractError,
	ReportError,
	type ReviewerReport,
	type SprintContract,
	load_contract,
	parse_report,
	parse_da_tables,
	validate_evidence_anchor,
	strip_fences,
	split_sections,
	split_subsections,
	_read_text,
	_COMMONMARK_LINE_END_RE,
	_FENCE_CLOSE_RE,
	_FENCE_OPEN_RE,
	_H2_RE,
	_H3_RE,
	_H4_RE,
	_DIM_H3_RE,
} from "./reviewer-gate-core.js";
import { ROLE_SETS } from "./sprint-contract-core.js";

// Re-export for the gate wrapper (so it only imports from one core module).
export {
	ContractError,
	ReportError,
	load_contract,
	parse_report,
	_read_text,
	ROLE_SETS,
};
export type { ReviewerReport, SprintContract };

// ---------------------------------------------------------------------------
// Exit codes (upstream parity — AC-83 pins these)
// ---------------------------------------------------------------------------

export const EXIT_PASS = 0;
export const EXIT_CONTRACT = 2;
export const EXIT_CONFORMANCE = 3;

// ---------------------------------------------------------------------------
// Pinned public error class
// ---------------------------------------------------------------------------

/** Reviewer conformance failure → exit 3. @public — pinned. */
export class ConformanceError extends Error {}

// ---------------------------------------------------------------------------
// Pinned public types
// ---------------------------------------------------------------------------

/** Phase 1 plan parse result. Frozen per upstream PhaseOnePlan dataclass. @public — pinned. */
export interface PhaseOnePlan {
	commitments: Record<string, Record<string, string | null>>;
	warnings: string[];
}

/** The dissent section as written: every line, plus the commented-out ones. @public — pinned. */
export interface DissentSpan {
	lines: string[];
	hidden_by_comment: string[];
}

/** Dissent parse result. Frozen per upstream DissentParse dataclass. @public — pinned. */
export interface DissentParse {
	dimensions: Set<string>;
	diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Pinned public constants (AC-83 fidelity boundary — 10 constants)
// ---------------------------------------------------------------------------

/** @public — pinned (AC-83). */
export const _METADATA_KEYS: ReadonlySet<string> = new Set([
	"title",
	"field",
	"word_count",
]);

/** @public — pinned (AC-83). */
export const _DISSENT_FIELD_NAMES: ReadonlySet<string> = new Set([
	"dimensionid",
	"rationale",
]);

/** @public — pinned (AC-83). Five field-name regexes. */
export const _FIELD_PATTERNS: Readonly<Record<string, RegExp>> = {
	dimension_id: /^dimension_id: (?<value>D\d+)$/,
	what_to_look_for: /^what_to_look_for: (?<value>\S.*)$/,
	what_triggers_block: /^what_triggers_block: (?<value>\S.*)$/,
	what_triggers_warn: /^what_triggers_warn: (?<value>\S.*)$/,
	what_triggers_fatal: /^what_triggers_fatal: (?<value>\S.*)$/,
};

/** @public — pinned (AC-83). */
export const _SEVERITY_RE =
	/(?:^|\|\s*)\s*(?:[-*]\s*)?\*\*Severity\*\*:\s*(?<severity>Critical|Major|Minor)\b/g;

/** @public — pinned (AC-83). */
export const _ANCHOR_RE =
	/(?:^|\|\s*)\s*(?:[-*]\s*)?\*\*Evidence Anchor\*\*:\s*(?<value>[^|]+)/g;

/** @public — pinned (AC-83). */
export const _FINDING_H3_RE = /^W[1-9]\d*: \S.*$/;

/** @public — pinned (AC-83). */
export const _MARKUP_SPAN_RE =
	/<[^>]*>|\]\((?:[^()]|\([^()]*\))*\)|\]\[[^\]]*\]|\[[ xX]?\]/g;

/** @public — pinned (AC-83). */
export const _CLOSES_PARAGRAPH_RE =
	/^ {0,3}(?:#{1,6}(?:[ \t].*)?$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:-[ \t]*){3,}$|-[ \t]*$)/;

/** @public — pinned (AC-83). */
export const _SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-{2,})[ \t]*$/;

/** @public — pinned (AC-83). */
export const _EMPTY_LIST_ITEM_RE = /^ {0,3}(?:[*+]|\d{1,9}[.)])[ \t]*$/;

// ---------------------------------------------------------------------------
// @internal — supporting regexes
// ---------------------------------------------------------------------------

const _DISSENT_DIM_RE = /^dimension_id: (?<dim>D\d+)\s*$/;
const _DISSENT_RATIONALE_RE = /^rationale: (?<text>\S.*)\s*$/;
const _SEVERITY_DECL_RE = /\*\*Severity(?:\*\*)?\s*:/gi;
const _ANCHOR_DECL_RE = /\*\*Evidence Anchor(?:\*\*)?\s*:/gi;

// A block opener, including one behind list or blockquote markers (see upstream
// comment lines 47–63). The indentation allowances must not add up to four.
// Only an ordered list beginning at 1 may interrupt an open paragraph.
function _container_prefix(ordered: string): string {
	/** Matched against a tab-expanded line, so spaces are the only gap.
	 * Every gap is one unambiguous run (see upstream 15-line rationale). */
	return `(?:(?:[-*+]|${ordered}) {1,4}|> {0,4})*`;
}

const _ANY_ORDERED_MARKER = "\\d{1,9}[.)]";
const _PARAGRAPH_INTERRUPTING_MARKER = "1[.)]";

// Comment opener regex: any ordered marker in the container prefix.
const _COMMENT_OPENER_RE = new RegExp(
	"^ {0,3}" + _container_prefix(_ANY_ORDERED_MARKER) + "<!--",
);
// Paragraph opener regex: only start-at-1 ordered markers in the prefix.
const _PARAGRAPH_OPENER_RE = new RegExp(
	"^ {0,3}" + _container_prefix(_PARAGRAPH_INTERRUPTING_MARKER) + "<!--",
);

// Paragraph-floor separator (zero-content blocks that separate, never count).
const _SEPARATOR_RE = /^#{1,6}(\s|$)|^([-*_])(\s*\2){2,}$|^<!--.*-->$|^[-*+]$/;

// ---------------------------------------------------------------------------
// @internal — TS porting helpers (Decision 7)
// ---------------------------------------------------------------------------

const _IS_ALPHA_RE = /\p{L}/u;

/** @internal — faithful port of str.isalpha for a single character. Uses /\p{L}/u (D7b). */
function _isAlpha(char: string): boolean {
	return _IS_ALPHA_RE.test(char);
}

/** @internal — faithful port of Python str.expandtabs(4). Column-stop math (D7a). */
function _expandtabs4(line: string): string {
	let result = "";
	let column = 0;
	for (const char of line) {
		if (char === "\t") {
			const spaces = 4 - (column % 4);
			result += " ".repeat(spaces);
			column += spaces;
		} else {
			result += char;
			column += 1;
		}
	}
	return result;
}

/** @internal — faithful port of str.casefold + whitespace-collapse. D7c: toLowerCase() boundary. */
function _normalise(text: string): string {
	return text
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 0)
		.join(" ");
}

/** @internal — Python str.partition(sep) equivalent. */
function _partition(s: string, sep: string): [string, string, string] {
	const idx = s.indexOf(sep);
	if (idx === -1) return [s, "", ""];
	return [s.slice(0, idx), sep, s.slice(idx + sep.length)];
}

/** @internal — Python str.splitlines() equivalent (all Unicode line boundaries). */
function _splitlines(text: string): string[] {
	const lines: string[] = [];
	let current = "";
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (char === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
			lines.push(current);
			current = "";
			i += 2;
			continue;
		}
		if (
			char === "\n" ||
			char === "\r" ||
			char === "\v" ||
			char === "\f" ||
			char === "\x1c" ||
			char === "\x1d" ||
			char === "\x1e" ||
			char === "\x85" ||
			char === "\u2028" ||
			char === "\u2029"
		) {
			lines.push(current);
			current = "";
			i++;
			continue;
		}
		current += char;
		i++;
	}
	lines.push(current);
	return lines;
}

/** @internal — find all regex matches (non-stateful, always from position 0). */
function _findAll(line: string, re: RegExp): RegExpExecArray[] {
	const g = new RegExp(
		re.source,
		re.flags.includes("g") ? re.flags : re.flags + "g",
	);
	const results: RegExpExecArray[] = [];
	let m: RegExpExecArray | null;
	while ((m = g.exec(line)) !== null) results.push(m);
	return results;
}

/** @internal — stable JSON stringify with sorted keys (matches json.dumps(sort_keys=True)). */
// Re-export used by the gate wrapper

function _stableStringify(obj: unknown): string {
	if (obj === null) return "null";
	if (typeof obj !== "object") return JSON.stringify(obj);
	if (Array.isArray(obj)) return `[${obj.map(_stableStringify).join(", ")}]`;
	const keys = Object.keys(obj as Record<string, unknown>).sort();
	return `{${keys
		.map(
			(k) =>
				`${JSON.stringify(k)}: ${_stableStringify((obj as Record<string, unknown>)[k])}`,
		)
		.join(", ")}}`;
}

// ---------------------------------------------------------------------------
// Pinned scanner functions (5 — exported for direct AC testing)
// ---------------------------------------------------------------------------

/**
 * Whether the line starts an HTML comment at a block position.
 * Tabs are measured to the next four-column stop (D7a).
 * @public — pinned (AC-49/AC-50/AC-51).
 */
export function _opens_comment(line: string, paragraphOpen: boolean): boolean {
	const pattern = paragraphOpen ? _PARAGRAPH_OPENER_RE : _COMMENT_OPENER_RE;
	return pattern.test(_expandtabs4(line));
}

/**
 * Whether a line ends inside an HTML comment. Resolves delimiters by ORDER not
 * presence. The closer may reuse the opener's last two dashes.
 * @public — pinned (AC-46).
 */
export function _comment_state_after(
	line: string,
	commented: boolean,
	paragraphOpen: boolean = false,
): boolean {
	let index = 0;
	let state = commented;
	if (!state) {
		if (!_opens_comment(line, paragraphOpen)) {
			return false;
		}
		state = true;
		index = line.indexOf("<!--") + 2;
	}
	while (true) {
		const token = state ? "-->" : "<!--";
		const position = line.indexOf(token, index);
		if (position < 0) {
			return state;
		}
		state = !state;
		index = position + token.length;
	}
}

/**
 * Decoration-agnostic dissent-field-shape detection. NFKC-normalizes, strips
 * markup spans, locates the colon, filters letters.
 * @public — pinned (AC-60).
 */
export function _is_dissent_field_shaped(line: string): boolean {
	const stripped = line
		.normalize("NFKC")
		.toLowerCase()
		.replace(_MARKUP_SPAN_RE, "");
	const [head, separator] = _partition(stripped, ":");
	const label = [...head].filter((char) => _isAlpha(char)).join("");
	return separator !== "" && _DISSENT_FIELD_NAMES.has(label);
}

/**
 * Yield every line with whether it sits inside a fenced block.
 * Mirrors strip_fences fence bookkeeping.
 * @public — pinned (AC-55).
 */
export function _lines_with_fence_state(
	text: string,
): Array<[string, boolean]> {
	let fenceChar: string | null = null;
	let fenceLen = 0;
	const result: Array<[string, boolean]> = [];
	for (const line of text.split(_COMMONMARK_LINE_END_RE)) {
		if (fenceChar !== null) {
			const closeMatch = _FENCE_CLOSE_RE.exec(line);
			if (closeMatch) {
				const token = closeMatch.groups!.fence;
				if (token[0] === fenceChar && token.length >= fenceLen) {
					fenceChar = null;
					fenceLen = 0;
					continue;
				}
			}
			result.push([line, true]);
			continue;
		}
		const openMatch = _FENCE_OPEN_RE.exec(line);
		if (openMatch) {
			const token = openMatch.groups!.fence;
			const info = openMatch.groups!.info;
			if (token[0] !== "`" || !info.includes("`")) {
				fenceChar = token[0];
				fenceLen = token.length;
				continue;
			}
		}
		result.push([line, false]);
	}
	return result;
}

/**
 * Dissent-section lines as written, before any sanitizer runs.
 * Comment delimiters are opened up rather than dropped. A field-shaped H2
 * immediately inside the span rides along. Only an unfenced heading delimits.
 * @public — pinned.
 */
export function _raw_dissent_span(text: string): DissentSpan {
	const span: string[] = [];
	const hiddenByComment: string[] = [];
	let inside = false;
	let commented = false;
	let paragraphOpen = false;
	for (const [line, fenced] of _lines_with_fence_state(text)) {
		const enteredCommented = commented;
		const opensComment: boolean =
			!fenced && _opens_comment(line, paragraphOpen);
		if (!fenced) {
			commented = _comment_state_after(line, commented, paragraphOpen);
		}
		if (!fenced) {
			const match = _H2_RE.exec(line);
			if (match) {
				const title = match[1];
				if (inside && _is_dissent_field_shaped(title)) {
					span.push(title);
				} else {
					inside = title === "Scoring Plan Dissent";
				}
				paragraphOpen = false;
				continue;
			}
		}
		const expanded = _expandtabs4(line);
		const stateDependent: RegExp = paragraphOpen
			? _SETEXT_UNDERLINE_RE
			: _EMPTY_LIST_ITEM_RE;
		const closesParagraph: boolean = Boolean(
			_CLOSES_PARAGRAPH_RE.test(expanded) || stateDependent.test(expanded),
		);
		paragraphOpen =
			!fenced &&
			Boolean(line.replace(/^[ \t]+|[ \t]+$/g, "")) &&
			!closesParagraph &&
			!(enteredCommented || opensComment);
		if (inside) {
			if (enteredCommented || opensComment) {
				span.push(line.replace("<!--", " ").replace("-->", " "));
			} else {
				span.push(line);
			}
			if (enteredCommented) {
				hiddenByComment.push(line);
			}
		}
	}
	return { lines: span, hidden_by_comment: hiddenByComment };
}

// ---------------------------------------------------------------------------
// @internal — dissent section diagnostic + Phase 1 field helper
// ---------------------------------------------------------------------------

/** @internal — Counted on the raw span: fenced prose is archived content too. */
function _empty_dissent_section_diagnostic(rawSpan: string[]): string {
	const nonBlank = rawSpan.filter((line) => line.trim()).length;
	return (
		"[DISSENT-EMPTY-SECTION: ## Scoring Plan Dissent spells no dissent " +
		"field; read as no dissent, with full Phase 1 trigger binding " +
		`enforced on every dimension; ${nonBlank} non-blank line(s) present ` +
		"— read the archived response if any narrate a deviation]"
	);
}

/** @internal — consumed by parse_phase1. */
function _one_field(
	lines: string[],
	field: string,
	path: string,
	required: boolean,
	dimensionId: string,
): string | null {
	const hits: string[] = [];
	for (const line of lines) {
		const match = _FIELD_PATTERNS[field].exec(line);
		if (match) hits.push(match.groups!.value);
	}
	const expected = required ? "exactly one" : "at most one";
	if ((required && hits.length !== 1) || (!required && hits.length > 1)) {
		throw new ConformanceError(
			`[PHASE1-GRAMMAR: ${path}: expected ${expected} canonical ` +
				`${field}: line for dimension ${dimensionId}, found ${hits.length}]`,
		);
	}
	return hits.length > 0 ? hits[0] : null;
}

// ---------------------------------------------------------------------------
// Pinned: parse_phase1
// ---------------------------------------------------------------------------

/**
 * Parse + validate a Phase 1 plan. Returns commitments + warnings.
 * @public — pinned.
 */
export function parse_phase1(
	path: string,
	text: string,
	contract: SprintContract,
	role: string,
): PhaseOnePlan {
	const lines = strip_fences(text);
	const [sections, dupes] = split_sections(lines);
	if (dupes.has("Scoring Plan") || !("Scoring Plan" in sections)) {
		throw new ConformanceError(
			`[PHASE1-GRAMMAR: ${path}: exactly one ## Scoring Plan required]`,
		);
	}
	if (
		dupes.has("Contract Paraphrase") ||
		!("Contract Paraphrase" in sections)
	) {
		throw new ConformanceError(
			`[PHASE1-GRAMMAR: ${path}: exactly one ## Contract Paraphrase required]`,
		);
	}
	// BOTH tails must be the marker (raw + fence-stripped).
	const rawLines = _splitlines(text);
	const rawTail = rawLines.reduce(
		(acc, line) => (line.trim() ? line : acc),
		"",
	);
	const fencedTail = lines.reduceRight(
		(acc, line) => (acc ? acc : line.trim() ? line : ""),
		"",
	);
	if (
		rawTail.replace(/[ \t]+$/g, "") !== "[CONTRACT-ACKNOWLEDGED]" ||
		fencedTail.replace(/[ \t]+$/g, "") !== "[CONTRACT-ACKNOWLEDGED]"
	) {
		throw new ConformanceError(
			`[PHASE1-GRAMMAR: ${path}: final nonblank line must be [CONTRACT-ACKNOWLEDGED]]`,
		);
	}
	// Exact H2 sequence.
	const h2Titles = lines
		.filter((line) => line.startsWith("## "))
		.map((line) => line.slice(3).trim());
	if (
		h2Titles.length !== 2 ||
		h2Titles[0] !== "Contract Paraphrase" ||
		h2Titles[1] !== "Scoring Plan"
	) {
		throw new ConformanceError(
			`[PHASE1-GRAMMAR: ${path}: H2 sections must be exactly ` +
				`## Contract Paraphrase then ## Scoring Plan, found ${JSON.stringify(h2Titles)}]`,
		);
	}
	const dimensions: Record<string, Record<string, unknown>> = {};
	for (const d of contract.acceptance_dimensions as Record<string, unknown>[]) {
		dimensions[d.id as string] = d;
	}
	// Paraphrase paragraph floor.
	let paragraphs = 0;
	let inParagraph = false;
	let inComment = false;
	for (const line of sections["Contract Paraphrase"]) {
		const stripped = line.trim();
		if (inComment) {
			if (stripped.includes("-->")) {
				inComment = false;
			}
			inParagraph = false;
			continue;
		}
		if (stripped.startsWith("<!--") && !stripped.includes("-->")) {
			inComment = true;
			inParagraph = false;
			continue;
		}
		if (stripped && !_SEPARATOR_RE.test(stripped)) {
			if (!inParagraph) {
				paragraphs++;
				inParagraph = true;
			}
		} else {
			inParagraph = false;
		}
	}
	const measurementProcedure = (contract.measurement_procedure ?? {}) as Record<
		string,
		unknown
	>;
	const minimum = measurementProcedure.paraphrase_minimum_dimensions;
	const required =
		minimum === "all"
			? Object.keys(dimensions).length
			: typeof minimum === "number"
				? minimum
				: 0;
	if (paragraphs < required) {
		throw new ConformanceError(
			`[PHASE1-GRAMMAR: ${path}: Contract Paraphrase has ${paragraphs} paragraph(s), ` +
				`fewer than the ${required} required]`,
		);
	}
	// Eligible dimensions.
	const eligible = new Set<string>();
	for (const [did, dim] of Object.entries(dimensions)) {
		if ((dim.eligible_roles as string[]).includes(role)) {
			eligible.add(did);
		}
	}
	const [subsections, subsectionDupes] = split_subsections(
		sections["Scoring Plan"],
	);
	if (subsectionDupes.size > 0) {
		throw new ConformanceError(
			`[PHASE1-GRAMMAR: ${path}: duplicate scoring-plan subsection: ` +
				`${[...subsectionDupes].sort().join(", ")}]`,
		);
	}
	const commitments: Record<string, Record<string, string | null>> = {};
	const warnings: string[] = [];
	for (const [title, sublines] of Object.entries(subsections)) {
		const match = _DIM_H3_RE.exec(title);
		if (!match || !(match.groups!.dim in dimensions)) {
			throw new ConformanceError(
				`[PHASE1-GRAMMAR: ${path}: invalid subsection '### ${title}']`,
			);
		}
		const did = match.groups!.dim;
		if (!eligible.has(did)) {
			throw new ConformanceError(
				`[PHASE1-OUT-OF-ROLE: ${path}: role ${role} planned ${did}]`,
			);
		}
		if (match.groups!.name !== dimensions[did].name) {
			throw new ConformanceError(
				`[PHASE1-GRAMMAR: ${path}: ${did} name mismatch]`,
			);
		}
		const fields: Record<string, string | null> = {};
		for (const field of [
			"dimension_id",
			"what_to_look_for",
			"what_triggers_block",
			"what_triggers_warn",
		]) {
			fields[field] = _one_field(sublines, field, path, true, did);
		}
		const mandatory = dimensions[did].priority === "mandatory";
		fields["what_triggers_fatal"] = _one_field(
			sublines,
			"what_triggers_fatal",
			path,
			mandatory,
			did,
		);
		if (!mandatory && fields["what_triggers_fatal"] !== null) {
			throw new ConformanceError(
				`[PHASE1-GRAMMAR: ${path}: what_triggers_fatal is forbidden on non-mandatory dimension ${did}]`,
			);
		}
		if (fields["dimension_id"] !== did) {
			throw new ConformanceError(
				`[PHASE1-GRAMMAR: ${path}: heading ${did} disagrees with dimension_id=${fields["dimension_id"]}]`,
			);
		}
		const triggers = [
			fields["what_triggers_block"]!,
			fields["what_triggers_warn"]!,
		];
		if (mandatory) {
			triggers.push(fields["what_triggers_fatal"]!);
		}
		const normalizedTriggers = triggers.map((t) => _normalise(t));
		if (new Set(normalizedTriggers).size !== triggers.length) {
			throw new ConformanceError(
				`[PHASE1-TRIGGER-COLLISION: ${path}: ${did} trigger commitments must be pairwise distinct]`,
			);
		}
		for (const field of [
			"what_triggers_block",
			"what_triggers_warn",
			"what_triggers_fatal",
		]) {
			const value = fields[field];
			if (
				value !== null &&
				value.split(/\s+/).filter((w) => w.length > 0).length < 8
			) {
				warnings.push(
					`[PHASE1-TRIGGER-SHORT: ${path}: ${did} ${field} has fewer than 8 words]`,
				);
			}
		}
		commitments[did] = fields;
	}
	if (
		new Set(Object.keys(commitments)).size !== eligible.size ||
		![...Object.keys(commitments)].every((d) => eligible.has(d))
	) {
		throw new ConformanceError(
			`[PHASE1-SCOPE: ${path}: planned=${JSON.stringify(Object.keys(commitments).sort())}, ` +
				`eligible=${JSON.stringify([...eligible].sort())}]`,
		);
	}
	return { commitments, warnings };
}

// ---------------------------------------------------------------------------
// Pinned: validate_metadata_envelope + check_manuscript_leakage
// ---------------------------------------------------------------------------

/** @internal — recursively flatten metadata values to strings. */
function _flatten_metadata_values(value: unknown): string[] {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return Object.values(value as Record<string, unknown>).flatMap(
			_flatten_metadata_values,
		);
	}
	if (Array.isArray(value)) {
		return value.flatMap(_flatten_metadata_values);
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return [String(value)];
	}
	return [];
}

/** Validate the {title, field, word_count} metadata envelope. @public — pinned. */
export function validate_metadata_envelope(metadata: unknown): void {
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		Array.isArray(metadata) ||
		new Set(Object.keys(metadata as Record<string, unknown>)).size !== 3 ||
		![...Object.keys(metadata as Record<string, unknown>)].every((k) =>
			_METADATA_KEYS.has(k),
		)
	) {
		const actual =
			typeof metadata === "object" &&
			metadata !== null &&
			!Array.isArray(metadata)
				? JSON.stringify(
						Object.keys(metadata as Record<string, unknown>).sort(),
					)
				: typeof metadata;
		throw new ContractError(
			`[METADATA-INVALID: expected exact title/field/word_count envelope, got ${actual}]`,
		);
	}
	const meta = metadata as Record<string, unknown>;
	if (
		typeof meta.title !== "string" ||
		!(meta.title as string).trim() ||
		typeof meta.field !== "string" ||
		!(meta.field as string).trim() ||
		typeof meta.word_count === "boolean" ||
		typeof meta.word_count !== "number" ||
		!Number.isInteger(meta.word_count) ||
		meta.word_count < 0
	) {
		throw new ContractError(
			"[METADATA-INVALID: title and field must be non-empty strings; " +
				"word_count must be a non-negative integer]",
		);
	}
}

/** Detect 12-word manuscript shingles in Phase 1 (with metadata/contract exemptions). @public — pinned. */
export function check_manuscript_leakage(
	phase1Text: string,
	manuscriptText: string,
	metadata: unknown,
	contract: SprintContract,
): void {
	validate_metadata_envelope(metadata);
	const phase1Norm = _normalise(phase1Text);
	const words = _normalise(manuscriptText)
		.split(/\s+/)
		.filter((w) => w.length > 0);
	const exemptionHaystacks = _flatten_metadata_values(metadata).map(_normalise);
	exemptionHaystacks.push(_normalise(_stableStringify(contract)));
	for (let index = 0; index < Math.max(0, words.length - 11); index++) {
		const shingle = words.slice(index, index + 12).join(" ");
		if (!phase1Norm.includes(shingle)) continue;
		if (exemptionHaystacks.some((haystack) => haystack.includes(shingle)))
			continue;
		throw new ConformanceError(
			"[PHASE1-MANUSCRIPT-LEAK: 12-word manuscript shingle appears " +
				"in Phase 1 outside metadata/contract exemptions]",
		);
	}
}

// ---------------------------------------------------------------------------
// Pinned: parse_dissent_dimensions
// ---------------------------------------------------------------------------

/** Parse the dissent section → dimensions + diagnostics. @public — pinned. */
export function parse_dissent_dimensions(text: string): DissentParse {
	const lines = strip_fences(text);
	const [sections, dupes] = split_sections(lines);
	if (dupes.has("Scoring Plan Dissent")) {
		throw new ConformanceError(
			"[DISSENT-GRAMMAR: duplicate ## Scoring Plan Dissent]",
		);
	}
	if (!("Scoring Plan Dissent" in sections)) {
		return { dimensions: new Set<string>(), diagnostics: [] };
	}
	const body = sections["Scoring Plan Dissent"];
	const span = _raw_dissent_span(text);
	const rawSpan = span.lines;
	// A commented-out field is struck from the canonical parse.
	const outstanding = new Map<string, number>();
	for (const line of span.hidden_by_comment) {
		outstanding.set(line, (outstanding.get(line) ?? 0) + 1);
	}
	const visible: string[] = [];
	for (const line of body) {
		if ((outstanding.get(line) ?? 0) > 0) {
			outstanding.set(line, outstanding.get(line)! - 1);
			continue;
		}
		visible.push(line);
	}
	const parsed = new Map<string, number>();
	for (const line of visible) {
		if (_DISSENT_DIM_RE.test(line) || _DISSENT_RATIONALE_RE.test(line)) {
			parsed.set(line, (parsed.get(line) ?? 0) + 1);
		}
	}
	const dims: string[] = [];
	for (const line of visible) {
		const match = _DISSENT_DIM_RE.exec(line);
		if (match) dims.push(match.groups!.dim);
	}
	const rationales: string[] = [];
	for (const line of visible) {
		const match = _DISSENT_RATIONALE_RE.exec(line);
		if (match) rationales.push(match.groups!.text);
	}
	// Scanned on the RAW span, not the sanitized body.
	const hidden = new Map<string, number>();
	for (const candidate of rawSpan) {
		if (_is_dissent_field_shaped(candidate)) {
			hidden.set(candidate, (hidden.get(candidate) ?? 0) + 1);
		}
	}
	const hiddenExceeds = [...hidden.entries()].some(
		([value, count]) => count > (parsed.get(value) ?? 0),
	);
	const visibleHasUnparsed = visible.some(
		(candidate) =>
			_is_dissent_field_shaped(candidate) && !parsed.has(candidate),
	);
	if (hiddenExceeds || visibleHasUnparsed) {
		throw new ConformanceError(
			"[DISSENT-GRAMMAR: dissent fields must be canonical unbulleted " +
				"dimension_id: and rationale: lines]",
		);
	}
	if (dims.length === 0 && rationales.length === 0) {
		return {
			dimensions: new Set<string>(),
			diagnostics: [_empty_dissent_section_diagnostic(rawSpan)],
		};
	}
	const h2Positions: Record<string, number> = {};
	for (let index = 0; index < lines.length; index++) {
		const match = _H2_RE.exec(lines[index]);
		if (match) {
			h2Positions[match[1]] = index;
		}
	}
	if (
		(h2Positions["Scoring Plan Dissent"] ?? Infinity) >
		(h2Positions["Dimension Scores"] ?? -1)
	) {
		throw new ConformanceError(
			"[DISSENT-GRAMMAR: ## Scoring Plan Dissent must precede ## Dimension Scores]",
		);
	}
	if (dims.length === 0) {
		throw new ConformanceError(
			"[DISSENT-GRAMMAR: dissent section must name dimension_id]",
		);
	}
	if (new Set(dims).size !== dims.length) {
		throw new ConformanceError("[DISSENT-GRAMMAR: duplicate dimension_id]");
	}
	if (rationales.length !== dims.length) {
		throw new ConformanceError(
			"[DISSENT-GRAMMAR: each dissent requires one rationale: line]",
		);
	}
	return { dimensions: new Set(dims), diagnostics: [] };
}

// ---------------------------------------------------------------------------
// Pinned: check_trigger_binding
// ---------------------------------------------------------------------------

/** Enforce trigger binding (drift, ambiguity, required-iff, dissent cap ≤1, fatality). @public — pinned. */
export function check_trigger_binding(
	report: ReviewerReport,
	plan: PhaseOnePlan,
	dimensions: Record<string, Record<string, unknown>>,
	dissent: Set<string>,
): void {
	if (dissent.size >= 2) {
		throw new ConformanceError(
			`[PROTOCOL-VIOLATION: multi_dissent=true, dimensions=${JSON.stringify([...dissent].sort())}]`,
		);
	}
	const unknown = [...dissent].filter((d) => !(d in dimensions));
	if (unknown.length > 0) {
		throw new ConformanceError(
			`[DISSENT-GRAMMAR: unknown dimensions ${JSON.stringify(unknown.sort())}]`,
		);
	}
	const uncommitted = [...dissent].filter((d) => !(d in plan.commitments));
	if (uncommitted.length > 0) {
		throw new ConformanceError(
			`[DISSENT-GRAMMAR: dissent dimensions were not committed by this seat ${JSON.stringify(uncommitted.sort())}]`,
		);
	}
	for (const [did, value] of Object.entries(report.scores)) {
		const eligible = (dimensions[did].eligible_roles as string[]).includes(
			report.role,
		);
		const needsTrigger =
			eligible && (value.score === "block" || value.score === "warn");
		if (needsTrigger !== Boolean(value.trigger)) {
			throw new ConformanceError(
				`[TRIGGER-GRAMMAR: ${report.path}: ${did} trigger is required iff an eligible dimension scores block or warn]`,
			);
		}
		if (dissent.has(did)) {
			if (value.block_class === "fatal") {
				throw new ConformanceError(
					`[DISSENT-FATALITY: ${did} dissent may not mint fatality]`,
				);
			}
			continue;
		}
		if (!value.trigger) continue;
		let field: string;
		if (value.score === "warn") {
			field = "what_triggers_warn";
		} else if (value.block_class === "fatal") {
			field = "what_triggers_fatal";
		} else {
			field = "what_triggers_block";
		}
		const committed = plan.commitments[did]?.[field];
		if (
			!committed ||
			!_normalise(committed).includes(_normalise(value.trigger))
		) {
			throw new ConformanceError(
				`[TRIGGER-DRIFT: ${did} ${field} does not contain emitted trigger text]`,
			);
		}
		const matchingFields = new Set<string>();
		for (const candidate of [
			"what_triggers_block",
			"what_triggers_warn",
			"what_triggers_fatal",
		]) {
			const candidateValue = plan.commitments[did]?.[candidate];
			if (
				candidateValue &&
				_normalise(candidateValue).includes(_normalise(value.trigger))
			) {
				matchingFields.add(candidate);
			}
		}
		if (matchingFields.size !== 1 || !matchingFields.has(field)) {
			throw new ConformanceError(
				`[TRIGGER-AMBIGUOUS: ${did} emitted trigger matches ${JSON.stringify([...matchingFields].sort())}, expected only ${JSON.stringify([field])}]`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Pinned: _validate_anchor + check_scoring_seat_anchors
// ---------------------------------------------------------------------------

/** @internal — wraps validate_evidence_anchor → catches ReportError → ConformanceError. */
function _validate_anchor(anchor: string, context: string): void {
	try {
		validate_evidence_anchor(anchor, context);
	} catch (exc) {
		if (exc instanceof ReportError) {
			throw new ConformanceError((exc as Error).message);
		}
		throw exc;
	}
}

/** Enforce scoring-seat evidence anchors (Severity + Evidence Anchor per finding). @public — pinned. */
export function check_scoring_seat_anchors(report: ReviewerReport): void {
	const lines = strip_fences(report.text);
	const [sections, sectionDupes] = split_sections(lines);
	if ("Review Body" in sectionDupes || !("Review Body" in sections)) {
		throw new ConformanceError(`[REVIEW-BODY-MISSING: ${report.path}]`);
	}
	let currentH2: string | null = null;
	for (const line of lines) {
		const match = _H2_RE.exec(line);
		if (match) {
			currentH2 = match[1];
		} else if (
			line.search(_SEVERITY_DECL_RE) !== -1 &&
			currentH2 !== "Review Body"
		) {
			throw new ConformanceError(
				`[FINDING-GRAMMAR: ${report.path}: Severity outside ## Review Body]`,
			);
		}
	}
	const reviewLines = sections["Review Body"];
	const [blocks, subsectionDupes] = split_subsections(reviewLines);
	if (subsectionDupes.size > 0) {
		throw new ConformanceError(
			`[FINDING-GRAMMAR: ${report.path}: duplicate finding heading]`,
		);
	}
	const preamble: string[] = [];
	for (const line of reviewLines) {
		if (_H3_RE.test(line)) break;
		preamble.push(line);
	}
	if (preamble.some((line) => line.search(_SEVERITY_DECL_RE) !== -1)) {
		throw new ConformanceError(
			`[FINDING-GRAMMAR: ${report.path}: every finding with Severity must have its own ### finding heading]`,
		);
	}
	for (const [title, block] of Object.entries(blocks)) {
		let severityDeclarations = 0;
		for (const line of block) {
			severityDeclarations += _findAll(line, _SEVERITY_DECL_RE).length;
		}
		const severities: string[] = [];
		for (const line of block) {
			for (const m of _findAll(line, _SEVERITY_RE)) {
				severities.push(m.groups!.severity);
			}
		}
		const isFinding = _FINDING_H3_RE.test(title);
		if (severityDeclarations > 0 && !isFinding) {
			throw new ConformanceError(
				`[FINDING-GRAMMAR: ${report.path}: every finding with Severity must have its own ### W<n>: <title> heading]`,
			);
		}
		if (isFinding && block.some((line) => _H4_RE.test(line))) {
			throw new ConformanceError(
				`[FINDING-GRAMMAR: ${report.path}: ${title} may not nest a Severity finding under H4]`,
			);
		}
		if (!isFinding) continue;
		if (severities.length !== 1 || severityDeclarations !== 1) {
			throw new ConformanceError(
				`[FINDING-GRAMMAR: ${report.path}: ${title} must contain exactly one parseable Severity declaration]`,
			);
		}
		let anchorDeclarations = 0;
		for (const line of block) {
			anchorDeclarations += _findAll(line, _ANCHOR_DECL_RE).length;
		}
		const anchors: string[] = [];
		for (const line of block) {
			for (const m of _findAll(line, _ANCHOR_RE)) {
				anchors.push(m.groups!.value);
			}
		}
		if (severities[0] !== "Critical" && severities[0] !== "Major") {
			if (anchorDeclarations > 1 || anchors.length !== anchorDeclarations) {
				throw new ConformanceError(
					`[FINDING-GRAMMAR: ${report.path}: ${title} may contain at most one parseable Evidence Anchor declaration]`,
				);
			}
			if (anchors.length > 0) {
				_validate_anchor(anchors[0].trim(), `${report.path}:${title}`);
			}
			continue;
		}
		if (anchors.length !== 1 || anchorDeclarations !== 1) {
			throw new ConformanceError(
				`[ANCHOR-MISSING: ${report.path}: ${title} ${severities[0]} finding needs exactly one Evidence Anchor]`,
			);
		}
		_validate_anchor(anchors[0].trim(), `${report.path}:${title}`);
	}
}

// ---------------------------------------------------------------------------
// Pinned: check_da_anchors
// ---------------------------------------------------------------------------

/** Enforce DA evidence anchors via the shared parse_da_tables. @public — pinned. */
export function check_da_anchors(report: ReviewerReport): void {
	let rows: Record<string, string>;
	let majorAnchors: string[];
	try {
		[rows, majorAnchors] = parse_da_tables(report.text, report.path);
	} catch (exc) {
		if (exc instanceof ReportError) {
			throw new ConformanceError((exc as Error).message);
		}
		throw exc;
	}
	const expected = Object.keys(rows).map((_, i) => `C${i + 1}`);
	const actual = Object.keys(rows);
	if (
		actual.length !== expected.length ||
		!actual.every((v, i) => v === expected[i])
	) {
		throw new ConformanceError(
			`[DA-CRITICAL-ID: ${report.path}: IDs must be dense C1..Cn; got=${JSON.stringify(actual)}]`,
		);
	}
	for (const [findingId, anchor] of Object.entries(rows)) {
		if (!anchor) {
			throw new ConformanceError(
				`[ANCHOR-MISSING: ${report.path}: ${findingId}]`,
			);
		}
		_validate_anchor(anchor, `${report.path}:${findingId}`);
	}
	for (const anchor of majorAnchors) {
		if (!anchor) {
			throw new ConformanceError(
				`[ANCHOR-MISSING: ${report.path}: DA MAJOR row]`,
			);
		}
		_validate_anchor(anchor, `${report.path}:DA MAJOR`);
	}
}
