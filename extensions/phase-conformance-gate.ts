/**
 * ARS phase-conformance gate — Pi extension (native TypeScript port).
 *
 * Native reimplementation of the gate wrapper portions of
 * `upstream/scripts/check_phase_conformance.py` (_parse_args, main). The pure
 * phase-conformance logic lives in `extensions/core/phase-conformance-core.ts`.
 *
 * SURFACE (design Decision 5 — three-tier by exception type). Two entry points
 * share one pure `cli(argv)` core:
 *   * `ars_check_phase_conformance` TOOL — agent-callable. Not write/edit/bash →
 *     not fenced by the write-scope guard. Returns `isError: true` for BOTH
 *     non-zero tiers (exits 2 AND 3 block). Tier identity in content + audit.
 *   * `/ars-check-phase-conformance` COMMAND — user-facing manual run.
 *
 * EXIT-TIER RESOLUTION (by exception type, single try/catch):
 *   ContractError → exit 2 (contract/infra)
 *   ReportError | ConformanceError → exit 3 (reviewer conformance)
 *   pass → exit 0
 * The FIRST exception to fire determines the exit code. No multi-tier accumulation.
 *
 * `--phase1-only` ordering (Decision 6): manuscript blindness FIRST, before
 * parse_phase1 — a leak must not be hidden behind a grammar error.
 *
 * Advisory sub-channels: plan.warnings ([PHASE1-TRIGGER-SHORT]) and
 * dissent.diagnostics ([DISSENT-EMPTY-SECTION]) printed but never affect exit
 * code. Exception: [PROTOCOL-VIOLATION: multi_dissent=true] IS exit 3.
 *
 * Audit trail: `.pi/ars-phase-conformance-audit.jsonl`, best-effort, never blocking.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ContractError,
	ReportError,
	load_contract,
	parse_report,
	_read_text,
} from "./core/reviewer-gate-core.js";
import { ROLE_SETS } from "./core/sprint-contract-core.js";
import {
	ConformanceError,
	EXIT_PASS,
	EXIT_CONTRACT,
	EXIT_CONFORMANCE,
	parse_phase1,
	check_manuscript_leakage,
	parse_dissent_dimensions,
	check_trigger_binding,
	check_scoring_seat_anchors,
	check_da_anchors,
} from "./core/phase-conformance-core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArgs {
	contract: string;
	role: string;
	phase1: string;
	phase2: string | null;
	phase1Only: boolean;
	manuscript: string;
	metadata: string;
}

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	tier: ExitTier;
	phase1Only: boolean;
	contractPath: string;
}

// ---------------------------------------------------------------------------
// Exit tiers
// ---------------------------------------------------------------------------

export type ExitTier = 0 | 2 | 3;
export type TierLabel = "pass" | "contract" | "conformance";

export function tierLabelFromExitCode(code: number): TierLabel {
	if (code === 0) return "pass";
	if (code === 2) return "contract";
	return "conformance";
}

// ---------------------------------------------------------------------------
// parseArgs — shared by TOOL and command
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		contract: "",
		role: "",
		phase1: "",
		phase2: null,
		phase1Only: false,
		manuscript: "",
		metadata: "",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--contract") result.contract = argv[++i] ?? "";
		else if (arg.startsWith("--contract="))
			result.contract = arg.slice("--contract=".length);
		else if (arg === "--role") result.role = argv[++i] ?? "";
		else if (arg.startsWith("--role="))
			result.role = arg.slice("--role=".length);
		else if (arg === "--phase1") result.phase1 = argv[++i] ?? "";
		else if (arg.startsWith("--phase1="))
			result.phase1 = arg.slice("--phase1=".length);
		else if (arg === "--phase2") result.phase2 = argv[++i] ?? "";
		else if (arg.startsWith("--phase2="))
			result.phase2 = arg.slice("--phase2=".length);
		else if (arg === "--phase1-only") result.phase1Only = true;
		else if (arg === "--manuscript") result.manuscript = argv[++i] ?? "";
		else if (arg.startsWith("--manuscript="))
			result.manuscript = arg.slice("--manuscript=".length);
		else if (arg === "--metadata") result.metadata = argv[++i] ?? "";
		else if (arg.startsWith("--metadata="))
			result.metadata = arg.slice("--metadata=".length);
	}
	return result;
}

// ---------------------------------------------------------------------------
// _validate_args — required flags + mutual exclusion (exit 2 before try block)
// ---------------------------------------------------------------------------

function _validate_args(args: ParsedArgs): string | null {
	const required: Array<[string, string]> = [
		["--contract", args.contract],
		["--role", args.role],
		["--phase1", args.phase1],
		["--manuscript", args.manuscript],
		["--metadata", args.metadata],
	];
	for (const [flag, value] of required) {
		if (!value) return `${flag} is required`;
	}
	if (args.phase1Only && args.phase2 !== null) {
		return "--phase2 and --phase1-only are mutually exclusive";
	}
	if (!args.phase1Only && args.phase2 === null) {
		return "one of --phase2 or --phase1-only is required";
	}
	return null;
}

// ---------------------------------------------------------------------------
// cli — pure CLI entry (faithful port of upstream main(); no process.stdout/exit)
// ---------------------------------------------------------------------------

export function cli(argv: string[]): CliResult {
	const args = parseArgs(argv);
	const usageError = _validate_args(args);
	if (usageError) {
		return {
			stdout: `[USAGE: ${usageError}]\n`,
			stderr: "",
			exitCode: EXIT_CONTRACT,
			tier: EXIT_CONTRACT,
			phase1Only: args.phase1Only,
			contractPath: args.contract,
		};
	}

	let stdout = "";
	try {
		const [contract] = load_contract(args.contract);
		if (!ROLE_SETS[contract.mode as string].has(args.role)) {
			throw new ContractError(
				`[ROLE-BINDING: --role ${args.role} is invalid for ${contract.mode as string}]`,
			);
		}
		const phase1Text = _read_text(args.phase1);
		const phase2Text = args.phase1Only ? null : _read_text(args.phase2!);
		const manuscriptText = _read_text(args.manuscript);
		let metadata: unknown;
		try {
			metadata = JSON.parse(_read_text(args.metadata));
		} catch (exc) {
			throw new ContractError(
				`[METADATA-INVALID: ${args.metadata}: ${(exc as Error).message}]`,
			);
		}
		if (args.phase1Only) {
			// Blindness FIRST, before structural parsing (Decision 6).
			check_manuscript_leakage(phase1Text, manuscriptText, metadata, contract);
		}
		const plan = parse_phase1(args.phase1, phase1Text, contract, args.role);
		for (const warning of plan.warnings) {
			stdout += `${warning}\n`;
		}
		if (args.phase1Only) {
			stdout += "PHASE1-CONFORMANCE: PASS\n";
			return {
				stdout,
				stderr: "",
				exitCode: EXIT_PASS,
				tier: EXIT_PASS,
				phase1Only: true,
				contractPath: args.contract,
			};
		}
		const report = parse_report(args.phase2!, phase2Text!, contract);
		if (report.role !== args.role) {
			throw new ConformanceError(
				`[ROLE-BINDING: report declares ${report.role}, dispatched as ${args.role}]`,
			);
		}
		check_manuscript_leakage(phase1Text, manuscriptText, metadata, contract);
		const dissent = parse_dissent_dimensions(phase2Text!);
		for (const diagnostic of dissent.diagnostics) {
			stdout += `${diagnostic}\n`;
		}
		const dimensions: Record<string, Record<string, unknown>> = {};
		for (const dim of contract.acceptance_dimensions as Record<
			string,
			unknown
		>[]) {
			dimensions[dim.id as string] = dim;
		}
		check_trigger_binding(report, plan, dimensions, dissent.dimensions);
		if (report.role === "da") {
			check_da_anchors(report);
		} else {
			check_scoring_seat_anchors(report);
		}
	} catch (exc) {
		if (exc instanceof ContractError) {
			return {
				stdout: `${stdout}${(exc as Error).message}\n`,
				stderr: "",
				exitCode: EXIT_CONTRACT,
				tier: EXIT_CONTRACT,
				phase1Only: args.phase1Only,
				contractPath: args.contract,
			};
		}
		if (exc instanceof ReportError || exc instanceof ConformanceError) {
			return {
				stdout: `${stdout}${(exc as Error).message}\n`,
				stderr: "",
				exitCode: EXIT_CONFORMANCE,
				tier: EXIT_CONFORMANCE,
				phase1Only: args.phase1Only,
				contractPath: args.contract,
			};
		}
		throw exc;
	}
	stdout += "PHASE-CONFORMANCE: PASS\n";
	return {
		stdout,
		stderr: "",
		exitCode: EXIT_PASS,
		tier: EXIT_PASS,
		phase1Only: args.phase1Only,
		contractPath: args.contract,
	};
}

// ---------------------------------------------------------------------------
// Audit trail (best-effort, never blocks)
// ---------------------------------------------------------------------------

const AUDIT_REL_PATH = ".pi/ars-phase-conformance-audit.jsonl";

export function appendAudit(
	ctx: ExtensionContext,
	entry: {
		source: "tool" | "command";
		contractPath: string;
		role: string;
		phase1Only: boolean;
		exitTier: ExitTier;
		tierLabel: TierLabel;
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
			role: entry.role,
			phase1Only: entry.phase1Only,
			exitTier: entry.exitTier,
			tierLabel: entry.tierLabel,
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
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
	const { Type } = await import("typebox");

	pi.registerTool({
		name: "ars_check_phase_conformance",
		label: "Check phase conformance",
		description:
			"Verify Phase 2 report faithfulness to Phase 1 pre-commitment: Phase 1 grammar, " +
			"manuscript blindness (12-word shingle), trigger binding, dissent parsing, evidence anchors. " +
			"THREE-TIER by exception type: contract/infra (exit 2) → ConformanceError/ReportError (exit 3) → " +
			"pass (exit 0). Both non-zero tiers map to isError:true.",
		parameters: Type.Object({
			contract: Type.String({
				description: "Path to the reviewer contract JSON file.",
			}),
			role: Type.String({
				description: "Dispatch role (e.g. eic, methodology, da).",
			}),
			phase1: Type.String({
				description: "Path to the Phase 1 pre-commitment Markdown file.",
			}),
			phase2: Type.Optional(
				Type.String({
					description:
						"Path to the Phase 2 reviewer report Markdown. Required unless phase1Only is true.",
				}),
			),
			phase1Only: Type.Optional(
				Type.Boolean({
					description:
						"Run the Phase-1-only path: manuscript blindness + Phase 1 parse, no Phase 2 checks.",
				}),
			),
			manuscript: Type.String({
				description: "Path to the manuscript Markdown file.",
			}),
			metadata: Type.String({
				description:
					"Path to the metadata JSON file ({title, field, word_count}).",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const argv: string[] = [
				"--contract",
				params.contract,
				"--role",
				params.role,
				"--phase1",
				params.phase1,
				"--manuscript",
				params.manuscript,
				"--metadata",
				params.metadata,
			];
			if (params.phase1Only) {
				argv.push("--phase1-only");
			} else if (params.phase2) {
				argv.push("--phase2", params.phase2);
			}
			const result = cli(argv);
			const tierLabel = tierLabelFromExitCode(result.exitCode);
			appendAudit(ctx, {
				source: "tool",
				contractPath: params.contract,
				role: params.role,
				phase1Only: Boolean(params.phase1Only),
				exitTier: result.tier,
				tierLabel,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: result.stdout || result.stderr,
					},
				],
				details: {
					exitTier: result.tier,
					tierLabel,
				},
				isError: result.exitCode !== EXIT_PASS,
			};
		},
	});

	pi.registerCommand("ars-check-phase-conformance", {
		description:
			"Check phase conformance. Usage: /ars-check-phase-conformance --contract C.json " +
			"--role <role> --phase1 P1.md (--phase2 P2.md | --phase1-only) " +
			"--manuscript M.md --metadata meta.json. Three-tier by exception type.",
		handler: async (args, ctx) => {
			const argv = (
				Array.isArray(args) ? args : String(args ?? "").split(/\s+/)
			).filter(Boolean);
			const result = cli(argv);
			const tierLabel = tierLabelFromExitCode(result.exitCode);
			const parsed = parseArgs(argv);
			appendAudit(ctx, {
				source: "command",
				contractPath: parsed.contract,
				role: parsed.role,
				phase1Only: parsed.phase1Only,
				exitTier: result.tier,
				tierLabel,
			});
			const message = result.stdout || result.stderr;
			ctx.ui.notify(message, result.exitCode !== EXIT_PASS ? "error" : "info");
		},
	});
}
