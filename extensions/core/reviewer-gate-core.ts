/**
 * ARS reviewer-gate shared core — pure TypeScript port of the shared markdown /
 * contract / report / DA-table / expression-grammar portions of
 * `upstream/scripts/check_panel_synthesis.py`.
 *
 * This module holds the shared parsing/validation surface consumed by both the
 * panel-synthesis gate (slice 3b) and the phase-conformance gate (slice 4). It
 * deliberately excludes panel evaluation, synthesis verification, DA-CRITICAL
 * gate logic, CLI / TOOL / command wiring — those belong to 3b.
 *
 * Public API (PINNED — design Decision 3): error classes (3), types (3 + SprintContract
 * re-export), ~18 regex constants, sentinel constant, expression patterns, markdown
 * helpers (7), anchor validator, DA-table parser (+ compat wrapper), report parser,
 * expression grammar, contract loader, file reader. Everything else is @internal.
 *
 * ZERO new npm dependencies. HTMLParser → tag-strip + entity decode. NFKC →
 * String.normalize("NFKC"). Cf category → /\p{Cf}/u. Ignorable ranges → const array.
 */

import { readFileSync } from "node:fs";
import {
	validate,
	check_structural_invariants,
	ROLE_SETS,
	EXPECTED_PANEL_SIZE,
	type SprintContract,
} from "./sprint-contract-core.js";

// ---------------------------------------------------------------------------
// Pinned public type re-export
// ---------------------------------------------------------------------------

export type { SprintContract } from "./sprint-contract-core.js";

// ---------------------------------------------------------------------------
// Pinned public types
// ---------------------------------------------------------------------------

/** A single reviewer's score on one acceptance dimension. @public — pinned. */
export interface DimensionScore {
	readonly score: string;
	readonly block_class: string | null;
	readonly trigger: string | null;
	readonly abstain_reason: string | null;
}

/** A parsed reviewer report. @public — pinned. */
export interface ReviewerReport {
	readonly path: string;
	readonly role: string;
	scores: Record<string, DimensionScore>;
	readonly text: string;
}

/** One parsed atom of a failure-condition expression. @public — pinned. */
export interface ExpressionAtom {
	readonly dimension_ids: readonly string[];
	readonly dimension_quantifier: string;
	readonly score: string | null;
	readonly or_worse: boolean;
	readonly fatal: boolean;
}

// ---------------------------------------------------------------------------
// Pinned public error classes
// ---------------------------------------------------------------------------

/** Contract/infra failure → exit 2. @public — pinned. */
export class ContractError extends Error {}

/** Reviewer-report failure → exit 3. @public — pinned. */
export class ReportError extends Error {}

/** Synthesis-output failure → exit 1. @public — pinned (used by 3b). */
export class SynthesisError extends Error {}

// ---------------------------------------------------------------------------
// Pinned public regex constants (18) — ported verbatim from upstream
// ---------------------------------------------------------------------------

export const _FENCE_OPEN_RE = /^ {0,3}(?<fence>`{3,}|~{3,})(?<info>[^\n]*)$/;
export const _FENCE_CLOSE_RE = /^ {0,3}(?<fence>`{3,}|~{3,})[ \t]*$/;
export const _COMMONMARK_LINE_END_RE = /\r\n?|\n/;
export const _H2_RE = /^## (.+?)\s*$/;
export const _H3_RE = /^### (.+?)\s*$/;
export const _H4_RE = /^#### (.+?)\s*$/;
export const _DIM_H3_RE = /^(?<dim>D\d+): (?<name>.+)$/;
export const _ROLE_RE = /^contract_role: (?<role>[a-z_]+)\s*$/;
export const _SCORE_RE = /^score: (?<value>block|warn|pass|not_assessed)\s*$/;
export const _BLOCK_CLASS_RE = /^block_class: (?<value>fatal|repairable)\s*$/;
export const _TRIGGER_RE = /^trigger: "(?<value>[^"\n]+)"\s*$/;
export const _ABSTAIN_RE = /^abstain_reason: (?<value>\S.*)\s*$/;
export const _RETIRED_DECISION_RE = /^\s*editorial_decision=\S+\s*$/i;
export const _DA_SEVERITY_DECL_RE = /\*\*Severity(?:\*\*)?\s*:/i;
export const _DA_ISSUE_ID_RE = /^[CM][1-9]\d*$/i;
export const _DA_TYPED_ANCHOR_RE =
	/^(?:text|table|figure|equation|dataset|absence)\s*:/i;
export const _RAW_HTML_TABLE_RE = /<\s*\/?\s*(?:table|thead|tbody|tr|th|td)\b/i;
export const _HTML_COMMENT_RE = /<!--/;

// ---------------------------------------------------------------------------
// Pinned public sentinel constant
// ---------------------------------------------------------------------------

export const _DA_FENCED_BLOCK_SENTINEL = "\0DA_FENCED_BLOCK\0";

// ---------------------------------------------------------------------------
// Pinned public expression patterns (B8)
// ---------------------------------------------------------------------------

const _SCORE = "'(?<score>block|warn|pass)'";

export const _EXPRESSION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	[
		"any_priority",
		new RegExp(
			"^any (?:(?<p1>[a-z]+) dimension|dimension with priority=" +
				"(?<p2>[a-z]+)|(?<p3>[a-z]+)-priority dimension) scores " +
				_SCORE +
				"$",
		),
	],
	[
		"count_priority",
		new RegExp(
			"^two or more (?:(?<p1>[a-z]+) dimensions|dimensions with priority=" +
				"(?<p2>[a-z]+)) score " +
				_SCORE +
				" or worse$",
		),
	],
	[
		"every_priority",
		new RegExp("^every (?<p1>[a-z]+) dimension scores " + _SCORE + "$"),
	],
	[
		"dim_exact",
		new RegExp("^(?<dim>D\\d+) scores " + _SCORE + "$"),
	],
	["fatal_priority", /^any (?<p1>[a-z]+) dimension has a fatal block$/],
	["fatal_dim", /^(?<dim>D\d+) has a fatal block$/],
	[
		"any_all",
		new RegExp("^any dimension scores " + _SCORE + " or worse$"),
	],
	[
		"dim_threshold",
		new RegExp("^(?<dim>D\\d+) scores " + _SCORE + " or worse$"),
	],
	[
		"every_all",
		new RegExp("^every dimension scores " + _SCORE + "$"),
	],
];

// ---------------------------------------------------------------------------
// @internal — Unicode ignorable ranges + helpers
// ---------------------------------------------------------------------------

/** Ported verbatim from upstream _DEFAULT_IGNORABLE_RANGES. @internal */
const _DEFAULT_IGNORABLE_RANGES: readonly [number, number][] = [
	[0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c],
	[0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
	[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f],
	[0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
	[0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3],
	[0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];

/** Format (Cf) category regex. @internal */
const _FORMAT_CHAR_RE = /\p{Cf}/u;

/** @internal — equivalent to upstream _is_default_ignorable. */
function _is_default_ignorable(char: string): boolean {
	const cp = char.codePointAt(0)!;
	return _DEFAULT_IGNORABLE_RANGES.some(([start, end]) => cp >= start && cp <= end);
}

/** @internal — Python str.split() word count (splits on whitespace, drops empties). */
function _wordCount(text: string): number {
	return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** @internal — Python str.partition(sep) equivalent. */
function _partition(s: string, sep: string): [string, string, string] {
	const idx = s.indexOf(sep);
	if (idx === -1) return [s, "", ""];
	return [s.slice(0, idx), sep, s.slice(idx + sep.length)];
}

// ---------------------------------------------------------------------------
// @internal — visible-text pipeline (HTMLParser → tag-strip + entity decode)
// ---------------------------------------------------------------------------

/**
 * Minimal HTMLParser equivalent: decode common entities then strip tags.
 * Mirrors upstream _VisibleTextHTMLParser with convert_charrefs=True + handle_data.
 * @internal
 */
function _visibleTextFromHtml(html: string): string {
	const text = html
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
			String.fromCodePoint(parseInt(n, 16)),
		);
	return text.replace(/<[^>]*>/g, "");
}

/**
 * Normalize a header cell to its visible text for shadow detection.
 * Faithful port of upstream _rendered_header_cell.
 * @internal
 */
function _rendered_header_cell(cell: string): string {
	let rendered = cell.replace(/\\([^\w\s])/g, "$1");
	rendered = rendered.replace(
		/!?\[([^\]]*)\](?:\([^)]+\)|\[[^\]]*\])/g,
		"$1",
	);
	rendered = rendered.replace(/\[([^\]]+)\]/g, "$1");
	rendered = _visibleTextFromHtml(rendered);
	rendered = rendered.normalize("NFKC");
	rendered = Array.from(rendered)
		.filter(
			(char) => !_FORMAT_CHAR_RE.test(char) && !_is_default_ignorable(char),
		)
		.join("");
	rendered = rendered.replace(/[*_~`]+/g, "");
	return rendered.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// @internal — anchor-grammar helpers
// ---------------------------------------------------------------------------

/** @internal — ordered + balanced square brackets check. */
function _balanced_square_brackets(text: string): boolean {
	let depth = 0;
	for (const char of text) {
		if (char === "[") depth++;
		else if (char === "]") {
			depth--;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

/** @internal — balanced straight/curly excerpt extraction. */
function _quoted_excerpts(text: string): string[] | null {
	const stack: [string, number][] = [];
	const excerpts: string[] = [];
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "\u201c") {
			stack.push(["curly", index + 1]);
		} else if (char === "\u201d") {
			if (stack.length === 0 || stack[stack.length - 1][0] !== "curly")
				return null;
			const [, start] = stack.pop()!;
			excerpts.push(text.slice(start, index));
		} else if (char === '"') {
			if (stack.length > 0 && stack[stack.length - 1][0] === "straight") {
				const [, start] = stack.pop()!;
				excerpts.push(text.slice(start, index));
			} else {
				stack.push(["straight", index + 1]);
			}
		}
	}
	return stack.length > 0 ? null : excerpts;
}

/** @internal — parse the two absence separators. */
function _absence_parts(text: string): [string, string, string] | null {
	const expectedSep = " \u2014 expected ";
	const checkedSep = "; checked ";
	if (text.split(expectedSep).length - 1 !== 1) return null;
	if (text.split(checkedSep).length - 1 !== 1) return null;
	const [where, foundExp, remainder] = _partition(text, expectedSep);
	const [expected, foundChecked, surfaces] = _partition(remainder, checkedSep);
	if (!foundExp || !foundChecked) return null;
	const parts: [string, string, string] = [where, expected, surfaces];
	return parts.every((p) => p.trim()) ? parts : null;
}

/** @internal — typed-anchor regex used by validate_evidence_anchor. */
const _ANCHOR_TYPE_RE =
	/^(?<type>text|table|figure|equation|dataset|absence):\s*(?<tail>\S.*)$/i;

// ---------------------------------------------------------------------------
// @internal — section splitting
// ---------------------------------------------------------------------------

/** @internal — split lines by a heading regex, tracking duplicates. */
function _split_by(
	lines: string[],
	headingRe: RegExp,
): [Record<string, string[]>, Set<string>] {
	const sections: Record<string, string[]> = {};
	const dupes = new Set<string>();
	let current: string[] | null = null;
	for (const line of lines) {
		const match = headingRe.exec(line);
		if (match) {
			const title = match[1];
			if (title in sections) dupes.add(title);
			current = sections[title] ?? (sections[title] = []);
			continue;
		}
		if (current !== null) current.push(line);
	}
	return [sections, dupes];
}

// ---------------------------------------------------------------------------
// Pinned public: markdown helpers
// ---------------------------------------------------------------------------

/**
 * Remove CommonMark fenced-code blocks. When preserveFencedBlocks is true,
 * replaced by _DA_FENCED_BLOCK_SENTINEL instead of dropped.
 * Faithful port of upstream strip_fences.
 * @public — pinned.
 */
export function strip_fences(
	text: string,
	opts?: { preserveFencedBlocks?: boolean },
): string[] {
	const preserve = opts?.preserveFencedBlocks ?? false;
	const out: string[] = [];
	let fenceChar: string | null = null;
	let fenceLen = 0;
	for (const line of text.split(_COMMONMARK_LINE_END_RE)) {
		if (fenceChar !== null) {
			const closeMatch = _FENCE_CLOSE_RE.exec(line);
			if (closeMatch) {
				const token = closeMatch.groups!.fence;
				if (token[0] === fenceChar && token.length >= fenceLen) {
					fenceChar = null;
					fenceLen = 0;
				}
			}
			continue;
		}
		const openMatch = _FENCE_OPEN_RE.exec(line);
		if (openMatch) {
			const token = openMatch.groups!.fence;
			const info = openMatch.groups!.info;
			if (token[0] !== "`" || !info.includes("`")) {
				fenceChar = token[0];
				fenceLen = token.length;
				if (preserve) out.push(_DA_FENCED_BLOCK_SENTINEL);
				continue;
			}
		}
		out.push(line);
	}
	return out;
}

/** Split lines into H2 sections. Returns [sections, duplicateTitles]. @public — pinned. */
export function split_sections(
	lines: string[],
): [Record<string, string[]>, Set<string>] {
	return _split_by(lines, _H2_RE);
}

/** Split lines into H3 subsections. @public — pinned. */
export function split_subsections(
	lines: string[],
): [Record<string, string[]>, Set<string>] {
	return _split_by(lines, _H3_RE);
}

/**
 * Extract exactly one (or at most one) regex match from lines, or raise ReportError.
 * @public — pinned.
 */
export function exactly_one(
	lines: string[],
	pattern: RegExp,
	field: string,
	path: string,
	group: string = "value",
	opts?: { required?: boolean },
): string | null {
	const required = opts?.required ?? true;
	const hits: string[] = [];
	for (const line of lines) {
		const m = pattern.exec(line);
		if (m) {
			const val = m.groups?.[group];
			if (val !== undefined) hits.push(val);
		}
	}
	const expected = required ? "exactly one" : "at most one";
	if ((required && hits.length !== 1) || (!required && hits.length > 1)) {
		throw new ReportError(
			`[REPORT-PARSE: ${path}: expected ${expected} ${field} line, found ${hits.length}]`,
		);
	}
	return hits.length > 0 ? hits[0] : null;
}

/** Split a GFM table row on unescaped pipes. @public — pinned. */
export function _split_gfm_cells(row: string): string[] {
	const cells: string[] = [];
	let current: string[] = [];
	for (const char of row) {
		if (char === "|") {
			let backslashes = 0;
			for (let i = current.length - 1; i >= 0; i--) {
				if (current[i] !== "\\") break;
				backslashes++;
			}
			if (backslashes % 2 === 0) {
				cells.push(current.join("").trim());
				current = [];
				continue;
			}
		}
		current.push(char);
	}
	cells.push(current.join("").trim());
	return cells;
}

/** Parse outer-pipe-delimited GFM cells, or [] if not a table row. @public — pinned. */
export function _markdown_cells(line: string): string[] {
	const stripped = line.trim();
	if (!stripped.startsWith("|") || !stripped.endsWith("|")) return [];
	return _split_gfm_cells(stripped.slice(1, -1));
}

/** Parse cells from outer-pipe OR pipe-less GFM table rows. @public — pinned. */
export function _possible_markdown_cells(line: string): string[] {
	let stripped = line.trim();
	if (!stripped.includes("|")) return [];
	if (stripped.startsWith("|")) stripped = stripped.slice(1);
	if (stripped.endsWith("|")) stripped = stripped.slice(0, -1);
	return _split_gfm_cells(stripped);
}

// ---------------------------------------------------------------------------
// Pinned public: validate_evidence_anchor
// ---------------------------------------------------------------------------

/**
 * Validate the typed finding-anchor grammar. Raises ReportError on invalid/missing.
 * Faithful port of upstream validate_evidence_anchor.
 * @public — pinned.
 */
export function validate_evidence_anchor(anchor: string, context: string): void {
	let value = anchor.trim();
	if (value.startsWith("[")) {
		if (!value.endsWith("]")) {
			throw new ReportError(
				`[ANCHOR-INVALID: ${context}: unpaired square wrapper]`,
			);
		}
		const squareInner = value.slice(1, -1);
		if (squareInner !== squareInner.trim()) {
			throw new ReportError(
				`[ANCHOR-INVALID: ${context}: padded square wrapper]`,
			);
		}
		value = squareInner;
	}
	if (value.startsWith("`")) {
		if (!value.endsWith("`")) {
			throw new ReportError(
				`[ANCHOR-INVALID: ${context}: unpaired backtick wrapper]`,
			);
		}
		const backtickInner = value.slice(1, -1);
		if (backtickInner !== backtickInner.trim()) {
			throw new ReportError(
				`[ANCHOR-INVALID: ${context}: padded backtick wrapper]`,
			);
		}
		value = backtickInner;
	}
	const match = _ANCHOR_TYPE_RE.exec(value);
	if (!match) {
		const tag = !value ? "ANCHOR-MISSING" : "ANCHOR-INVALID";
		throw new ReportError(`[${tag}: ${context}: expected typed anchor]`);
	}
	const tail = match.groups!.tail;
	if (!_balanced_square_brackets(tail) || (tail.split("`").length - 1) % 2 !== 0) {
		throw new ReportError(
			`[ANCHOR-INVALID: ${context}: locator delimiters must be balanced]`,
		);
	}
	const typeLower = match.groups!.type.toLowerCase();
	if (typeLower === "text") {
		const quoteTexts = _quoted_excerpts(tail);
		if (
			!quoteTexts ||
			quoteTexts.length === 0 ||
			quoteTexts.some((t) => !t.trim() || _wordCount(t) > 25)
		) {
			throw new ReportError(
				`[ANCHOR-INVALID: ${context}: text anchor needs balanced quoted excerpts of at most 25 words]`,
			);
		}
	} else if (typeLower === "absence") {
		if (_absence_parts(tail) === null) {
			throw new ReportError(
				`[ANCHOR-INVALID: ${context}: absence anchor needs <where> \u2014 expected <item>; checked <surfaces>]`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// @internal — DA table helpers
// ---------------------------------------------------------------------------

/** @internal — return the sole exact DA issue-table heading position. */
function _require_single_da_table_heading(
	reviewLines: string[],
	heading: string,
	path: string,
): number {
	const parseTag = `DA-${heading}-PARSE`;
	const starts: number[] = [];
	for (let i = 0; i < reviewLines.length; i++) {
		const m = _H4_RE.exec(reviewLines[i]);
		if (m && m[1] === heading) starts.push(i);
	}
	if (starts.length !== 1) {
		throw new ReportError(
			`[${parseTag}: ${path}: expected exactly one #### ${heading} section, found ${starts.length}]`,
		);
	}
	return starts[0];
}

/** @internal — parse a DA table block, returning rows + column indices. */
function _parse_da_table_block(
	reviewLines: string[],
	heading: string,
	path: string,
	start: number,
	end: number,
): [string[][], number, number] {
	const parseTag = `DA-${heading}-PARSE`;
	const block = reviewLines.slice(start + 1, end);
	const nonblank: number[] = [];
	for (let i = 0; i < block.length; i++) {
		if (block[i].trim()) nonblank.push(i);
	}
	const headerIndex = nonblank.length > 0 ? nonblank[0] : null;
	if (headerIndex === null) {
		throw new ReportError(
			`[${parseTag}: ${path}: missing table header with # and Evidence Anchor columns]`,
		);
	}
	const header = _markdown_cells(block[headerIndex]);
	if (!header.includes("#") || !header.includes("Evidence Anchor")) {
		throw new ReportError(
			`[${parseTag}: ${path}: missing table header: first nonblank line must have # and Evidence Anchor columns]`,
		);
	}
	if (
		header.filter((c) => c === "#").length !== 1 ||
		header.filter((c) => c === "Evidence Anchor").length !== 1
	) {
		throw new ReportError(
			`[${parseTag}: ${path}: table header must contain exactly one # and one Evidence Anchor column]`,
		);
	}
	const separatorIndex = headerIndex + 1;
	const separator =
		separatorIndex < block.length ? _markdown_cells(block[separatorIndex]) : [];
	const sepRe = /^:?-{3,}:?$/;
	if (
		separator.length !== header.length ||
		!separator.every((cell) => sepRe.test(cell))
	) {
		throw new ReportError(
			`[${parseTag}: ${path}: missing or malformed Markdown table separator]`,
		);
	}
	const rows: string[][] = [];
	const tableTail = block.slice(headerIndex + 2);
	for (let index = 0; index < tableTail.length; index++) {
		const line = tableTail[index];
		if (!line.trim()) {
			const trailing = tableTail.slice(index + 1);
			if (trailing.some((t) => t.trim())) {
				throw new ReportError(
					`[${parseTag}: ${path}: the DA issue tables are terminal; put Review Body prose before #### CRITICAL and emit no nonblank content after a table ends]`,
				);
			}
			break;
		}
		const cells = _markdown_cells(line);
		if (cells.length !== header.length) {
			throw new ReportError(
				`[${parseTag}: ${path}: every data row must be an outer-pipe-delimited row with the header column count]`,
			);
		}
		rows.push(cells);
	}
	return [rows, header.indexOf("#"), header.indexOf("Evidence Anchor")];
}

/** @internal — reject issue-table surfaces outside the two canonical DA bands. */
function _check_da_shadow_issue_surfaces(lines: string[], path: string): void {
	let currentH2: string | null = null;
	let inCanonicalDaBand = false;
	for (const candidate of lines) {
		const h2Match = _H2_RE.exec(candidate);
		if (h2Match) {
			currentH2 = h2Match[1];
			inCanonicalDaBand = false;
			continue;
		}
		if (_H3_RE.exec(candidate)) {
			inCanonicalDaBand = false;
			continue;
		}
		const h4Match = _H4_RE.exec(candidate);
		if (h4Match) {
			inCanonicalDaBand =
				currentH2 === "Review Body" &&
				(h4Match[1] === "CRITICAL" || h4Match[1] === "MAJOR");
			continue;
		}
		if (_RAW_HTML_TABLE_RE.test(candidate)) {
			throw new ReportError(
				`[DA-TABLE-PARSE: ${path}: unexpected raw HTML issue-table surface outside the canonical CRITICAL and MAJOR bands]`,
			);
		}
		if (inCanonicalDaBand) continue;
		const rawCells = _possible_markdown_cells(candidate);
		const cells = new Set(rawCells.map(_rendered_header_cell));
		const issuePayload = [...cells].some(
			(cell) => _DA_ISSUE_ID_RE.test(cell) || _DA_TYPED_ANCHOR_RE.test(cell),
		);
		if (cells.has("#") || cells.has("evidence anchor") || issuePayload) {
			throw new ReportError(
				`[DA-TABLE-PARSE: ${path}: unexpected issue-table band outside the canonical CRITICAL and MAJOR bands]`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Pinned public: parse_da_tables + parse_da_critical_table
// ---------------------------------------------------------------------------

/**
 * Parse both DA issue tables (CRITICAL + MAJOR). Returns [criticalIdToAnchor, majorAnchors].
 * Raises ReportError on heading/separator/ID/shadow/terminal/HTML-comment violations.
 * Faithful port of upstream parse_da_tables.
 * @public — pinned.
 */
export function parse_da_tables(
	text: string,
	path: string = "<report>",
): [Record<string, string>, string[]] {
	const rawLines = text.split(_COMMONMARK_LINE_END_RE);
	if (rawLines.some((line) => _HTML_COMMENT_RE.test(line))) {
		throw new ReportError(
			`[DA-TABLE-PARSE: ${path}: HTML comments are forbidden in DA reports]`,
		);
	}
	const lines = strip_fences(text, { preserveFencedBlocks: true });
	const [sections, dupes] = split_sections(lines);
	if ("Review Body" in dupes || !("Review Body" in sections)) {
		throw new ReportError(
			`[DA-TABLE-PARSE: ${path}: expected exactly one ## Review Body]`,
		);
	}
	const reviewLines = sections["Review Body"];
	if (lines.some((line) => _DA_SEVERITY_DECL_RE.test(line))) {
		throw new ReportError(
			`[DA-FINDING-GRAMMAR: ${path}: standalone Severity declarations are forbidden; use the CRITICAL and MAJOR issue tables]`,
		);
	}
	const criticalStart = _require_single_da_table_heading(
		reviewLines,
		"CRITICAL",
		path,
	);
	const majorStart = _require_single_da_table_heading(
		reviewLines,
		"MAJOR",
		path,
	);
	if (criticalStart >= majorStart) {
		throw new ReportError(
			`[DA-TABLE-PARSE: ${path}: #### CRITICAL must precede #### MAJOR]`,
		);
	}
	_check_da_shadow_issue_surfaces(lines, path);
	const [criticalLines, criticalIdCol, criticalAnchorCol] =
		_parse_da_table_block(reviewLines, "CRITICAL", path, criticalStart, majorStart);
	const [majorLines, majorIdCol, majorAnchorCol] = _parse_da_table_block(
		reviewLines,
		"MAJOR",
		path,
		majorStart,
		reviewLines.length,
	);

	const rows: Record<string, string> = {};
	for (const cells of criticalLines) {
		const findingId = cells[criticalIdCol];
		if (!/^C[1-9]\d*$/.test(findingId)) {
			throw new ReportError(
				`[DA-CRITICAL-PARSE: ${path}: invalid CRITICAL ID '${findingId}'; expected C1..Cn]`,
			);
		}
		if (findingId in rows) {
			throw new ReportError(
				`[DA-CRITICAL-PARSE: ${path}: duplicate CRITICAL ID ${findingId}]`,
			);
		}
		const anchor = cells[criticalAnchorCol];
		validate_evidence_anchor(anchor, `${path}:${findingId}`);
		rows[findingId] = anchor;
	}

	const majorAnchors: string[] = [];
	for (const cells of majorLines) {
		if (!cells[majorIdCol]) {
			throw new ReportError(`[DA-MAJOR-PARSE: ${path}: empty MAJOR # cell]`);
		}
		const anchor = cells[majorAnchorCol];
		validate_evidence_anchor(anchor, `${path}:DA MAJOR`);
		majorAnchors.push(anchor);
	}
	return [rows, majorAnchors];
}

/** Compat wrapper: returns parse_da_tables()[0]. @public — pinned. */
export function parse_da_critical_table(
	text: string,
	path: string = "<report>",
): Record<string, string> {
	return parse_da_tables(text, path)[0];
}

// ---------------------------------------------------------------------------
// Pinned public: _read_text
// ---------------------------------------------------------------------------

/** Read a file as UTF-8 text. Raises ContractError on IO/decode failure. @public — pinned. */
export function _read_text(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch (exc) {
		throw new ContractError(`[IO-ERROR: ${path}: ${(exc as Error).message}]`);
	}
}

// ---------------------------------------------------------------------------
// Pinned public: accept_grade_action
// ---------------------------------------------------------------------------

/** Find + return the accept-grade action (F0). Raises ContractError if none. @public — pinned. */
export function accept_grade_action(
	conditions: readonly Record<string, unknown>[],
): string {
	for (const condition of conditions) {
		if (condition.action === "editorial_decision=accept") {
			return condition.action as string;
		}
	}
	throw new ContractError(
		"[CONTRACT-INELIGIBLE: no accept-grade failure condition]",
	);
}

// ---------------------------------------------------------------------------
// Pinned public: parse_expression
// ---------------------------------------------------------------------------

/**
 * Parse a failure-condition expression into ExpressionAtom tuples.
 * Raises ContractError on unrecognized grammar, unknown dimension, or fatal-on-nonmandatory.
 * Faithful port of upstream parse_expression.
 * @public — pinned.
 */
export function parse_expression(
	expression: string,
	dimensions: Record<string, Record<string, unknown>>,
	conditionId: string,
): readonly ExpressionAtom[] {
	const atoms: ExpressionAtom[] = [];
	for (const part of expression.split(" AND ")) {
		let kind: string | null = null;
		let match: RegExpExecArray | null = null;
		for (const [k, pattern] of _EXPRESSION_PATTERNS) {
			match = pattern.exec(part);
			if (match) {
				kind = k;
				break;
			}
		}
		if (!match || kind === null) {
			throw new ContractError(
				`[EXPRESSION-UNRECOGNISED: condition_id=${conditionId}, expression=${expression}]`,
			);
		}
		let dimIds: string[];
		if (kind === "dim_exact" || kind === "fatal_dim" || kind === "dim_threshold") {
			const did = match.groups!.dim;
			if (!(did in dimensions)) {
				throw new ContractError(
					`[EXPRESSION-SEMANTIC: condition_id=${conditionId}: unknown dimension ${did}]`,
				);
			}
			dimIds = [did];
		} else if (kind === "any_all" || kind === "every_all") {
			dimIds = Object.keys(dimensions);
		} else {
			const priority =
				match.groups!.p1 ?? match.groups?.p2 ?? match.groups?.p3 ?? null;
			dimIds = Object.entries(dimensions)
				.filter(([, dim]) => dim.priority === priority)
				.map(([did]) => did);
			if (dimIds.length === 0) {
				throw new ContractError(
					`[EXPRESSION-SEMANTIC: condition_id=${conditionId}: priority '${priority}' matches no dimension]`,
				);
			}
		}
		const fatal = kind === "fatal_priority" || kind === "fatal_dim";
		if (
			fatal &&
			dimIds.some((did) => dimensions[did].priority !== "mandatory")
		) {
			throw new ContractError(
				`[CONTRACT-INVALID: condition_id=${conditionId}: fatal atom may target mandatory dimensions only]`,
			);
		}
		const dimensionQuantifier =
			kind === "count_priority"
				? "count2"
				: kind === "every_priority" || kind === "every_all"
					? "every"
					: "any";
		atoms.push({
			dimension_ids: dimIds,
			dimension_quantifier: dimensionQuantifier,
			score: fatal ? null : (match.groups?.score ?? null),
			or_worse:
				kind === "count_priority" ||
				kind === "any_all" ||
				kind === "dim_threshold",
			fatal,
		});
	}
	return atoms;
}

// ---------------------------------------------------------------------------
// Pinned public: load_contract
// ---------------------------------------------------------------------------

/**
 * Load + validate a contract: read JSON → validate() → check_structural_invariants() →
 * mode/panel_size checks → accept_grade_action → parse_expression on each condition.
 * Returns [contract, expressions]. Raises ContractError on any problem.
 * Faithful port of upstream load_contract.
 * @public — pinned.
 */
export function load_contract(
	path: string,
): [SprintContract, Record<string, readonly ExpressionAtom[]>] {
	let contract: SprintContract;
	try {
		contract = JSON.parse(_read_text(path)) as SprintContract;
	} catch (exc) {
		throw new ContractError(
			`[CONTRACT-INVALID: ${path}: ${(exc as Error).message}]`,
		);
	}
	const problems = validate(contract);
	const structProblems = check_structural_invariants(contract);
	const allProblems = [...problems, ...structProblems];
	if (allProblems.length > 0) {
		throw new ContractError(
			`[CONTRACT-INVALID: ${path}: ${allProblems.join("; ")}]`,
		);
	}
	const mode = contract.mode as string;
	if (!(mode in ROLE_SETS)) {
		throw new ContractError(
			`[CONTRACT-INELIGIBLE: unsupported reviewer mode ${mode}]`,
		);
	}
	const expected = EXPECTED_PANEL_SIZE[mode];
	if ((contract.panel_size as number) !== expected) {
		throw new ContractError(
			`[CONTRACT-INELIGIBLE: panel_size=${contract.panel_size} inconsistent with mode=${mode}; expected ${expected}]`,
		);
	}
	const failureConditions = contract.failure_conditions as Record<
		string,
		unknown
	>[];
	accept_grade_action(failureConditions);
	const acceptanceDimensions = contract.acceptance_dimensions as Record<
		string,
		unknown
	>[];
	const dimensions: Record<string, Record<string, unknown>> = {};
	for (const d of acceptanceDimensions) {
		dimensions[d.id as string] = d;
	}
	const expressions: Record<string, readonly ExpressionAtom[]> = {};
	for (const condition of failureConditions) {
		expressions[condition.condition_id as string] = parse_expression(
			condition.expression as string,
			dimensions,
			condition.condition_id as string,
		);
	}
	return [contract, expressions];
}

// ---------------------------------------------------------------------------
// Pinned public: parse_report
// ---------------------------------------------------------------------------

/**
 * Parse a reviewer report: role line, Dimension Scores section, per-dimension subsections.
 * Enforces role-scoping, trigger/block-class/abstention rules, V1-retired rejection.
 * Raises ReportError on any parse/scope violation.
 * Faithful port of upstream parse_report.
 * @public — pinned.
 */
export function parse_report(
	path: string,
	text: string,
	contract: SprintContract,
): ReviewerReport {
	const lines = strip_fences(text);
	const [sections, dupes] = split_sections(lines);
	if ("Dimension Scores" in dupes) {
		throw new ReportError(
			`[REPORT-PARSE: ${path}: duplicated ## Dimension Scores]`,
		);
	}
	if (!("Dimension Scores" in sections)) {
		throw new ReportError(
			`[REPORT-PARSE: ${path}: missing ## Dimension Scores]`,
		);
	}
	for (const retired of ["Failure Condition Checks", "Editorial Decision"]) {
		if (retired in sections) {
			throw new ReportError(
				`[V1-GRAMMAR-RETIRED: ${path}: ## ${retired} is forbidden under Schema 13.2]`,
			);
		}
	}
	if (lines.some((line) => _RETIRED_DECISION_RE.test(line))) {
		throw new ReportError(
			`[V1-GRAMMAR-RETIRED: ${path}: bare editorial_decision line is forbidden under Schema 13.2]`,
		);
	}
	const role = exactly_one(lines, _ROLE_RE, "contract_role", path, "role")!;
	const mode = contract.mode as string;
	const roleSet = ROLE_SETS[mode];
	if (!roleSet.has(role)) {
		throw new ReportError(
			`[REPORT-ROLE: ${path}: role=${role} is not valid for ${mode}]`,
		);
	}

	const acceptanceDimensions = contract.acceptance_dimensions as Record<
		string,
		unknown
	>[];
	const dims: Record<string, Record<string, unknown>> = {};
	for (const d of acceptanceDimensions) {
		dims[d.id as string] = d;
	}
	const [subsections, subsectionDupes] = split_subsections(
		sections["Dimension Scores"],
	);
	if (subsectionDupes.size > 0) {
		throw new ReportError(
			`[REPORT-PARSE: ${path}: duplicated Dimension Scores subsection(s) ${[...subsectionDupes].sort()}]`,
		);
	}
	const scores: Record<string, DimensionScore> = {};
	for (const [title, sublines] of Object.entries(subsections)) {
		const match = _DIM_H3_RE.exec(title);
		if (!match || !(match.groups!.dim in dims)) {
			throw new ReportError(
				`[REPORT-PARSE: ${path}: unknown Dimension Scores subsection '### ${title}']`,
			);
		}
		const did = match.groups!.dim;
		if (match.groups!.name !== dims[did].name) {
			throw new ReportError(`[REPORT-PARSE: ${path}: ${did} name mismatch]`);
		}
		const score = exactly_one(sublines, _SCORE_RE, `score (${did})`, path)!;
		const blockClass = exactly_one(
			sublines,
			_BLOCK_CLASS_RE,
			`block_class (${did})`,
			path,
			"value",
			{ required: false },
		);
		const trigger = exactly_one(
			sublines,
			_TRIGGER_RE,
			`trigger (${did})`,
			path,
			"value",
			{ required: false },
		);
		const abstainReason = exactly_one(
			sublines,
			_ABSTAIN_RE,
			`abstain_reason (${did})`,
			path,
			"value",
			{ required: false },
		);
		const eligible = (dims[did].eligible_roles as string[]).includes(role);
		if (eligible && score === "not_assessed" && !abstainReason) {
			throw new ReportError(
				`[ABSTENTION-INVALID: ${path}: eligible role ${role} must give abstain_reason for ${did}]`,
			);
		}
		if (!eligible && score !== "not_assessed") {
			throw new ReportError(
				`[OUT-OF-ROLE-SCORE: ${path}: role ${role} may not score ${did}]`,
			);
		}
		if (!eligible && abstainReason) {
			throw new ReportError(
				`[ABSTENTION-INVALID: ${path}: structural abstention on ${did} must not carry abstain_reason]`,
			);
		}
		const mandatoryBlock =
			eligible && score === "block" && dims[did].priority === "mandatory";
		if (mandatoryBlock !== Boolean(blockClass)) {
			throw new ReportError(
				`[BLOCK-CLASS-INVALID: ${path}: ${did} block_class is required iff an eligible mandatory dimension scores block]`,
			);
		}
		const needsTrigger = eligible && (score === "block" || score === "warn");
		if (needsTrigger !== Boolean(trigger)) {
			throw new ReportError(
				`[TRIGGER-GRAMMAR: ${path}: ${did} trigger is required iff an eligible dimension scores block or warn]`,
			);
		}
		if (score !== "not_assessed" && abstainReason) {
			throw new ReportError(
				`[ABSTENTION-INVALID: ${path}: ${did} scored result may not carry abstain_reason]`,
			);
		}
		scores[did] = {
			score,
			block_class: blockClass,
			trigger,
			abstain_reason: abstainReason,
		};
	}
	const missing = Object.keys(dims).filter((did) => !(did in scores));
	if (missing.length > 0) {
		throw new ReportError(
			`[REPORT-PARSE: ${path}: missing Dimension Scores for ${missing}]`,
		);
	}
	return { path, role, scores, text };
}
