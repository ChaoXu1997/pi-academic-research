/**
 * ARS pipeline-integrity gate — Pi extension (native TypeScript port).
 *
 * Native reimplementation of `upstream/scripts/check_pipeline_integrity.py` (v3.9.2 advisory
 * verifier). Scans a working directory for phaseN_ (1-6) subdirectories and emits ADVISORY findings
 * about possible #133-class phase-scope inflation (a single agent producing phase5_ output
 * that looks like independent review but was never cross-checked). The gate REPORTS findings and
 * NEVER blocks — identical to the upstream advisory posture (exit 0 on every non-IO-error run).
 *
 * WHY NATIVE TS (OQ3 ARCHITECTURE — design decision). The upstream script is PURE Python stdlib
 * (`pathlib`, `re`, `argparse`, `json`) that reads ONLY filesystem entry NAMES and file mtimes —
 * never file contents. Node mirrors this exactly with `fs.readdirSync` (recursive) + `statSync`
 * (`.mtimeMs`) + `RegExp`. There is NO fidelity gap and NO Python runtime dependency needed.
 * This is fundamentally different from `citation-gate.ts`, which wraps an EXTERNAL binary
 * (`ref-verify`) that does live CrossRef/S2/PubMed lookups — that binary cannot be reimplemented
 * in stdlib. This gate has no such external dependency.
 *
 * SURFACE (OQ4 WIRING — mirrors `citation-gate.ts`). Two entry points share one pure core:
 *   * `ars_check_pipeline_integrity` TOOL — agent-callable. It is NOT a write/edit/bash tool, so
 *     the write-scope guard does NOT fence it — a Bucket A agent may call it even though its bash
 *     is denied wholesale.
 *   * `/ars-check-pipeline-integrity` COMMAND — user-facing manual run.
 *
 * POSTURE (mirrors upstream). ADVISORY / fails-open. The gate exits 0 on every run that is not
 * an IO error. STRUCTURAL, ADVISORY, and HEURISTIC findings are printed to stdout; none blocks.
 * The only non-zero exit is a missing/non-directory workdir (exit 1).
 *
 * PORT FIDELITY NOTES:
 *   * Regex patterns are byte-for-byte ports of the upstream Python (same character classes, same
 *     `re.IGNORECASE` flag via JS `/i`). The three reviewer categories + two rules are mirrored
 *     exactly.
 *   * Phase-dir scan: immediate children matching `^phase([1-6])(?:_.*)?$` (phases 1–6 only).
 *   * Rule 1 (STRUCTURAL, on by default): each phase5_ dir is recursively scanned for
 *     non-hidden files; three reviewer categories must each be satisfied by at least one filename.
 *   * Rule 2 (HEURISTIC, `--strict` only, `--window-seconds N` default 300): adjacent-phase file
 *     mtimes compared within a configurable window.
 *   * Read-only: never opens file contents — only names + mtimes (verified by all upstream tests
 *     creating zero-byte `.touch()` files).
 *   * Minor difference: Node `Dirent.isDirectory()` does not follow symlinks (Python `is_dir()`
 *     does); upstream tests use real directories so this does not affect parity.
 *   * Output shape mirrors the Python --json: {workdir, phase_dirs{str->paths}, findings[]}.
 */

import {
	readdirSync,
	statSync,
	appendFileSync,
	mkdirSync,
	type Dirent,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// --- Constants (byte-for-byte ports of upstream regexes) ---------------------

const DEFAULT_WINDOW_SECONDS = 300;

const PHASE_DIR_RE = /^phase([1-6])(?:_.*)?$/;

const PHASE5_REVIEWER_PATTERNS: Record<string, RegExp> = {
	devils_advocate: /devils?[_-]?advocate/i,
	editor_in_chief: /(?:editor[_-]?in[_-]?chief|^eic|[_-]eic[_-])/i,
	ethics_review: /ethics?[_-]?review/i,
	methodology_reviewer: /methodology[_-]?review/i,
	domain_reviewer: /domain[_-]?review/i,
	perspective_reviewer: /perspective[_-]?review/i,
	editorial_synthesizer: /editorial[_-]?synth/i,
};

// At least one stem from each category must appear in phase5_*/ filenames.
const PHASE5_REQUIRED_CATEGORIES: [string, string[]][] = [
	["devil's advocate", ["devils_advocate"]],
	["editorial/EIC", ["editor_in_chief", "editorial_synthesizer"]],
	[
		"ethics or panel reviewer",
		[
			"ethics_review",
			"methodology_reviewer",
			"domain_reviewer",
			"perspective_reviewer",
		],
	],
];

// --- Types -------------------------------------------------------------------

export type Severity = "ADVISORY" | "STRUCTURAL" | "HEURISTIC";

export interface Finding {
	rule: string;
	severity: Severity;
	phase: number | null;
	path: string;
	message: string;
}

export interface Report {
	workdir: string;
	phase_dirs: Map<number, string[]>;
	findings: Finding[];
}

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface GateOptions {
	strict?: boolean;
	windowSeconds?: number;
}

interface FileRecord {
	name: string;
	path: string;
	mtime: number;
}

// --- Pure core: filesystem walk ----------------------------------------------

/**
 * Recursively collect all files under `dirPath`. Each record carries the entry name, the full
 * path, and the mtime in seconds (matching Python's `st_mtime`).
 *
 * @param resilient — when true, unreadable subdirectories/files are silently skipped (used by
 *   Rule 2, which never aborts on a single error). When false, any OS error propagates to the
 *   caller (used by Rule 1, which emits `phase5_attribution_io_error` on failure).
 */
function walkFiles(dirPath: string, resilient: boolean): FileRecord[] {
	const out: FileRecord[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			if (resilient) return;
			throw e;
		}
		for (const e of entries) {
			const fp = join(dir, e.name);
			if (e.isDirectory()) {
				walk(fp);
			} else if (e.isFile()) {
				try {
					out.push({
						name: e.name,
						path: fp,
						mtime: statSync(fp).mtimeMs / 1000,
					});
				} catch (e2) {
					if (!resilient) throw e2;
				}
			}
		}
	};
	walk(dirPath);
	return out;
}

// --- Pure core: workdir scan -------------------------------------------------

export function scanWorkdir(workdir: string): Map<number, string[]> {
	const phaseDirs = new Map<number, string[]>();
	let entries: Dirent[];
	try {
		entries = readdirSync(workdir, { withFileTypes: true });
	} catch {
		return phaseDirs;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const m = PHASE_DIR_RE.exec(entry.name);
		if (!m) continue;
		const phase = parseInt(m[1], 10);
		const dirPath = join(workdir, entry.name);
		if (!phaseDirs.has(phase)) phaseDirs.set(phase, []);
		phaseDirs.get(phase)!.push(dirPath);
	}
	return phaseDirs;
}

// --- Pure core: Rule 1 — phase5 missing independent reviewer -----------------

export function checkPhase5Attribution(report: Report): void {
	const phase5Dirs = report.phase_dirs.get(5) ?? [];
	if (!phase5Dirs.length) return;

	for (const dirPath of phase5Dirs) {
		let allRecords: FileRecord[];
		try {
			allRecords = walkFiles(dirPath, false);
		} catch (exc) {
			report.findings.push({
				rule: "phase5_attribution_io_error",
				severity: "ADVISORY",
				phase: 5,
				path: dirPath,
				message: `Could not read phase5 directory: ${
					exc instanceof Error ? exc.message : String(exc)
				}`,
			});
			continue;
		}

		// Skip hidden files (Python: p.is_file() and not p.name.startswith(".")).
		const files = allRecords
			.filter((r) => !r.name.startsWith("."))
			.map((r) => r.name);

		if (!files.length) {
			report.findings.push({
				rule: "phase5_empty",
				severity: "ADVISORY",
				phase: 5,
				path: dirPath,
				message:
					"phase5_*/ directory is empty — Phase 5 should produce review reports",
			});
			continue;
		}

		// Tally which reviewer agents are present across all filenames.
		const matchedAgents = new Set<string>();
		for (const fname of files) {
			for (const [agent, pattern] of Object.entries(PHASE5_REVIEWER_PATTERNS)) {
				if (pattern.test(fname)) matchedAgents.add(agent);
			}
		}

		const missingCategories: string[] = [];
		for (const [label, agentList] of PHASE5_REQUIRED_CATEGORIES) {
			if (!agentList.some((a) => matchedAgents.has(a)))
				missingCategories.push(label);
		}

		if (missingCategories.length) {
			const filesPreview = JSON.stringify(files.slice(0, 5));
			const ellipsis = files.length > 5 ? "..." : "";
			report.findings.push({
				rule: "phase5_missing_independent_reviewer",
				severity: "STRUCTURAL",
				phase: 5,
				path: dirPath,
				message:
					`phase5_*/ missing independent reviewer attribution for categories: ` +
					`${missingCategories.join(", ")}. Files found: ${filesPreview}${ellipsis}. ` +
					`#133 pattern: Phase 5 deliverable was likely produced by a single agent ` +
					`that inflated past its scope, skipping mandatory independent crosschecks ` +
					`(DA / EIC / Ethics). Re-run via orchestrator-driven Mode A with ` +
					"`/ars-full` or invoke each reviewer agent separately.",
			});
		}
	}
}

// --- Pure core: Rule 2 — adjacent-phase same-window heuristic -----------------

export function checkSameCallHeuristic(
	report: Report,
	windowSeconds: number,
): void {
	const phasesPresent = [...report.phase_dirs.keys()].sort((a, b) => a - b);
	if (phasesPresent.length < 2) return;

	// Collect (phase → file records) for phases that have at least one file.
	const fileRecords = new Map<number, FileRecord[]>();
	for (const [phase, dirs] of report.phase_dirs) {
		const records = dirs.flatMap((d) => walkFiles(d, true));
		if (records.length) fileRecords.set(phase, records);
	}

	for (const phase of phasesPresent) {
		const nextPhase = phase + 1;
		if (!fileRecords.has(nextPhase)) continue;
		const phaseA = fileRecords.get(phase) ?? [];
		const phaseB = fileRecords.get(nextPhase) ?? [];
		for (const fileA of phaseA) {
			for (const fileB of phaseB) {
				const delta = Math.abs(fileA.mtime - fileB.mtime);
				if (delta <= windowSeconds) {
					report.findings.push({
						rule: "adjacent_phase_same_window",
						severity: "HEURISTIC",
						phase,
						path: fileA.path,
						message:
							`phase${phase} file ${fileA.name} and phase${nextPhase} file ` +
							`${fileB.name} share mtime within ${Math.trunc(delta)}s ` +
							`(window=${windowSeconds}s). POSSIBLE same-call inflation. ` +
							`Note: legitimate fast orchestrator runs also trigger this ` +
							`heuristic — verify against orchestrator state ledger before ` +
							`treating as #133-class violation.`,
					});
				}
			}
		}
	}
}

// --- Pure core: formatters ---------------------------------------------------

function formatPhaseDirsText(phaseDirs: Map<number, string[]>): string {
	const entries = [...phaseDirs.entries()].sort((a, b) => a[0] - b[0]);
	const parts = entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
	return `{${parts.join(", ")}}`;
}

export function formatText(report: Report): string {
	const lines = [
		"ARS pipeline integrity check (v3.9.2 advisory)",
		`Workdir: ${report.workdir}`,
		`Phase dirs found: ${formatPhaseDirsText(report.phase_dirs)}`,
		"",
	];
	if (!report.findings.length) {
		lines.push("No advisory findings.");
		return lines.join("\n");
	}
	lines.push(`Findings (${report.findings.length}):`);
	report.findings.forEach((f, i) => {
		lines.push("");
		lines.push(`  [${i + 1}] ${f.severity} — ${f.rule}`);
		if (f.phase !== null) lines.push(`      Phase: ${f.phase}`);
		lines.push(`      Path:  ${f.path}`);
		lines.push(`      ${f.message}`);
	});
	lines.push("");
	lines.push(
		"Reminder: this output is ADVISORY. Findings do NOT block any workflow.",
	);
	lines.push(
		"See docs/design/2026-05-18-ars-v3.9.2-phase-boundary-spec.md for rationale.",
	);
	return lines.join("\n");
}

export function formatJson(report: Report): string {
	const phaseDirsObj: Record<string, string[]> = {};
	for (const [k, v] of [...report.phase_dirs.entries()].sort(
		(a, b) => a[0] - b[0],
	)) {
		phaseDirsObj[String(k)] = v;
	}
	const payload = {
		workdir: report.workdir,
		phase_dirs: phaseDirsObj,
		findings: report.findings.map((f) => ({
			rule: f.rule,
			severity: f.severity,
			phase: f.phase,
			path: f.path,
			message: f.message,
		})),
	};
	// JSON.stringify never escapes non-ASCII — matches Python's ensure_ascii=False.
	return JSON.stringify(payload, null, 2);
}

// --- Pure core: CLI arg parsing ----------------------------------------------

export interface ParsedArgs {
	workdir: string;
	strict: boolean;
	windowSeconds: number;
	json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
	let workdir = ".";
	let strict = false;
	let windowSeconds = DEFAULT_WINDOW_SECONDS;
	let json = false;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--strict") {
			strict = true;
		} else if (arg === "--json") {
			json = true;
		} else if (arg === "--window-seconds") {
			windowSeconds = parseInt(argv[++i], 10);
		} else if (arg.startsWith("--window-seconds=")) {
			windowSeconds = parseInt(arg.slice("--window-seconds=".length), 10);
		} else {
			positional.push(arg);
		}
	}
	if (positional.length) workdir = positional[0];
	return { workdir, strict, windowSeconds, json };
}

// --- Pure core: gate runner --------------------------------------------------

export function runGate(workdir: string, opts: GateOptions = {}): Report {
	const report: Report = {
		workdir,
		phase_dirs: scanWorkdir(workdir),
		findings: [],
	};
	checkPhase5Attribution(report);
	if (opts.strict) {
		checkSameCallHeuristic(
			report,
			opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS,
		);
	}
	return report;
}

/**
 * Pure CLI entry — mirrors the upstream `main()` without touching process.stdout/stderr/exit.
 * Returns `{ stdout, stderr, exitCode }` so tests can assert on all three channels.
 */
export function cli(argv: string[]): CliResult {
	const args = parseArgs(argv);
	const workdir = resolve(args.workdir);
	let isDir = false;
	try {
		isDir = statSync(workdir).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) {
		return {
			stdout: "",
			stderr: `ERROR: workdir not found or not a directory: ${workdir}`,
			exitCode: 1,
		};
	}
	const report = runGate(workdir, {
		strict: args.strict,
		windowSeconds: args.windowSeconds,
	});
	const output = args.json ? formatJson(report) : formatText(report);
	return { stdout: output, stderr: "", exitCode: 0 };
}

// --- Audit trail (best-effort, never blocks) ---------------------------------
// Mirrors citation-gate's .pi/ars-citation-audit.jsonl pattern. One JSON line per gate run.
const AUDIT_REL_PATH = ".pi/ars-pipeline-integrity-audit.jsonl";

export function appendAudit(
	ctx: ExtensionContext,
	entry: {
		source: "tool" | "command";
		workdir: string;
		strict: boolean;
		windowSeconds: number;
		report: Report;
	},
): void {
	try {
		try {
			mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
		} catch {}
		const logEntry = {
			ts: new Date().toISOString(),
			source: entry.source,
			workdir: entry.workdir,
			strict: entry.strict,
			windowSeconds: entry.windowSeconds,
			findingCount: entry.report.findings.length,
			findings: entry.report.findings.map((f) => ({
				rule: f.rule,
				severity: f.severity,
				phase: f.phase,
			})),
		};
		appendFileSync(
			join(ctx.cwd, AUDIT_REL_PATH),
			`${JSON.stringify(logEntry)}\n`,
		);
	} catch {
		// Swallow: audit is observability, not enforcement.
	}
}

// --- Summary (for tool UI) ---------------------------------------------------

function summarize(report: Report): string {
	const lines = [
		`[ARS pipeline integrity] ${report.findings.length} finding(s) in ${report.workdir}`,
	];
	if (!report.findings.length) {
		lines.push("  No advisory findings.");
	} else {
		for (const f of report.findings) {
			lines.push(
				`  ${f.severity} — ${f.rule}${
					f.phase !== null ? ` (phase ${f.phase})` : ""
				}: ${f.message.slice(0, 160)}`,
			);
		}
	}
	lines.push("Reminder: ADVISORY — findings do NOT block any workflow.");
	return lines.join("\n");
}

// --- Extension entry point ---------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
	const { Type } = await import("typebox");

	const INPUT_SCHEMA = Type.Object({
		workdir: Type.Optional(
			Type.String({
				description:
					"Working directory to scan for phaseN_*/ subdirectories (default: session CWD).",
			}),
		),
		strict: Type.Optional(
			Type.Boolean({
				description:
					"Enable the adjacent-phase same-window HEURISTIC (FP-prone, default OFF).",
			}),
		),
		windowSeconds: Type.Optional(
			Type.Number({
				description: `Same-call window for --strict heuristic (default: ${DEFAULT_WINDOW_SECONDS}s).`,
			}),
		),
	});

	// Agent-callable tool. Not write/edit/bash → not fenced by the write-scope guard.
	pi.registerTool({
		name: "ars_check_pipeline_integrity",
		label: "Check pipeline integrity",
		description:
			"Run the ARS #133 phase-scope-inflation advisory check: scan a working directory for phaseN_*/ subdirectories and report STRUCTURAL/ADVISORY/HEURISTIC findings. Advisory only — never blocks. Mirrors check_pipeline_integrity.py v3.9.2.",
		parameters: INPUT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workdir = resolve(params.workdir ?? ctx.cwd);
			const strict = params.strict ?? false;
			const windowSeconds = params.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
			const report = runGate(workdir, { strict, windowSeconds });
			appendAudit(ctx, {
				source: "tool",
				workdir,
				strict,
				windowSeconds,
				report,
			});
			// isError is ALWAYS false — advisory posture, never blocks.
			return {
				content: [{ type: "text", text: summarize(report) }],
				details: {
					workdir: report.workdir,
					outcome: "advisory" as const,
					findingCount: report.findings.length,
					findings: report.findings,
				},
				isError: false,
			};
		},
	});

	// User-facing command.
	pi.registerCommand("ars-check-pipeline-integrity", {
		description:
			"Run the ARS #133 pipeline-integrity advisory check. Usage: /ars-check-pipeline-integrity [workdir] [--strict] [--window-seconds N] [--json]. Advisory only — never blocks.",
		handler: async (args, ctx) => {
			const argv = (
				Array.isArray(args) ? args : String(args ?? "").split(/\s+/)
			).filter(Boolean);
			const effectiveArgv = argv.length ? argv : [ctx.cwd];
			const parsed = parseArgs(effectiveArgv);
			const workdir = resolve(
				parsed.workdir === "." ? ctx.cwd : parsed.workdir,
			);
			let isDir = false;
			try {
				isDir = statSync(workdir).isDirectory();
			} catch {
				isDir = false;
			}
			if (!isDir) {
				ctx.ui.notify(
					`ERROR: workdir not found or not a directory: ${workdir}`,
					"error",
				);
				return;
			}
			const report = runGate(workdir, {
				strict: parsed.strict,
				windowSeconds: parsed.windowSeconds,
			});
			appendAudit(ctx, {
				source: "command",
				workdir,
				strict: parsed.strict,
				windowSeconds: parsed.windowSeconds,
				report,
			});
			const output = parsed.json ? formatJson(report) : formatText(report);
			ctx.ui.notify(output, "info");
		},
	});
}
