/**
 * ARS panel-synthesis core — pure TypeScript port of the panel evaluation,
 * synthesis verification, and DA-CRITICAL terminal gate portions of
 * `upstream/scripts/check_panel_synthesis.py`.
 *
 * This module is the 3b logic core: it holds panel recomputation, expression
 * evaluation, synthesis parsing, layer-2 verification, and the DA-CRITICAL
 * terminal gate. It does NOT hold CLI / TOOL / command wiring — that lives in
 * `extensions/panel-synthesis-gate.ts`.
 *
 * Imports the PINNED API from `reviewer-gate-core.ts` (3a, frozen):
 * error classes, types, parse_report, parse_da_tables, accept_grade_action,
 * strip_fences. Does NOT modify reviewer-gate-core.ts.
 *
 * ZERO new npm dependencies.
 */

import {
	ContractError,
	ReportError,
	SynthesisError,
	type DimensionScore,
	type ReviewerReport,
	type ExpressionAtom,
	type SprintContract,
	accept_grade_action,
	parse_da_tables,
	strip_fences,
} from "./reviewer-gate-core.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Score severity ordering (pass < warn < block). Upstream parity. */
export const SCORE_ORDER: Readonly<Record<string, number>> = {
	pass: 0,
	warn: 1,
	block: 2,
};

/** The four valid editorial decisions. Upstream parity (frozenset). */
export const ACTION_ENUM: ReadonlySet<string> = new Set([
	"editorial_decision=accept",
	"editorial_decision=minor_revision",
	"editorial_decision=major_revision",
	"editorial_decision=reject",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A parsed synthesis output. Faithful port of upstream Synthesis dataclass.
 * @public — used by the gate and tests.
 */
export interface Synthesis {
	fired: string[];
	decision: string;
	dimension_verdicts: Record<string, string>;
	adjudications: Record<string, string>;
	rejection_rationales: Record<string, string>;
	marker_count: number | null;
}

// ---------------------------------------------------------------------------
// Panel recomputation (B9)
// ---------------------------------------------------------------------------

/**
 * Compute whether a cross-reviewer quantifier fires.
 *
 * n=1 → threshold 1 (owner-decides); n=2 → threshold 2 (both seats);
 * n≥3 → threshold ⌈n/2⌉+1 (n // 2 + 1). For "any" → ≥1 true; for "all" → all true.
 * Raises ContractError on empty indicators.
 *
 * Faithful port of upstream quantifier_fires.
 */
export function quantifier_fires(
	quantifier: string,
	indicators: boolean[],
	warnings: string[],
): boolean {
	const n = indicators.length;
	if (n === 0) {
		throw new ContractError("[DIMENSION-UNASSESSED]");
	}
	const k = indicators.filter(Boolean).length;
	if (quantifier === "any") {
		return k >= 1;
	}
	if (quantifier === "all") {
		return k === n;
	}
	if (quantifier === "majority") {
		const threshold = n === 1 ? 1 : n === 2 ? 2 : Math.floor(n / 2) + 1;
		return k >= threshold;
	}
	throw new ContractError(
		`unknown cross_reviewer_quantifier '${quantifier}'`,
	);
}

/**
 * Compute a single seat's boolean indicator for an atom.
 * Faithful port of upstream _seat_indicator.
 * @internal
 */
export function _seat_indicator(value: DimensionScore, atom: ExpressionAtom): boolean {
	if (atom.fatal) {
		return value.score === "block" && value.block_class === "fatal";
	}
	if (atom.or_worse) {
		return SCORE_ORDER[value.score] >= SCORE_ORDER[atom.score!];
	}
	return value.score === atom.score;
}

/**
 * Evaluate a failure-condition expression (two-stage: per-dimension cross-reviewer
 * quantifier → dimension quantifier). Returns true iff the expression fires.
 * Faithful port of upstream evaluate_expression.
 */
export function evaluate_expression(
	atoms: readonly ExpressionAtom[],
	assessed: Record<string, DimensionScore[]>,
	crossQuantifier: string,
	warnings: string[],
): boolean {
	for (const atom of atoms) {
		const dimensionResults: boolean[] = [];
		for (const did of atom.dimension_ids) {
			const values = assessed[did];
			dimensionResults.push(
				quantifier_fires(
					crossQuantifier,
					values.map((value) => _seat_indicator(value, atom)),
					warnings,
				),
			);
		}
		let result: boolean;
		if (atom.dimension_quantifier === "any") {
			result = dimensionResults.some(Boolean);
		} else if (atom.dimension_quantifier === "every") {
			result = dimensionResults.every(Boolean);
		} else {
			// "count2" — two or more
			result = dimensionResults.filter(Boolean).length >= 2;
		}
		if (!result) {
			return false;
		}
	}
	return true;
}

/**
 * Resolve the editorial decision from fired conditions.
 * Severity precedence; ties broken by earliest ordinal index.
 * Returns accept_grade_action (F0) when no conditions fired.
 * Faithful port of upstream resolve_decision.
 */
export function resolve_decision(
	conditions: Record<string, unknown>[],
	firedIds: Set<string>,
): string {
	const fired = conditions
		.map((condition, index) => ({ index, condition }))
		.filter(({ condition }) =>
			firedIds.has(condition.condition_id as string),
		);
	if (fired.length === 0) {
		return accept_grade_action(conditions);
	}
	// max by (severity, -index): highest severity wins; tie → earliest index.
	let best = fired[0];
	for (const item of fired) {
		const sev = item.condition.severity as number;
		const bestSev = best.condition.severity as number;
		if (sev > bestSev || (sev === bestSev && item.index < best.index)) {
			best = item;
		}
	}
	return best.condition.action as string;
}

/**
 * Collect assessed scores per dimension, excluding ineligible and abstaining seats.
 * Raises ContractError matching "DIMENSION-UNASSESSED: {did}" when a dimension
 * has zero assessed eligible seats.
 * Faithful port of upstream collect_assessed.
 */
export function collect_assessed(
	reports: ReviewerReport[],
	contract: SprintContract,
): Record<string, DimensionScore[]> {
	const assessed: Record<string, DimensionScore[]> = {};
	const dims = contract.acceptance_dimensions as Record<string, unknown>[];
	for (const dim of dims) {
		const did = dim.id as string;
		const eligibleRoles = dim.eligible_roles as string[];
		const values = reports
			.filter(
				(report) =>
					eligibleRoles.includes(report.role) &&
					report.scores[did].score !== "not_assessed",
			)
			.map((report) => report.scores[did]);
		if (values.length === 0) {
			throw new ContractError(`[DIMENSION-UNASSESSED: ${did}]`);
		}
		assessed[did] = values;
	}
	return assessed;
}

/**
 * Compute the panel's dimension verdicts from assessed scores.
 * Fatal blocks produce "block(fatal)"; otherwise the worst non-fatal score.
 * Faithful port of upstream compute_dimension_verdicts.
 */
export function compute_dimension_verdicts(
	assessed: Record<string, DimensionScore[]>,
): Record<string, string> {
	const verdicts: Record<string, string> = {};
	for (const [did, values] of Object.entries(assessed)) {
		if (
			values.some(
				(value) => value.score === "block" && value.block_class === "fatal",
			)
		) {
			verdicts[did] = "block(fatal)";
		} else {
			let worst = values[0];
			for (const value of values) {
				if (SCORE_ORDER[value.score] > SCORE_ORDER[worst.score]) {
					worst = value;
				}
			}
			verdicts[did] = worst.score;
		}
	}
	return verdicts;
}

/** Return type of recompute_panel. */
export type RecomputeResult = [
	Record<string, DimensionScore[]>,
	string[],
	string,
];

/**
 * Recompute the panel: collect assessed scores, evaluate all failure conditions,
 * resolve the decision. Returns [assessed, fired, decision].
 * Faithful port of upstream recompute_panel.
 */
export function recompute_panel(
	reports: ReviewerReport[],
	contract: SprintContract,
	expressions: Record<string, readonly ExpressionAtom[]>,
	warnings: string[],
): RecomputeResult {
	const assessed = collect_assessed(reports, contract);
	const fired: string[] = [];
	const failureConditions = contract.failure_conditions as Record<
		string,
		unknown
	>[];
	for (const condition of failureConditions) {
		if (
			evaluate_expression(
				expressions[condition.condition_id as string],
				assessed,
				condition.cross_reviewer_quantifier as string,
				warnings,
			)
		) {
			fired.push(condition.condition_id as string);
		}
	}
	const decision = resolve_decision(
		failureConditions,
		new Set(fired),
	);
	return [assessed, fired, decision];
}

// ---------------------------------------------------------------------------
// Synthesis grammar (B10)
// ---------------------------------------------------------------------------

const _LIST_BODY = "(?<body>[^\\]]*)";

export const _FIRED_LIST_RE = new RegExp(
	`^fired_conditions: \\[${_LIST_BODY}\\]\\s*$`,
);
export const _VERDICTS_RE = new RegExp(
	`^dimension_verdicts: \\[${_LIST_BODY}\\]\\s*$`,
);
export const _ADJUDICATIONS_RE = new RegExp(
	`^da_critical_adjudications: \\[${_LIST_BODY}\\]\\s*$`,
);
export const _RATIONALE_RE =
	/^(?<id>C[1-9]\d*) rejection rationale: (?<text>\S.*)\s*$/;
export const _MARKER_RE =
	/^\[DA-CRITICAL-VS-ACCEPT: (?<count>\d+) validated\/unresolved\]\s*$/;
export const _DECISION_RE = /^(?<action>editorial_decision=[a-z_]+)\s*$/;

const _VERDICT_TOKEN_RE =
	/^(?<dim>D\d+)=(?<value>pass|warn|block|block\(fatal\))$/;
const _ADJUDICATION_TOKEN_RE =
	/^(?<id>C[1-9]\d*)=(?<value>VALIDATED|REJECTED|UNRESOLVED)$/;

/**
 * Extract the sole matching body from lines for a given pattern.
 * Raises SynthesisError if not exactly one match.
 * Faithful port of upstream _one_body.
 * @internal
 */
function _one_body(
	lines: string[],
	pattern: RegExp,
	label: string,
	path: string,
): string {
	const bodies: string[] = [];
	for (const line of lines) {
		const match = pattern.exec(line);
		if (match) {
			bodies.push(match.groups!.body);
		}
	}
	if (bodies.length !== 1) {
		throw new SynthesisError(
			`[SYNTHESIS-PARSE: ${path}: expected exactly one ${label} line, found ${bodies.length}]`,
		);
	}
	return bodies[0].trim();
}

/**
 * Split a comma-separated body into trimmed non-empty tokens.
 * Faithful port of upstream _comma_tokens.
 * @internal
 */
function _comma_tokens(body: string): string[] {
	return body
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

/**
 * Parse a synthesis output text into a Synthesis object.
 * Raises SynthesisError on any parse violation.
 * Faithful port of upstream parse_synthesis.
 */
export function parse_synthesis(
	path: string,
	text: string,
	contract: SprintContract,
): Synthesis {
	const lines = strip_fences(text);
	const fired = _comma_tokens(
		_one_body(lines, _FIRED_LIST_RE, "fired_conditions", path),
	);
	const failureConditions = contract.failure_conditions as Record<
		string,
		unknown
	>[];
	const conditionIds = new Set(
		failureConditions.map((c) => c.condition_id as string),
	);
	if (fired.length !== new Set(fired).size) {
		throw new SynthesisError(
			`[SYNTHESIS-PARSE: ${path}: invalid fired_conditions ${JSON.stringify(fired)}]`,
		);
	}
	for (const f of fired) {
		if (!conditionIds.has(f)) {
			throw new SynthesisError(
				`[SYNTHESIS-PARSE: ${path}: invalid fired_conditions ${JSON.stringify(fired)}]`,
			);
		}
	}

	const verdictTokens = _comma_tokens(
		_one_body(lines, _VERDICTS_RE, "dimension_verdicts", path),
	);
	const verdicts: Record<string, string> = {};
	for (const token of verdictTokens) {
		const match = _VERDICT_TOKEN_RE.exec(token);
		if (!match || match.groups!.dim in verdicts) {
			throw new SynthesisError(
				`[SYNTHESIS-PARSE: ${path}: invalid dimension verdict '${token}']`,
			);
		}
		verdicts[match.groups!.dim] = match.groups!.value;
	}

	const adjudicationTokens = _comma_tokens(
		_one_body(lines, _ADJUDICATIONS_RE, "da_critical_adjudications", path),
	);
	const adjudications: Record<string, string> = {};
	for (const token of adjudicationTokens) {
		const match = _ADJUDICATION_TOKEN_RE.exec(token);
		if (!match || match.groups!.id in adjudications) {
			throw new SynthesisError(
				`[SYNTHESIS-PARSE: ${path}: invalid DA adjudication '${token}']`,
			);
		}
		adjudications[match.groups!.id] = match.groups!.value;
	}

	const decisions: string[] = [];
	for (const line of lines) {
		const match = _DECISION_RE.exec(line);
		if (match) {
			decisions.push(match.groups!.action);
		}
	}
	if (decisions.length !== 1 || !ACTION_ENUM.has(decisions[0])) {
		throw new SynthesisError(
			`[SYNTHESIS-PARSE: ${path}: expected exactly one valid decision]`,
		);
	}

	const rationales: Record<string, string> = {};
	for (const line of lines) {
		const match = _RATIONALE_RE.exec(line);
		if (match) {
			if (match.groups!.id in rationales) {
				throw new SynthesisError(
					`[SYNTHESIS-PARSE: ${path}: duplicate rejection rationale for ${match.groups!.id}]`,
				);
			}
			rationales[match.groups!.id] = match.groups!.text;
		}
	}

	const markers: number[] = [];
	for (const line of lines) {
		const match = _MARKER_RE.exec(line);
		if (match) {
			markers.push(parseInt(match.groups!.count, 10));
		}
	}
	if (markers.length > 1) {
		throw new SynthesisError(
			`[SYNTHESIS-PARSE: ${path}: duplicate DA consistency marker]`,
		);
	}

	return {
		fired,
		decision: decisions[0],
		dimension_verdicts: verdicts,
		adjudications,
		rejection_rationales: rationales,
		marker_count: markers.length > 0 ? markers[0] : null,
	};
}

// ---------------------------------------------------------------------------
// DA-CRITICAL terminal gate (B11)
// ---------------------------------------------------------------------------

/**
 * Enforce the DA-CRITICAL terminal consistency gate.
 * Verifies adjudication-ID parity, rejection-rationale requirement,
 * and accept-vs-CRITICAL marker rules.
 * Faithful port of upstream check_da_terminal_gate.
 */
export function check_da_terminal_gate(
	reports: ReviewerReport[],
	synthesis: Synthesis,
): string[] {
	const da = reports.find((report) => report.role === "da") ?? null;
	const daIds =
		da !== null ? new Set(Object.keys(parse_da_tables(da.text, da.path)[0])) : new Set<string>();
	const adjudicatedIds = new Set(Object.keys(synthesis.adjudications));
	const diagnostics: string[] = [];
	if (
		daIds.size !== adjudicatedIds.size ||
		[...daIds].some((id) => !adjudicatedIds.has(id))
	) {
		diagnostics.push(
			`[DA-CRITICAL-ADJUDICATION-MISMATCH: report=${JSON.stringify([...daIds].sort())}, synthesis=${JSON.stringify([...adjudicatedIds].sort())}]`,
		);
	}
	for (const [findingId, value] of Object.entries(synthesis.adjudications)) {
		if (
			value === "REJECTED" &&
			!(findingId in synthesis.rejection_rationales)
		) {
			diagnostics.push(
				`[DA-CRITICAL-RATIONALE-MISSING: ${findingId}]`,
			);
		}
	}
	const active = Object.values(synthesis.adjudications).filter(
		(value) => value === "VALIDATED" || value === "UNRESOLVED",
	).length;
	const needsMarker =
		synthesis.decision === "editorial_decision=accept" && active > 0;
	if (needsMarker && synthesis.marker_count !== active) {
		diagnostics.push(
			`[DA-CRITICAL-VS-ACCEPT-MARKER: expected=${active}, stated=${synthesis.marker_count}]`,
		);
	}
	if (!needsMarker && synthesis.marker_count !== null) {
		diagnostics.push(
			"[DA-CRITICAL-VS-ACCEPT-MARKER: marker forbidden in this state]",
		);
	}
	return diagnostics;
}

/**
 * Layer-2 verification: recompute the panel and check synthesis consistency.
 * Returns a list of diagnostic strings (empty = consistent).
 * Faithful port of upstream layer2_check.
 */
export function layer2_check(
	reports: ReviewerReport[],
	contract: SprintContract,
	expressions: Record<string, readonly ExpressionAtom[]>,
	synthesis: Synthesis,
	warnings: string[],
): string[] {
	const [assessed, fired, decision] = recompute_panel(
		reports,
		contract,
		expressions,
		warnings,
	);
	const verdicts = compute_dimension_verdicts(assessed);
	const diagnostics: string[] = [];
	if (
		JSON.stringify(fired) !== JSON.stringify(synthesis.fired) ||
		decision !== synthesis.decision ||
		JSON.stringify(verdicts) !== JSON.stringify(synthesis.dimension_verdicts)
	) {
		diagnostics.push(
			`[PANEL-SYNTHESIS-MISMATCH: recomputed_verdicts=${JSON.stringify(verdicts)}, declared_verdicts=${JSON.stringify(synthesis.dimension_verdicts)}, recomputed_fired=${JSON.stringify(fired)}, declared_fired=${JSON.stringify(synthesis.fired)}, recomputed=${decision}, stated=${synthesis.decision}]`,
		);
	}
	diagnostics.push(...check_da_terminal_gate(reports, synthesis));
	return diagnostics;
}
