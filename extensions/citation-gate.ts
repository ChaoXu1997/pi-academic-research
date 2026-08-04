/**
 * ARS citation-verification gate — Pi extension.
 *
 * Wraps the `ref-verify` CLI (Moonweave-Research/ref-verify) as the deterministic backend for
 * the upstream #182 citation-verification gate — the ONE invariant that the write-scope guard
 * could not port (it needs live CrossRef/S2/PubMed lookups the vendored Python runtime provided).
 *
 * WHY THIS EXISTS. Upstream #182 hard-blocks a submission when its citations are unverified.
 * Porting the upstream 200-module Python runtime is not worth it: `ref-verify` is a zero-dep
 * Python CLI that does the same job more rigorously (CrossRef/S2/PubMed/OpenAlex metadata,
 * retraction detection, verbatim-abstract claim checks). This extension is the Pi-native glue:
 * it resolves the binary, extracts DOIs from the submission references, runs the Quick Screen
 * (`verify-doi`) per DOI, aggregates the verdicts, and returns a gate result.
 *
 * SURFACE. Two entry points share one core:
 *   * `ars_verify_citations` TOOL — agent-callable (the citation-compliance / formatter agents
 *     invoke it at submission). It is NOT a write/edit/bash tool, so the write-scope guard does
 *     NOT fence it — a Bucket A agent may call it even though its bash is denied wholesale.
 *   * `/ars-verify-citations` COMMAND — user-facing manual run.
 *
 * POSTURE (mirrors ref-verify's conservatism). The gate HARD-fails only on an explicit REJECT
 * (dead DOI, DOI resolves to a different paper, retracted). Anything else — WARN, UNVERIFIABLE,
 * an unparseable non-zero result — is REVIEW, not a hard fail: ref-verify is explicit that
 * UNVERIFIABLE means "no abstract reachable", NOT "the citation is wrong". A missing `ref-verify`
 * binary degrades to ADVISORY (never blocks) — identical to the upstream's no-Python posture.
 *
 * NOTE on verdict parsing. `verify-doi --json`'s exact JSON keys are not documented; this wrapper
 * parses defensively (looks for verdict/status/result/error_code) and falls back to exit code
 * (0 ⇒ PASS, non-zero ⇒ REVIEW). Only an explicit REJECT / DOI_MISMATCH / DOI_NOT_FOUND in the
 * JSON escalates to a hard fail. Adjust VERDICT_KEYS if a future ref-verify version renames them.
 */

import { execFile as execFileCb } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Promisify node:child_process ourselves — @types/node v26 ships no `node:child_process/promises`
// submodule declaration, so we wrap the callback form.
function execFile(
	cmd: string,
	args: string[],
	opts: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFileCb(cmd, args, opts as any, (err, stdout, stderr) => {
			if (err) {
				const e = err as Error & {
					stdout?: string;
					stderr?: string;
					code?: number;
				};
				e.stdout = stdout?.toString() ?? "";
				e.stderr = stderr?.toString() ?? "";
				reject(e);
			} else {
				resolve({
					stdout: stdout?.toString() ?? "",
					stderr: stderr?.toString() ?? "",
				});
			}
		});
	});
}

// --- ref-verify binary resolution -------------------------------------------

const REF_VERIFY_BIN = "ref-verify";
// Module fallback for an uninstalled source checkout (PYTHONPATH=src python3 -m ref_verify.cli).
const MODULE_ENTRY: [string, string[]] = ["python3", ["-m", "ref_verify.cli"]];

let binaryCache:
	| { kind: "bin" }
	| { kind: "module"; cmd: string; args: string[] }
	| null
	| undefined;

async function resolveBinary(): Promise<typeof binaryCache> {
	if (binaryCache !== undefined) return binaryCache;
	// Prefer the installed `ref-verify` entry point.
	try {
		await execFile(REF_VERIFY_BIN, ["--help"], { timeout: 8000 });
		binaryCache = { kind: "bin" };
		return binaryCache;
	} catch {
		// fall through to module entrypoint
	}
	try {
		await execFile(MODULE_ENTRY[0], [...MODULE_ENTRY[1], "--help"], {
			timeout: 8000,
			env: {
				...process.env,
				PYTHONPATH: ["src", process.env.PYTHONPATH].filter(Boolean).join(":"),
			},
		});
		binaryCache = {
			kind: "module",
			cmd: MODULE_ENTRY[0],
			args: MODULE_ENTRY[1],
		};
		return binaryCache;
	} catch {
		binaryCache = null; // not installed → advisory
		return binaryCache;
	}
}

async function runRefVerify(
	args: string[],
	timeoutMs = 30000,
): Promise<{ stdout: string; code: number }> {
	const bin = await resolveBinary();
	if (!bin) return { stdout: "", code: -1 };
	const cmd: [string, string[]] =
		bin.kind === "bin"
			? [REF_VERIFY_BIN, args]
			: [bin.cmd, [...bin.args, ...args]];
	try {
		const res = await execFile(cmd[0], cmd[1], {
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
		return { stdout: res.stdout ?? "", code: 0 };
	} catch (e: any) {
		// Non-zero exit still carries JSON on stdout for verdict parsing.
		return {
			stdout: e?.stdout ?? "",
			code: typeof e?.code === "number" ? e.code : 1,
		};
	}
}

// --- DOI extraction + verdict parsing ---------------------------------------

const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>),;\]]+/g;

function extractDois(input: string): string[] {
	const seen = new Set<string>();
	for (const raw of input.matchAll(DOI_RE)) {
		// Strip a trailing punctuation artifact that the regex char-class let through.
		const doi = raw[0].replace(/[.,;:)]+$/g, "").replace(/\}+$/g, "");
		if (doi.length > 7) seen.add(doi);
	}
	return [...seen];
}

// Keys we treat as an explicit hard-REJECT (the only thing that hard-fails the gate).
const REJECT_ERROR_CODES = new Set([
	"DOI_MISMATCH",
	"DOI_NOT_FOUND",
	"RETRACTED",
]);
const REJECT_VERDICT_TOKENS = ["REJECT"]; // uppercased — verdict is .toUpperCase()'d

interface PerDoi {
	doi: string;
	verdict: "PASS" | "REJECT" | "REVIEW";
	raw?: string;
	errorCode?: string;
	stdoutSnippet?: string;
}

function classify(stdout: string, _code: number): Omit<PerDoi, "doi"> {
	const snippet = stdout.slice(0, 400);
	let parsed: any = null;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		/* fall back to exit code */
	}
	if (parsed && typeof parsed === "object") {
		const verdict = String(
			parsed.verdict ?? parsed.status ?? parsed.result ?? parsed.decision ?? "",
		).toUpperCase();
		const errorCode = String(parsed.error_code ?? parsed.errorCode ?? "");
		const errMsg = typeof parsed.error === "string" ? parsed.error : "";
		// Dead DOI / unreachable source: ref-verify returns {"error":"HTTP Error 404: ..."} with NO
		// verdict field. A 404 means the DOI does not resolve → hard REJECT.
		if (!verdict && errMsg) {
			return {
				verdict: "REJECT",
				raw: errMsg.slice(0, 160),
				stdoutSnippet: snippet,
			};
		}
		if (
			REJECT_VERDICT_TOKENS.some((t) => verdict.includes(t)) ||
			REJECT_ERROR_CODES.has(errorCode)
		) {
			return {
				verdict: "REJECT",
				raw: verdict || undefined,
				errorCode: errorCode || undefined,
				stdoutSnippet: snippet,
			};
		}
		if (
			verdict === "PASS" ||
			verdict === "ACCEPT" ||
			errorCode === "CLAIM_SUPPORTED"
		) {
			return {
				verdict: "PASS",
				raw: verdict || undefined,
				errorCode: errorCode || undefined,
			};
		}
		if (verdict)
			return {
				verdict: "REVIEW",
				raw: verdict,
				errorCode: errorCode || undefined,
				stdoutSnippet: snippet,
			};
	}
	// No parseable verdict: REVIEW regardless of exit code. ref-verify's exit code is NOT a reliable
	// PASS signal — a minor-metadata-mismatch WARN also exits 0 (verified against ref-verify 1.2.0).
	// Only an explicit verdict/error in the JSON confirms a decision.
	return { verdict: "REVIEW", stdoutSnippet: snippet };
}

// --- Core gate ---------------------------------------------------------------

export type GateOutcome = "pass" | "review" | "fail" | "advisory";

export { extractDois, classify, runGate, appendCitationAudit };
export type { PerDoi };

export interface GateResult {
	outcome: GateOutcome;
	total: number;
	pass: number;
	reject: number;
	review: number;
	perDoi: PerDoi[];
	note?: string;
}

// --- Per-DOI metadata (for full PASS/REJECT verification) -------------------
// ref-verify's `verify-doi` returns WARN ("insufficient metadata") when run bare. To get a real
// PASS/REJECT it needs --title/--first-author/--year. The agent may supply a JSONL of these.
interface CitationMeta {
	title?: string;
	first_author?: string;
	year?: string;
}
type MetadataMap = Map<string, CitationMeta>;

/** Parse a JSONL file of {doi, title?, first_author?|author?, year?} per line into a doi→meta map. */
export function parseMetadataFile(path: string): MetadataMap {
	const map: MetadataMap = new Map();
	try {
		const text = readFileSync(path, "utf-8");
		for (const line of text.split(/\r?\n/)) {
			const t = line.trim();
			if (!t) continue;
			let obj: any;
			try {
				obj = JSON.parse(t);
			} catch {
				continue;
			}
			const doi = typeof obj?.doi === "string" ? obj.doi.trim() : "";
			if (!doi) continue;
			const fa =
				typeof obj?.first_author === "string"
					? obj.first_author
					: typeof obj?.author === "string"
						? obj.author
						: undefined;
			map.set(doi, {
				title: typeof obj?.title === "string" ? obj.title : undefined,
				first_author: fa,
				year: obj?.year != null ? String(obj.year) : undefined,
			});
		}
	} catch {
		/* unreadable metadata file → treat as no metadata */
	}
	return map;
}

/** Build the `verify-doi` argv for a DOI, appending metadata flags when available. */
function verifyArgsFor(doi: string, meta?: CitationMeta): string[] {
	const args = ["verify-doi", doi];
	if (meta?.title) args.push("--title", meta.title);
	if (meta?.first_author) args.push("--first-author", meta.first_author);
	if (meta?.year) args.push("--year", meta.year);
	args.push("--json");
	return args;
}

async function runGate(
	inputText: string,
	metadata?: MetadataMap,
): Promise<GateResult> {
	const dois = extractDois(inputText);
	if (dois.length === 0) {
		return {
			outcome: "advisory",
			total: 0,
			pass: 0,
			reject: 0,
			review: 0,
			perDoi: [],
			note: "No DOIs found in input.",
		};
	}
	const bin = await resolveBinary();
	if (!bin) {
		// ref-verify absent → degrade to advisory (never block). Matches upstream no-Python posture.
		return {
			outcome: "advisory",
			total: dois.length,
			pass: 0,
			reject: 0,
			review: dois.length,
			perDoi: dois.map((doi) => ({ doi, verdict: "REVIEW" })),
			note: "ref-verify CLI not installed; citations NOT verified (advisory). Install: pip install -e . from Moonweave-Research/ref-verify.",
		};
	}
	// Quick Screen per DOI (existence + retraction). Metadata fields (--title/--first-author/--year)
	// would tighten this; without them verify-doi still catches dead DOIs and retractions.
	const perDoi: PerDoi[] = [];
	// Bounded concurrency so a large bibliography does not serialize 30s×N.
	const CONCURRENCY = 3;
	for (let i = 0; i < dois.length; i += CONCURRENCY) {
		const batch = dois.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (doi) => {
				const meta = metadata?.get(doi);
				const { stdout, code } = await runRefVerify(verifyArgsFor(doi, meta));
				return { doi, ...classify(stdout, code) };
			}),
		);
		perDoi.push(...results);
	}
	const pass = perDoi.filter((d) => d.verdict === "PASS").length;
	const reject = perDoi.filter((d) => d.verdict === "REJECT").length;
	const review = perDoi.filter((d) => d.verdict === "REVIEW").length;
	const outcome: GateOutcome =
		reject > 0 ? "fail" : review > 0 ? "review" : "pass";
	const note = !metadata
		? "Dead-DOI/retraction screen only (no per-DOI metadata supplied). Supply a metadata JSONL ({doi,title,first_author,year}) for full PASS/REJECT verification — bare verify-doi always returns WARN (insufficient metadata) without it."
		: undefined;
	return { outcome, total: dois.length, pass, reject, review, perDoi, note };
}

/** Read the input: a file path (read its text) or a literal DOI list. */
function readInput(input: string): string {
	const trimmed = input.trim();
	// If it looks like a path to an existing references file, read it.
	if (/^[\w./~-]+\.(bib|txt|md|csv|jsonl?|tex)$/i.test(trimmed)) {
		try {
			return readFileSync(trimmed, "utf-8");
		} catch {
			// fall through to treating as literal
		}
	}
	return input;
}

// --- Audit trail (best-effort, never blocks) --------------------------------
// Appends one JSON line per gate run to <workspace>/.pi/ars-citation-audit.jsonl, mirroring the
// write-scope guard's audit. Any failure is swallowed: a logging error must never block a gate
// result or wedge the session. The .pi/ dir is gitignored runtime state.
const CITATION_AUDIT_REL_PATH = ".pi/ars-citation-audit.jsonl";

function appendCitationAudit(
	ctx: ExtensionContext,
	entry: {
		source: "tool" | "command";
		input: string;
		metadataFile?: string;
		result: GateResult;
	},
): void {
	try {
		try {
			mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
		} catch {}
		const r = entry.result;
		const logEntry = {
			ts: new Date().toISOString(),
			source: entry.source,
			input:
				entry.input.length > 200
					? `${entry.input.slice(0, 197)}...`
					: entry.input,
			metadataFile: entry.metadataFile,
			outcome: r.outcome,
			total: r.total,
			pass: r.pass,
			reject: r.reject,
			review: r.review,
			note: r.note,
			perDoi: r.perDoi.map((d) => ({
				doi: d.doi,
				verdict: d.verdict,
				raw: d.raw,
				errorCode: d.errorCode,
			})),
		};
		appendFileSync(
			join(ctx.cwd, CITATION_AUDIT_REL_PATH),
			`${JSON.stringify(logEntry)}\n`,
		);
	} catch {
		// Swallow: audit is observability, not enforcement.
	}
}

// --- Extension entry point ---------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
	// Lazy-import typebox (a bundled Pi peer dep) so the pure helpers above remain importable
	// without it — the unit tests import classify/extractDois directly.
	const { Type } = await import("typebox");
	const INPUT_SCHEMA = Type.Object({
		input: Type.String({
			description:
				"Path to a references file (.bib/.txt/.md/.tex/.csv/.jsonl) OR a literal list of DOIs (comma/newline/space separated).",
		}),
		metadata: Type.Optional(
			Type.String({
				description:
					"Optional path to a JSONL file with per-DOI metadata ({doi, title, first_author, year} one per line). With it, verify-doi can return real PASS/REJECT; without it, the gate runs a dead-DOI/retraction screen (results are REVIEW unless a DOI is dead).",
			}),
		),
	});

	const summarize = (r: GateResult): string => {
		const head = `[ARS citation gate] outcome=${r.outcome.toUpperCase()} · ${r.pass}/${r.total} pass · ${r.reject} reject · ${r.review} review${r.note ? ` · ${r.note}` : ""}`;
		if (r.perDoi.length === 0) return head;
		const lines = r.perDoi.map(
			(d) =>
				`  ${d.verdict.padEnd(6)} ${d.doi}${d.raw ? `  (${d.raw}${d.errorCode ? `/${d.errorCode}` : ""})` : ""}`,
		);
		return `${head}\n${lines.join("\n")}`;
	};

	// Agent-callable tool. Not write/edit/bash → not fenced by the write-scope guard.
	pi.registerTool({
		name: "ars_verify_citations",
		label: "Verify citations",
		description:
			"Run the ARS #182 citation-verification gate via the ref-verify CLI: extract DOIs from the given references file or DOI list, Quick-Screen each against CrossRef/S2/PubMed (existence + retraction), and return a pass/review/fail verdict. Degrades to advisory if ref-verify is not installed.",
		parameters: INPUT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const meta = params.metadata
				? parseMetadataFile(params.metadata)
				: undefined;
			const result = await runGate(readInput(params.input), meta);
			appendCitationAudit(ctx, {
				source: "tool",
				input: params.input,
				metadataFile: params.metadata,
				result,
			});
			const isError = result.outcome === "fail";
			return {
				content: [{ type: "text", text: summarize(result) }],
				details: { ...result },
				isError,
			};
		},
	});

	// User-facing command.
	pi.registerCommand("ars-verify-citations", {
		description:
			"Run the ARS #182 citation-verification gate (ref-verify) on a references file or DOI list. Optional: --metadata <jsonl> for full PASS/REJECT verification.",
		handler: async (args, ctx) => {
			const argv = Array.isArray(args) ? args : String(args ?? "").split(/\s+/);
			const metaIdx = argv.indexOf("--metadata");
			let metadataPath: string | undefined;
			if (metaIdx >= 0 && argv[metaIdx + 1]) {
				metadataPath = argv[metaIdx + 1];
				argv.splice(metaIdx, 2);
			}
			const input = argv.join(" ").trim();
			if (!input) {
				ctx.ui.notify(
					"Usage: /ars-verify-citations <references-file-or-DOIs> [--metadata meta.jsonl]",
					"warning",
				);
				return;
			}
			const meta = metadataPath ? parseMetadataFile(metadataPath) : undefined;
			const result = await runGate(readInput(input), meta);
			appendCitationAudit(ctx, {
				source: "command",
				input,
				metadataFile: metadataPath,
				result,
			});
			const level =
				result.outcome === "fail"
					? "error"
					: result.outcome === "advisory"
						? "warning"
						: "info";
			ctx.ui.notify(summarize(result), level);
		},
	});
}
