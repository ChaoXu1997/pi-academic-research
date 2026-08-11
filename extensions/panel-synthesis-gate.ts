/**
 * ARS panel-synthesis gate — Pi extension (native TypeScript port).
 *
 * Native reimplementation of the gate wrapper portions of
 * `upstream/scripts/check_panel_synthesis.py` (main(), _parse_args, cardinality,
 * role-binding, audit, TOOL, command). The pure panel logic lives in
 * `extensions/core/panel-synthesis-core.ts`.
 *
 * SURFACE (design Decision 6 — four-tier precedence 2 > 3 > 1). Two entry points
 * share one pure `cli(argv)` core:
 *   * `ars_check_panel_synthesis` TOOL — agent-callable. Not write/edit/bash → not
 *     fenced by the write-scope guard. Returns `isError: true` for ALL three
 *     non-zero tiers (exits 1, 2, 3 all block). Tier identity surfaced in content
 *     + audit.
 *   * `/ars-check-panel-synthesis` COMMAND — user-facing manual run.
 *
 * FOUR-TIER PRECEDENCE (the critical behavioral contract — AC-33):
 *   1. load_contract → ContractError → exit 2 (short-circuit, the only one)
 *   2. accumulate infra[] (cardinality, role-set, digest, IO)
 *   3. accumulate reviewer_diags[] (parse_report ReportErrors, role-binding swaps)
 *   4. IF NOT layer1-only AND NOT infra AND NOT reviewer_diags:
 *        parse_synthesis + layer2_check → synthesis_diags[]
 *   5. print warnings + infra + reviewer + synthesis (in that order)
 *   6. exit: infra? 2 : reviewer? 3 : synthesis? 1 : 0
 *
 * Advisory sub-channel: recompute_panel warnings never cause non-zero exit EXCEPT
 * quantifier_fires empty-indicators ContractError → exit 2.
 *
 * Audit trail: `.pi/ars-panel-synthesis-audit.jsonl`, best-effort, never blocking.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ROLE_SETS } from "./core/sprint-contract-core.js";
import {
	ContractError,
	ReportError,
	SynthesisError,
	type SprintContract,
	type ExpressionAtom,
	load_contract,
	parse_report,
	_read_text,
} from "./core/reviewer-gate-core.js";
import {
	parse_synthesis,
	layer2_check,
} from "./core/panel-synthesis-core.js";

// ---------------------------------------------------------------------------
// Exit codes (upstream parity)
// ---------------------------------------------------------------------------

const EXIT_PASS = 0;
const EXIT_SYNTHESIS = 1;
const EXIT_CONTRACT = 2;
const EXIT_REVIEWER = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArgs {
	contract: string;
	reports: string[];
	roles: string | null;
	synthesis: string | null;
	layer1Only: boolean;
}

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	infraCount: number;
	reviewerCount: number;
	synthesisCount: number;
	warningCount: number;
}

// ---------------------------------------------------------------------------
// parseArgs — shared by TOOL and command
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): ParsedArgs {
	let contract: string | null = null;
	const reports: string[] = [];
	let roles: string | null = null;
	let synthesis: string | null = null;
	let layer1Only = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--contract") {
			contract = argv[++i] ?? "";
		} else if (arg.startsWith("--contract=")) {
			contract = arg.slice("--contract=".length);
		} else if (arg === "--report") {
			reports.push(argv[++i] ?? "");
		} else if (arg.startsWith("--report=")) {
			reports.push(arg.slice("--report=".length));
		} else if (arg === "--roles") {
			roles = argv[++i] ?? "";
		} else if (arg.startsWith("--roles=")) {
			roles = arg.slice("--roles=".length);
		} else if (arg === "--synthesis") {
			synthesis = argv[++i] ?? "";
		} else if (arg.startsWith("--synthesis=")) {
			synthesis = arg.slice("--synthesis=".length);
		} else if (arg === "--layer1-only") {
			layer1Only = true;
		}
	}
	return {
		contract: contract ?? "",
		reports,
		roles,
		synthesis,
		layer1Only,
	};
}

// ---------------------------------------------------------------------------
// cli — pure CLI entry (faithful port of upstream main(); no process.stdout/exit)
// ---------------------------------------------------------------------------

export function cli(argv: string[]): CliResult {
	const args = parseArgs(argv);
	const warnings: string[] = [];
	const infra: string[] = [];
	const reviewerDiags: string[] = [];
	const synthesisDiags: string[] = [];

	// --- Arg validation (mutually exclusive --synthesis / --layer1-only) ---
	if (!args.contract) {
		return {
			stdout: "",
			stderr: "[CONTRACT-MISSING: --contract is required]",
			exitCode: EXIT_CONTRACT,
			infraCount: 0,
			reviewerCount: 0,
			synthesisCount: 0,
			warningCount: 0,
		};
	}
	if (args.reports.length === 0) {
		return {
			stdout: "",
			stderr: "[REPORT-MISSING: at least one --report is required]",
			exitCode: EXIT_CONTRACT,
			infraCount: 0,
			reviewerCount: 0,
			synthesisCount: 0,
			warningCount: 0,
		};
	}
	if (args.layer1Only && args.synthesis !== null) {
		return {
			stdout: "",
			stderr:
				"[ARG-CONFLICT: --layer1-only and --synthesis are mutually exclusive]",
			exitCode: EXIT_CONTRACT,
			infraCount: 0,
			reviewerCount: 0,
			synthesisCount: 0,
			warningCount: 0,
		};
	}
	if (!args.layer1Only && args.synthesis === null) {
		return {
			stdout: "",
			stderr:
				"[ARG-MISSING: one of --synthesis or --layer1-only is required]",
			exitCode: EXIT_CONTRACT,
			infraCount: 0,
			reviewerCount: 0,
			synthesisCount: 0,
			warningCount: 0,
		};
	}

	// --- Step 1: load contract (short-circuit on ContractError) ---
	let contract: SprintContract;
	let expressions: Record<string, readonly ExpressionAtom[]>;
	try {
		[contract, expressions] = load_contract(args.contract);
	} catch (exc) {
		return {
			stdout: `${(exc as Error).message}\n`,
			stderr: "",
			exitCode: EXIT_CONTRACT,
			infraCount: 0,
			reviewerCount: 0,
			synthesisCount: 0,
			warningCount: 0,
		};
	}

	// --- Step 2: cardinality checks ---
	const panelSize = contract.panel_size as number;
	const resolvedPaths = args.reports.map((p) => resolve(p));
	if (new Set(resolvedPaths).size !== resolvedPaths.length) {
		infra.push("[PANEL-CARDINALITY: duplicate report paths]");
	}
	if (args.layer1Only) {
		if (!(args.reports.length >= 1 && args.reports.length <= panelSize)) {
			infra.push(
				`[PANEL-CARDINALITY: layer1-only accepts 1..${panelSize} reports, got=${args.reports.length}]`,
			);
		}
	} else if (args.reports.length !== panelSize) {
		infra.push(
			`[PANEL-CARDINALITY: got=${args.reports.length}, panel_size=${panelSize}]`,
		);
	}

	// --- Step 3: read reports, check byte-identical ---
	const texts: Record<string, string> = {};
	const digests = new Set<string>();
	const seenPaths = new Set<string>();
	for (const reportPath of args.reports) {
		try {
			texts[reportPath] = _read_text(reportPath);
		} catch (exc) {
			infra.push((exc as Error).message);
			continue;
		}
		const resolvedPath = resolve(reportPath);
		if (seenPaths.has(resolvedPath)) continue;
		seenPaths.add(resolvedPath);
		const digest = createHash("sha256")
			.update(texts[reportPath])
			.digest("hex");
		if (digests.has(digest)) {
			infra.push(
				`[PANEL-CARDINALITY: byte-identical report contents (${reportPath})]`,
			);
		}
		digests.add(digest);
	}

	// --- Step 4: parse reports ---
	const reports = [];
	for (const reportPath of args.reports) {
		if (!(reportPath in texts)) continue;
		try {
			reports.push(parse_report(reportPath, texts[reportPath], contract));
		} catch (exc) {
			reviewerDiags.push((exc as Error).message);
		}
	}

	// --- Step 5: role cross-check ---
	if (reports.length === args.reports.length) {
		const roles = reports.map((report) => report.role);
		const roleSet = ROLE_SETS[contract.mode as string];
		if (args.layer1Only) {
			if (new Set(roles).size !== roles.length) {
				infra.push(
					`[PANEL-CARDINALITY: duplicate roles ${JSON.stringify(roles)}]`,
				);
			}
		} else if (
			![...new Set(roles)].every((r) => roleSet.has(r)) ||
			![...roleSet].every((r) => new Set(roles).has(r)) ||
			new Set(roles).size !== roles.length
		) {
			infra.push(
				`[PANEL-CARDINALITY: roles ${JSON.stringify([...roles].sort())} != required ${JSON.stringify([...roleSet].sort())}]`,
			);
		}
		if (args.roles !== null) {
			const dispatched = args.roles
				.split(",")
				.map((role) => role.trim())
				.filter((role) => role.length > 0);
			if (dispatched.length !== reports.length) {
				infra.push(
					`[ROLE-BINDING: --roles count=${dispatched.length} does not match reports=${reports.length}]`,
				);
			} else {
				for (let index = 0; index < dispatched.length; index++) {
					const expected = dispatched[index];
					const report = reports[index];
					if (expected !== report.role) {
						reviewerDiags.push(
							`[ROLE-BINDING: report[${index}] declares ${report.role}, dispatched as ${expected}]`,
						);
					}
				}
			}
		}
	}

	// --- Step 6: synthesis check (conditionally skipped) ---
	if (!args.layer1Only && infra.length === 0 && reviewerDiags.length === 0) {
		try {
			const synthesis = parse_synthesis(
				args.synthesis!,
				_read_text(args.synthesis!),
				contract,
			);
			synthesisDiags.push(
				...layer2_check(reports, contract, expressions, synthesis, warnings),
			);
		} catch (exc) {
			if (exc instanceof ContractError) {
				infra.push((exc as Error).message);
			} else if (exc instanceof ReportError) {
				reviewerDiags.push((exc as Error).message);
			} else if (exc instanceof SynthesisError) {
				synthesisDiags.push((exc as Error).message);
			} else {
				infra.push((exc as Error).message);
			}
		}
	}

	// --- Step 7: print all diagnostics in order ---
	let stdout = "";
	for (const diagnostic of [
		...warnings,
		...infra,
		...reviewerDiags,
		...synthesisDiags,
	]) {
		stdout += `${diagnostic}\n`;
	}

	// --- Step 8: exit resolution (precedence 2 > 3 > 1) ---
	if (infra.length > 0) {
		return {
			stdout,
			stderr: "",
			exitCode: EXIT_CONTRACT,
			infraCount: infra.length,
			reviewerCount: reviewerDiags.length,
			synthesisCount: synthesisDiags.length,
			warningCount: warnings.length,
		};
	}
	if (reviewerDiags.length > 0) {
		return {
			stdout,
			stderr: "",
			exitCode: EXIT_REVIEWER,
			infraCount: infra.length,
			reviewerCount: reviewerDiags.length,
			synthesisCount: synthesisDiags.length,
			warningCount: warnings.length,
		};
	}
	if (synthesisDiags.length > 0) {
		return {
			stdout,
			stderr: "",
			exitCode: EXIT_SYNTHESIS,
			infraCount: infra.length,
			reviewerCount: reviewerDiags.length,
			synthesisCount: synthesisDiags.length,
			warningCount: warnings.length,
		};
	}
	stdout += args.layer1Only ? "LAYER1-ONLY: PASS\n" : "PANEL-SYNTHESIS: PASS\n";
	return {
		stdout,
		stderr: "",
		exitCode: EXIT_PASS,
		infraCount: infra.length,
		reviewerCount: reviewerDiags.length,
		synthesisCount: synthesisDiags.length,
		warningCount: warnings.length,
	};
}

// ---------------------------------------------------------------------------
// Tier mapping helpers
// ---------------------------------------------------------------------------

export type ExitTier = 0 | 1 | 2 | 3;
export type TierLabel = "pass" | "synthesis" | "contract" | "reviewer";

export function tierFromExitCode(code: number): ExitTier {
	return code as ExitTier;
}

export function tierLabelFromExitCode(code: number): TierLabel {
	if (code === 0) return "pass";
	if (code === 1) return "synthesis";
	if (code === 2) return "contract";
	return "reviewer";
}

// ---------------------------------------------------------------------------
// Audit trail (best-effort, never blocks) — per-tier granularity (AC-43)
// ---------------------------------------------------------------------------

const AUDIT_REL_PATH = ".pi/ars-panel-synthesis-audit.jsonl";

export function appendAudit(
	ctx: ExtensionContext,
	entry: {
		source: "tool" | "command";
		contractPath: string;
		reportCount: number;
		layer1Only: boolean;
		exitTier: ExitTier;
		tierLabel: TierLabel;
		infraCount: number;
		reviewerCount: number;
		synthesisCount: number;
		warningCount: number;
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
			reportCount: entry.reportCount,
			layer1Only: entry.layer1Only,
			exitTier: entry.exitTier,
			tierLabel: entry.tierLabel,
			infraCount: entry.infraCount,
			reviewerCount: entry.reviewerCount,
			synthesisCount: entry.synthesisCount,
			warningCount: entry.warningCount,
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
		name: "ars_check_panel_synthesis",
		label: "Check panel synthesis",
		description:
			"Recompute the editorial panel's dimension verdicts, fired failure conditions, " +
			"and editorial decision from reviewer reports, then verify the synthesizer's " +
			"declared output matches. Enforces the DA-CRITICAL terminal consistency gate. " +
			"FOUR-TIER precedence: contract/infra (exit 2) > reviewer (exit 3) > synthesis " +
			"(exit 1) > pass (exit 0). All three non-zero tiers map to isError:true.",
		parameters: Type.Object({
			contract: Type.String({
				description: "Path to the reviewer contract JSON file.",
			}),
			reports: Type.Array(Type.String(), {
				description: "Paths to the reviewer report Markdown files.",
			}),
			synthesis: Type.Optional(
				Type.String({
					description:
						"Path to the synthesis output Markdown. Required unless layer1Only is true.",
				}),
			),
			layer1Only: Type.Optional(
				Type.Boolean({
					description:
						"Run the report-only path: no synthesis verification, relaxed cardinality (1..panel_size).",
				}),
			),
			roles: Type.Optional(
				Type.String({
					description:
						"Comma-separated dispatch roles, positionally matched to reports.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const argv: string[] = ["--contract", params.contract];
			for (const r of params.reports) {
				argv.push("--report", r);
			}
			if (params.roles) argv.push("--roles", params.roles);
			if (params.layer1Only) {
				argv.push("--layer1-only");
			} else if (params.synthesis) {
				argv.push("--synthesis", params.synthesis);
			}
			const result = cli(argv);
			const tier = tierFromExitCode(result.exitCode);
			const tierLabel = tierLabelFromExitCode(result.exitCode);
			appendAudit(ctx, {
				source: "tool",
				contractPath: params.contract,
				reportCount: params.reports.length,
				layer1Only: Boolean(params.layer1Only),
				exitTier: tier,
				tierLabel,
				infraCount: result.infraCount,
				reviewerCount: result.reviewerCount,
				synthesisCount: result.synthesisCount,
				warningCount: result.warningCount,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: result.stdout || result.stderr,
					},
				],
				details: {
					exitTier: tier,
					tierLabel,
					infraCount: result.infraCount,
					reviewerCount: result.reviewerCount,
					synthesisCount: result.synthesisCount,
				},
				isError: result.exitCode !== EXIT_PASS,
			};
		},
	});

	pi.registerCommand("ars-check-panel-synthesis", {
		description:
			"Check panel synthesis. Usage: /ars-check-panel-synthesis --contract C.json " +
			"--report R.md [--report R2.md ...] [--roles eic,methodology,...] " +
			"(--synthesis S.md | --layer1-only). Four-tier precedence 2 > 3 > 1.",
		handler: async (args, ctx) => {
			const argv = (
				Array.isArray(args) ? args : String(args ?? "").split(/\s+/)
			).filter(Boolean);
			const result = cli(argv);
			const tier = tierFromExitCode(result.exitCode);
			const tierLabel = tierLabelFromExitCode(result.exitCode);
			const parsed = parseArgs(argv);
			appendAudit(ctx, {
				source: "command",
				contractPath: parsed.contract,
				reportCount: parsed.reports.length,
				layer1Only: parsed.layer1Only,
				exitTier: tier,
				tierLabel,
				infraCount: result.infraCount,
				reviewerCount: result.reviewerCount,
				synthesisCount: result.synthesisCount,
				warningCount: result.warningCount,
			});
			const message = result.stdout || result.stderr;
			ctx.ui.notify(message, result.exitCode !== EXIT_PASS ? "error" : "info");
		},
	});
}
