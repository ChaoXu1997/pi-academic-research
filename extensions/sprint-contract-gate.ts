/**
 * ARS sprint-contract gate — Pi extension (native TypeScript port).
 *
 * Native reimplementation of `upstream/scripts/check_sprint_contract.py` (v3.9.2).
 * Validates a sprint contract JSON against Schema 13.2 (via the hand-written core
 * validator) plus structural invariants, and emits advisory SC-1…SC-12 warnings.
 *
 * SURFACE (design Decision 5 — mirrors citation-gate / pipeline-integrity-gate with
 * ONE deliberate deviation: FAIL-CLOSED). Two entry points share one pure core:
 *   * `ars_check_sprint_contract` TOOL — agent-callable. Not write/edit/bash → not
 *     fenced by the write-scope guard. Returns `isError: true` on schema/structural/
 *     file failure (the first BLOCKING gate in the ARS port). SC-N warnings stay
 *     advisory (reported, NEVER isError).
 *   * `/ars-check-sprint-contract` COMMAND — user-facing manual run.
 *
 * POSTURE: FAIL-CLOSED. Schema/structural/file failure → exit 1 / isError:true.
 * Pass (with or without SC-N warnings) → exit 0 / isError:false. The advisory
 * sub-channel (warn_suspicious) reports but never blocks — mirrors upstream's
 * warn_suspicious() printing to stderr with exit 0.
 *
 * Audit trail: `.pi/ars-sprint-contract-audit.jsonl`, best-effort, never blocking.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	validate,
	check_structural_invariants,
	EXPECTED_PANEL_SIZE,
	type SprintContract,
} from "./core/sprint-contract-core.js";

// ---------------------------------------------------------------------------
// @internal — regexes / version parsing (gate-local, NOT the pinned core)
// ---------------------------------------------------------------------------

// v? accepts both 'v3.6.2' and '3.6.2' on --ars-version CLI input;
// baseline_version in the contract is schema-bound to require the v prefix.
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

// Reused by SC-4 and SC-10 — tokenise Dn references in expressions.
const DIM_REF_RE = /\bD\d+\b/g;

function parseVersion(
	v: string | null | undefined,
): [number, number, number] | null {
	if (!v) return null;
	const m = VERSION_RE.exec(v);
	if (!m) return null;
	return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

// ---------------------------------------------------------------------------
// warn_suspicious — SC-1 … SC-12 advisory warnings (gate-local, never blocks)
// ---------------------------------------------------------------------------

/**
 * Soft warnings per spec §4.3 (SC-1 baseline lag through SC-12 single-judge
 * mandatory gate). Non-blocking. Faithful port of upstream warn_suspicious().
 *
 * @param contract - A contract that has passed validate() + structural checks.
 * @param arsCurrentVersion - Current ARS version (e.g. v3.6.2) for SC-1, or null.
 * @returns List of warning strings, each starting with "SC-N WARNING: …".
 */
export function warn_suspicious(
	contract: SprintContract,
	arsCurrentVersion: string | null,
): string[] {
	const warnings: string[] = [];

	const mode = typeof contract.mode === "string" ? contract.mode : "";
	const dims = Array.isArray(contract.acceptance_dimensions)
		? (contract.acceptance_dimensions as Record<string, unknown>[])
		: [];
	const conds = Array.isArray(contract.failure_conditions)
		? (contract.failure_conditions as Record<string, unknown>[])
		: [];
	const mp = isPlainObject(contract.measurement_procedure)
		? (contract.measurement_procedure as Record<string, unknown>)
		: {};

	// SC-1 baseline lag: contract.baseline_version lags current ARS by > 2 minor.
	const bv = parseVersion(
		typeof contract.baseline_version === "string"
			? contract.baseline_version
			: null,
	);
	const cv = parseVersion(arsCurrentVersion);
	if (bv && cv) {
		const [bvMajor, bvMinor] = bv;
		const [cvMajor, cvMinor] = cv;
		if (bvMajor === cvMajor && cvMinor - bvMinor > 2) {
			warnings.push(
				`SC-1 WARNING: contract baseline v${bvMajor}.${bvMinor}.* lags current ARS v${cvMajor}.${cvMinor}.* by ${cvMinor - bvMinor} minor; retirement candidate`,
			);
		} else if (bvMajor !== cvMajor) {
			warnings.push(
				`SC-1 WARNING: contract baseline major v${bvMajor} differs from current ARS v${cvMajor}; retirement candidate`,
			);
		}
	}

	// SC-2 single dimension.
	if (dims.length === 1) {
		warnings.push(
			"SC-2 WARNING: contract has only 1 acceptance dimension; consider whether this mode needs sprint contract at all",
		);
	}

	// SC-3 no mandatory dimension (only when dims exist but none mandatory).
	if (dims.length && !dims.some((d) => d.priority === "mandatory")) {
		warnings.push(
			`SC-3 WARNING: 0 of ${dims.length} acceptance dimensions are mandatory; failure_conditions referencing 'mandatory' will be vacuous`,
		);
	}

	// SC-4 orphan dimension reference.
	const dimIds = new Set(
		dims.map((d) => d.id).filter((x): x is string => typeof x === "string"),
	);
	for (const fc of conds) {
		const expr = typeof fc.expression === "string" ? fc.expression : "";
		const toks = expr.match(DIM_REF_RE) ?? [];
		for (const tok of toks) {
			if (!dimIds.has(tok)) {
				warnings.push(
					`SC-4 WARNING: failure condition ${fc.condition_id} references ${tok} which is not in acceptance_dimensions`,
				);
			}
		}
	}

	// SC-5 measurement_procedure.reviewer_must_output_before_paper missing required outputs.
	// Reviewer-only per v3.6.6 §7.1.
	if (mode.startsWith("reviewer_")) {
		const outputs = Array.isArray(mp.reviewer_must_output_before_paper)
			? (mp.reviewer_must_output_before_paper as string[])
			: [];
		const requiredOutputs = new Set(["contract_paraphrase", "scoring_plan"]);
		const missing = [...requiredOutputs].filter((o) => !outputs.includes(o));
		if (missing.length) {
			warnings.push(
				`SC-5 WARNING: hard-gate protocol requires both 'contract_paraphrase' and 'scoring_plan' in reviewer_must_output_before_paper; missing: ${JSON.stringify(missing.sort())}`,
			);
		}
	}

	// SC-7 conflicting failure-condition actions at same severity.
	const bySev = new Map<number, [string, unknown][]>();
	for (const fc of conds) {
		const sev = fc.severity;
		if (typeof sev === "number") {
			const list = bySev.get(sev) ?? [];
			list.push([String(fc.condition_id), fc.action]);
			bySev.set(sev, list);
		}
	}
	for (const [sev, pairs] of bySev) {
		const actions = new Set(pairs.map((p) => p[1]));
		if (pairs.length > 1 && actions.size > 1) {
			const ids = pairs.map((p) => p[0]).join(", ");
			warnings.push(
				`SC-7 WARNING: ${ids} share severity=${sev} but map to different actions; precedence tie-breaking falls back to ordinal position`,
			);
		}
	}

	// SC-9 impossible paraphrase_minimum_dimensions (mode-specific source field).
	let pmd: unknown;
	let pmdSource: string | null = null;
	if (mode.startsWith("reviewer_")) {
		pmd = mp.paraphrase_minimum_dimensions;
		pmdSource = "measurement_procedure.paraphrase_minimum_dimensions";
	} else if (mode === "writer_full") {
		const pca = isPlainObject(contract.pre_commitment_artifacts)
			? ((contract.pre_commitment_artifacts as Record<string, unknown>)
					.acceptance_criteria_paraphrase as unknown)
			: undefined;
		pmd = isPlainObject(pca)
			? (pca as Record<string, unknown>).minimum_dimensions
			: undefined;
		pmdSource =
			"pre_commitment_artifacts.acceptance_criteria_paraphrase.minimum_dimensions";
	} else if (mode === "evaluator_full") {
		const dh = isPlainObject(contract.disagreement_handling)
			? (contract.disagreement_handling as Record<string, unknown>)
			: {};
		pmd = dh.paraphrase_minimum_dimensions;
		pmdSource = "disagreement_handling.paraphrase_minimum_dimensions";
	}
	if (typeof pmd === "number" && pmd > dims.length && pmdSource) {
		warnings.push(
			`SC-9 WARNING: ${pmdSource}=${pmd} exceeds dimension count ${dims.length}; lint will always fail`,
		);
	}

	// SC-10 unreferenced mandatory/high dimension.
	const referenced = new Set<string>();
	for (const fc of conds) {
		const expr = typeof fc.expression === "string" ? fc.expression : "";
		const toks = expr.match(DIM_REF_RE) ?? [];
		for (const t of toks) referenced.add(t);
	}
	const priorityKeywords: Record<string, string> = {
		mandatory: "mandatory",
		high: "high-priority",
	};
	for (const d of dims) {
		const did = d.id;
		const prio = d.priority;
		if (prio !== "mandatory" && prio !== "high") continue;
		if (typeof did !== "string" || referenced.has(did)) continue;
		const pkw = priorityKeywords[prio as string];
		const priorityCovered = conds.some((fc) => {
			const expr = typeof fc.expression === "string" ? fc.expression : "";
			return expr.toLowerCase().includes(pkw);
		});
		if (priorityCovered) continue;
		warnings.push(
			`SC-10 WARNING: ${prio} dimension ${did} has no failure_condition referencing it (directly or via its priority); its score cannot influence the editorial decision`,
		);
	}

	// SC-11 panel_size sanity. Reviewer-only per v3.6.6 §7.1.
	if (mode.startsWith("reviewer_")) {
		const ps = contract.panel_size;
		if (ps === 1) {
			warnings.push(
				"SC-11 WARNING: panel_size=1 means no cross-reviewer aggregation; 'any'/'all' collapse to the bare predicate and 'majority' never fires (protocol §8)",
			);
		}
		if (mode in EXPECTED_PANEL_SIZE && ps !== EXPECTED_PANEL_SIZE[mode]) {
			warnings.push(
				`SC-11 WARNING: panel_size=${ps} inconsistent with mode=${mode}; expected ${EXPECTED_PANEL_SIZE[mode]}`,
			);
		}

		// SC-12 single-judge mandatory gate.
		for (const dim of dims) {
			if (dim.priority === "mandatory") {
				const roles = Array.isArray(dim.eligible_roles)
					? (dim.eligible_roles as unknown[])
					: [];
				if (roles.length === 1) {
					warnings.push(
						`SC-12 WARNING: mandatory dimension ${dim.id} has one eligible role (single-judge mandatory gate)`,
					);
				}
			}
		}
	}

	return warnings;
}

// ---------------------------------------------------------------------------
// Pure types
// ---------------------------------------------------------------------------

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ParsedArgs {
	contract: string;
	arsVersion: string | null;
}

export type GateVerdict =
	| "pass"
	| "schema_error"
	| "structural_error"
	| "file_error";

export interface GateResult {
	verdict: GateVerdict;
	isError: boolean;
	schemaErrors: string[];
	structuralErrors: string[];
	warnings: string[];
	contractPath: string;
}

// ---------------------------------------------------------------------------
// parseArgs — shared by TOOL and command
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): ParsedArgs {
	let contract: string | null = null;
	let arsVersion: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--ars-version") {
			arsVersion = argv[++i] ?? null;
		} else if (arg.startsWith("--ars-version=")) {
			arsVersion = arg.slice("--ars-version=".length);
		} else if (!arg.startsWith("-")) {
			contract = arg;
		}
	}
	return { contract: contract ?? "", arsVersion };
}

// ---------------------------------------------------------------------------
// runGate — the pure core both cli() and the TOOL/command share
// ---------------------------------------------------------------------------

/**
 * Read + validate + structural-check + warn against a contract file path.
 * Deterministic; no Pi runtime. The TOOL maps `isError` directly from this result;
 * the command and cli map stdout/stderr/exitCode.
 */
export function runGate(
	contractPath: string,
	arsVersion: string | null,
): GateResult {
	let contract: SprintContract;
	try {
		const text = readFileSync(contractPath, "utf-8");
		contract = JSON.parse(text) as SprintContract;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			verdict: "file_error",
			isError: true,
			schemaErrors: [],
			structuralErrors: [],
			warnings: [],
			contractPath,
			// message carried via structuralErrors[0] convention for formatting
		};
	}

	const schemaErrors = validate(contract);
	if (schemaErrors.length) {
		return {
			verdict: "schema_error",
			isError: true,
			schemaErrors,
			structuralErrors: [],
			warnings: [],
			contractPath,
		};
	}

	const structuralErrors = check_structural_invariants(contract);
	if (structuralErrors.length) {
		return {
			verdict: "structural_error",
			isError: true,
			schemaErrors: [],
			structuralErrors,
			warnings: [],
			contractPath,
		};
	}

	const warnings = warn_suspicious(contract, arsVersion);
	return {
		verdict: "pass",
		isError: false,
		schemaErrors: [],
		structuralErrors: [],
		warnings,
		contractPath,
	};
}

// ---------------------------------------------------------------------------
// cli — pure CLI entry (mirrors upstream main(); no process.stdout/stderr/exit)
// ---------------------------------------------------------------------------

export function cli(argv: string[]): CliResult {
	const args = parseArgs(argv);
	if (!args.contract) {
		return {
			stdout: "",
			stderr: "ERROR: missing required contract path argument",
			exitCode: 1,
		};
	}
	const result = runGate(args.contract, args.arsVersion);

	if (result.verdict === "pass") {
		const stderr = result.warnings.length
			? `${result.warnings.join("\n")}\n`
			: "";
		return {
			stdout: `OK: ${args.contract} is a valid sprint_contract (Schema 13.2)`,
			stderr,
			exitCode: 0,
		};
	}

	if (result.verdict === "file_error") {
		// Re-read to surface the OS/parse error message (runGate swallowed it).
		let detail = "unknown error";
		try {
			readFileSync(args.contract, "utf-8");
			JSON.parse(readFileSync(args.contract, "utf-8"));
		} catch (e) {
			detail = e instanceof Error ? e.message : String(e);
		}
		return {
			stdout: "",
			stderr: `ERROR: failed to load ${args.contract}: ${detail}`,
			exitCode: 1,
		};
	}

	if (result.verdict === "schema_error") {
		const lines = result.schemaErrors.map((e) => `ERROR: ${e}`);
		lines.push("");
		lines.push(
			`${result.schemaErrors.length} schema violation(s). See shared/sprint_contract.schema.json for field definitions.`,
		);
		return { stdout: "", stderr: lines.join("\n"), exitCode: 1 };
	}

	// structural_error
	const lines = result.structuralErrors.map((e) => `ERROR: ${e}`);
	lines.push("");
	lines.push(
		`${result.structuralErrors.length} structural invariant violation(s).`,
	);
	return { stdout: "", stderr: lines.join("\n"), exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Output formatters (for TOOL content)
// ---------------------------------------------------------------------------

function formatGateMessage(result: GateResult): string {
	if (result.verdict === "pass") {
		const parts = [
			`OK: ${result.contractPath} is a valid sprint_contract (Schema 13.2)`,
		];
		if (result.warnings.length) {
			parts.push("");
			parts.push("Advisory warnings:");
			for (const w of result.warnings) parts.push(w);
		}
		return parts.join("\n");
	}
	if (result.verdict === "file_error") {
		let detail = "unknown error";
		try {
			JSON.parse(readFileSync(result.contractPath, "utf-8"));
		} catch (e) {
			detail = e instanceof Error ? e.message : String(e);
		}
		return `ERROR: failed to load ${result.contractPath}: ${detail}`;
	}
	if (result.verdict === "schema_error") {
		const lines = result.schemaErrors.map((e) => `ERROR: ${e}`);
		lines.push("");
		lines.push(
			`${result.schemaErrors.length} schema violation(s). See shared/sprint_contract.schema.json for field definitions.`,
		);
		return lines.join("\n");
	}
	const lines = result.structuralErrors.map((e) => `ERROR: ${e}`);
	lines.push("");
	lines.push(
		`${result.structuralErrors.length} structural invariant violation(s).`,
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Audit trail (best-effort, never blocks) — mirrors slice-1 appendAudit()
// ---------------------------------------------------------------------------

const AUDIT_REL_PATH = ".pi/ars-sprint-contract-audit.jsonl";

export function appendAudit(
	ctx: ExtensionContext,
	entry: {
		source: "tool" | "command";
		contractPath: string;
		arsVersion: string | null;
		verdict: GateVerdict;
		schemaErrorCount: number;
		structuralErrorCount: number;
		warningCount: number;
		warnings: string[];
	},
): void {
	try {
		try {
			mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
		} catch {}
		const logEntry = {
			ts: new Date().toISOString(),
			source: entry.source,
			contract: entry.contractPath,
			arsVersion: entry.arsVersion,
			verdict: entry.verdict,
			schemaErrors: entry.schemaErrorCount,
			structuralErrors: entry.structuralErrorCount,
			warnings: entry.warningCount,
			warningCodes: entry.warnings
				.map((w) => {
					const m = /^(SC-\d+) WARNING/.exec(w);
					return m ? m[1] : null;
				})
				.filter((x): x is string => x !== null),
		};
		appendFileSync(
			join(ctx.cwd, AUDIT_REL_PATH),
			`${JSON.stringify(logEntry)}\n`,
		);
	} catch {
		// Swallow: audit is observability, not enforcement.
	}
}

// ---------------------------------------------------------------------------
// @internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
	const { Type } = await import("typebox");

	pi.registerTool({
		name: "ars_check_sprint_contract",
		label: "Check sprint contract",
		description:
			"Validate an ARS sprint contract JSON against Schema 13.2 + structural invariants. " +
			"FAIL-CLOSED: returns isError:true on schema/structural/file failure (blocks the reviewer). " +
			"SC-N advisory warnings are reported in the output but never block. " +
			"Mirrors check_sprint_contract.py v3.9.2.",
		parameters: Type.Object({
			contract: Type.String({
				description: "Path to the sprint contract JSON file to validate.",
			}),
			arsVersion: Type.Optional(
				Type.String({
					description:
						"Current ARS version (e.g. v3.6.2) for the SC-1 baseline-lag advisory. " +
						"Accepts vX.Y.Z or X.Y.Z. Optional; SC-1 is skipped if omitted.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const contractPath = params.contract;
			const arsVersion = params.arsVersion ?? null;
			const result = runGate(contractPath, arsVersion);
			appendAudit(ctx, {
				source: "tool",
				contractPath,
				arsVersion,
				verdict: result.verdict,
				schemaErrorCount: result.schemaErrors.length,
				structuralErrorCount: result.structuralErrors.length,
				warningCount: result.warnings.length,
				warnings: result.warnings,
			});
			// FAIL-CLOSED: isError true on schema/structural/file failure.
			return {
				content: [{ type: "text", text: formatGateMessage(result) }],
				details: {
					contract: contractPath,
					verdict: result.verdict,
					schemaErrors: result.schemaErrors,
					structuralErrors: result.structuralErrors,
					warnings: result.warnings,
				},
				isError: result.isError,
			};
		},
	});

	pi.registerCommand("ars-check-sprint-contract", {
		description:
			"Validate an ARS sprint contract. Usage: /ars-check-sprint-contract <contract.json> " +
			"[--ars-version vX.Y.Z]. FAIL-CLOSED on schema/structural failure.",
		handler: async (args, ctx) => {
			const argv = (
				Array.isArray(args) ? args : String(args ?? "").split(/\s+/)
			).filter(Boolean);
			const parsed = parseArgs(argv);
			if (!parsed.contract) {
				ctx.ui.notify(
					"ERROR: missing required contract path argument. Usage: /ars-check-sprint-contract <contract.json> [--ars-version vX.Y.Z]",
					"error",
				);
				return;
			}
			const result = runGate(parsed.contract, parsed.arsVersion);
			appendAudit(ctx, {
				source: "command",
				contractPath: parsed.contract,
				arsVersion: parsed.arsVersion,
				verdict: result.verdict,
				schemaErrorCount: result.schemaErrors.length,
				structuralErrorCount: result.structuralErrors.length,
				warningCount: result.warnings.length,
				warnings: result.warnings,
			});
			const message = formatGateMessage(result);
			// Hard-error notification on failure; info on pass (incl. warnings).
			ctx.ui.notify(message, result.isError ? "error" : "info");
		},
	});
}
