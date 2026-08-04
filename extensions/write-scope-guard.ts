/**
 * ARS write-scope guard — Pi extension port of upstream
 * `upstream/scripts/ars_write_scope_guard.py` + `upstream/hooks/run_guard.sh`.
 *
 * Spec: docs/design/2026-06-01-ars-134-conductor-rescope-deterministic-write-guard-spec.md
 *
 * Blocks out-of-scope writes by the 23 Bucket A single-phase subagents, backed by the
 * machine-readable scope manifest at `extensions/ars_phase_scope_manifest.json` (a verbatim
 * copy of the upstream `ars_phase_scope_manifest.json`).
 *
 * PI PORT NOTES — how this differs from the Claude Code original:
 *
 * 1. HOOK SURFACE. Claude Code wires a `PreToolUse` shell hook (`hooks.json` + `run_guard.sh`)
 *    that re-invokes the Python guard per call. Pi has no `PreToolUse`; instead this file is a Pi
 *    extension that subscribes to the `tool_call` event, which fires before a tool executes and
 *    CAN block (`return { block: true, reason }`). Pi subagents run as in-process AgentSessions
 *    (NOT subprocesses), and the subagents runner inherits parent extensions into the subagent
 *    session after filtering them to the `tool_call` / `tool_result` / `user_bash` events
 *    (see `isolateSubagentExtensions` in pi-subagents-j0k3r). So this handler DOES fire inside a
 *    subagent session for that subagent's own tool calls — exactly the surface the guard needs.
 *
 * 2. AGENT IDENTITY. Claude Code's hook payload carries `agent_type` (the subagent frontmatter
 *    `name`). Pi does NOT pass a subagent identifier on the `tool_call` event. We recover it from
 *    the pi-subagents interaction-session registry: a Map keyed by sessionId, exposed on a global
 *    Symbol `Symbol.for("pi.subagents.interactionSessions")`, whose values carry
 *    `requester.subagentName` (the subagent's kebab-case frontmatter `name`, e.g. "draft-writer").
 *    If that lookup fails (registry absent, different subagent runtime, or this is the main
 *    session), we treat the actor as UNCONSTRAINED — matching the upstream's "absent agent_type
 *    ⇒ main session, unconstrained" posture. This coupling is to the public-ish global Symbol the
 *    subagents package itself uses; if it ever changes, the guard degrades safely to allow.
 *
 * 3. NAME MAPPING. The manifest keys are the upstream snake_case `_agent` names
 *    (`draft_writer_agent`); the Pi subagent frontmatter `name`s are kebab-case
 *    (`draft-water`). The mapping is mechanical: kebab→underscore, append `_agent`. All 23
 *    Bucket A agents map 1:1.
 *
 * 4. TOOL SHAPES. Pi has no MultiEdit (its `edit` tool already takes one `path` + multiple
 *    `edits[]` to that single file), and its write/edit tools use `path` (not `file_path`).
 *    Tool names are lower-case: `write`, `edit`, `bash`.
 *
 * POSTURE (faithful to upstream §3.2): the guard is OPTIONAL hardening that ONLY ADDS denials.
 * On any internal error (unreadable manifest, registry shape drift, a thrown exception) it fails
 * OPEN (allows) and never wedges the session. It never emits an explicit "allow" that would skip
 * Pi's other permission rules — non-deny is simply a fall-through (no return value).
 *
 * COVERAGE CLAIM — same as upstream, stated precisely:
 *   * DETERMINISTIC for the structured editing tools (`write`/`edit`): a write outside the agent's
 *     declared scope is denied regardless of the agent's prompt. This is the load-bearing win.
 *   * `bash` for a Bucket A agent: DENIED WHOLESALE (neither "writes a file" nor "is read-only" is
 *     decidable from a command string; all-deny is the only zero-fail-open policy). The agent uses
 *     the grep/find/read tools to inspect and write/edit to write.
 *   This is NOT "deterministic enforcement of all writes" — it is deterministic for the structured
 *   tools plus a clean wholesale bash deny for fenced agents.
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

// --- Manifest ---------------------------------------------------------------

interface AgentScope {
	bucket: string;
	skill: string;
	phase: string;
	allowed_write_globs: string[];
	known_named_outputs?: string[];
}

interface ScopeManifest {
	version: number;
	agents: Record<string, AgentScope>;
}

const MANIFEST_FILENAME = "ars_phase_scope_manifest.json";

let cachedManifest: ScopeManifest | null = null;

function loadManifest(): ScopeManifest | null {
	if (cachedManifest) return cachedManifest;
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const raw = readFileSync(join(here, MANIFEST_FILENAME), "utf-8");
		const parsed = JSON.parse(raw) as ScopeManifest;
		if (parsed && typeof parsed === "object" && parsed.agents) {
			cachedManifest = parsed;
			return cachedManifest;
		}
	} catch {
		// Unreadable / malformed manifest → fail open (allow). Never wedge the session.
	}
	return null;
}

// --- Infra self-protection --------------------------------------------------
// Workspace-root-relative glob patterns that NO actor may write — tampering with these would
// either neuter the guard (rewriting the extension/manifest) or move an agent out of the manifest
// (rewriting a subagent definition's name binding). This is the Pi-port analogue of the upstream
// INFRA_PROTECTED_GLOBS, adapted to this package's layout.
const INFRA_PROTECTED_GLOBS: string[] = [
	// The guard itself + its manifest (basename in any subdir AND at workspace root — a deny-list
	// widening only protects MORE paths, so covering both forms is safe).
	"**/write-scope-guard.ts",
	"write-scope-guard.ts",
	"**/ars_phase_scope_manifest.json",
	"ars_phase_scope_manifest.json",
	// The package manifest — its `pi.extensions` binding wires this guard.
	"package.json",
	// The ported subagent definitions — frontmatter `name` is the manifest key binding.
	"subagents/*.md",
	// The vendored upstream enforcement surface (if shipped).
	"upstream/hooks/hooks.json",
	"upstream/hooks/*.sh",
	"upstream/.claude-plugin/plugin.json",
	"**/ars_write_scope_guard.py",
	"**/check_v3_10_134_write_scope.py",
	"upstream/**/*.md",
];

// --- Pure path/glob helpers (faithful port of the Python) -------------------

/**
 * Resolve a raw target to a workspace-root-relative canonical path.
 * Returns `{ rel, escaped }`; `escaped` is true when the target resolves OUTSIDE the workspace
 * root (path traversal / symlink escape). Resolves symlinks on the existing parent chain WITHOUT
 * requiring the leaf to exist (the write may create it), so `phase2_x/../hooks/hooks.json` is
 * canonicalized to `hooks/hooks.json` BEFORE any glob match runs.
 *
 * NOTE: Node's `fs.realpathSync` fails if the leaf doesn't exist, so we resolve the existing
 * prefix (dirname chain) and re-append the not-yet-created tail. This mirrors Python's
 * `os.path.realpath` which tolerates a non-existent leaf.
 */
function normalizeTarget(
	rawPath: string,
	cwd: string,
	workspaceRoot: string,
): { rel: string | null; escaped: boolean } {
	const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
	const realWs = realpathSync(workspaceRoot);
	let normalized: string;
	try {
		normalized = realpathTolerant(abs);
	} catch {
		return { rel: null, escaped: true };
	}
	try {
		// Containment test via the common prefix of the real paths.
		if (!normalized.startsWith(realWs + "/") && normalized !== realWs) {
			return { rel: null, escaped: true };
		}
	} catch {
		return { rel: null, escaped: true };
	}
	const rel = normalized === realWs ? "." : normalized.slice(realWs.length + 1);
	if (rel === ".") return { rel: null, escaped: true };
	return { rel, escaped: false };
}

/**
 * realpath that tolerates a not-yet-created leaf: resolve the longest existing ancestor, then
 * re-append the missing tail. Falls back to `resolve()` (lexical) only if nothing on the chain
 * exists. Importantly we follow symlinks on the EXISTING prefix so a symlinked phase dir can't
 * blind the guard.
 */
function realpathTolerant(absPath: string): string {
	let dir = absPath;
	const tail: string[] = [];
	while (true) {
		try {
			const real = realpathSync(dir);
			return tail.length === 0 ? real : resolve(real, ...tail);
		} catch (e: any) {
			if (e && e.code === "ENOENT") {
				// Walk up one segment; remember it for re-appending.
				const seg = basename(dir);
				tail.unshift(seg);
				const parent = dirname(dir);
				if (parent === dir) return resolve(absPath); // reached root without a real node
				dir = parent;
			} else {
				throw e;
			}
		}
	}
}

// (basename / dirname / realpathSync are imported at the top of the module.)

/**
 * Path-segment-aware glob match. A `*`/`?` matches only WITHIN one segment (never across `/`);
 * the literal segment `**` matches ONE OR MORE whole segments (a descendant — NOT zero, so
 * `dir/**` covers files UNDER dir, not the bare dir node). Iterative (worklist + visited set) so
 * it cannot stack-overflow on deep paths — a faithful port of the Python `_match_segments`.
 */
function matchSegments(pathSegs: string[], patSegs: string[]): boolean {
	const n = pathSegs.length;
	const m = patSegs.length;
	const stack: Array<[number, number]> = [[0, 0]];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const [i, j] = stack.pop()!;
		const key = `${i},${j}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (j === m) {
			if (i === n) return true;
			continue; // pattern exhausted but path remains → this branch fails
		}
		const head = patSegs[j];
		if (head === "**") {
			// `**` consumes ONE OR MORE segments: needs >=1 remaining path segment.
			if (i < n) {
				stack.push([i + 1, j + 1]); // `**` ate exactly this segment
				stack.push([i + 1, j]); // `**` keeps eating
			}
			continue;
		}
		if (i < n && globSegment(pathSegs[i], head)) {
			stack.push([i + 1, j + 1]);
		}
	}
	return false;
}

/** Single-segment fnmatch (`*`/`?`/`[...]`, never crossing `/`). */
function globSegment(str: string, pat: string): boolean {
	// Iterative backtracking matcher equivalent to Python's fnmatch.fnmatchcase (POSIX, case-aware).
	const s = [...str];
	const p = [...pat];
	const memo = new Set<string>();
	const stack: Array<[number, number]> = [[0, 0]];
	while (stack.length > 0) {
		const [i, j] = stack.pop()!;
		const k = `${i},${j}`;
		if (memo.has(k)) continue;
		memo.add(k);
		if (j === p.length) {
			if (i === s.length) return true;
			continue;
		}
		const pc = p[j];
		if (pc === "*") {
			// `*` matches zero or more of the remaining chars in THIS segment.
			stack.push([i, j + 1]); // match zero
			if (i < s.length) stack.push([i + 1, j]); // consume one more
			continue;
		}
		if (pc === "?") {
			if (i < s.length) stack.push([i + 1, j + 1]);
			continue;
		}
		if (pc === "[") {
			const cls = parseCharClass(p, j);
			if (cls) {
				const [set, negate, nextJ] = cls;
				if (i < s.length) {
					const inSet = set.has(s[i]);
					if (negate ? !inSet : inSet) stack.push([i + 1, nextJ]);
				}
				continue;
			}
			// Malformed `[` → treat literally.
		}
		if (i < s.length && s[i] === pc) stack.push([i + 1, j + 1]);
	}
	return false;
}

/** Parse a `[...]` character class starting at index j (the `[`). Returns [set, negate, nextIndex]. */
function parseCharClass(
	p: string[],
	j: number,
): [Set<string>, boolean, number] | null {
	if (p[j] !== "[") return null;
	let k = j + 1;
	let negate = false;
	if (k < p.length && (p[k] === "!" || p[k] === "^")) {
		negate = true;
		k++;
	}
	const set = new Set<string>();
	const start = k;
	// A leading `]` is literal.
	if (k < p.length && p[k] === "]") {
		set.add("]");
		k++;
	}
	while (k < p.length && p[k] !== "]") {
		if (p[k] === "-" && k + 1 < p.length && p[k + 1] !== "]" && k > start) {
			// Range a-z.
			const lo = p[k - 1].charCodeAt(0);
			const hi = p[k + 1].charCodeAt(0);
			for (let c = lo; c <= hi; c++) set.add(String.fromCharCode(c));
			k += 2;
		} else {
			set.add(p[k]);
			k++;
		}
	}
	if (k >= p.length) return null; // no closing `]` → malformed
	return [set, negate, k + 1];
}

/**
 * Workspace-root-anchored glob match against the normalized relative path.
 * Conventions: a trailing double-star segment matches anything strictly UNDER that dir;
 * a leading double-star segment matches `name` in any subdir (NOT at root, so a root-level
 * `name` needs the bare `name` entry too — which the infra list carries).
 */
function matchesAny(relPath: string, globs: string[]): boolean {
	// On POSIX, `\` is a legal filename char — do NOT rewrite it to `/` (that would let a root
	// file `phase2_x\notes.md` masquerade as a dir). Only normalize on Windows where `\` is sep.
	const normalized =
		process.platform === "win32" ? relPath.replace(/\\/g, "/") : relPath;
	const segs = normalized.split("/").filter((s) => s !== "" && s !== ".");
	for (const g of globs) {
		const pat = g.split("/").filter((s) => s !== "");
		if (matchSegments(segs, pat)) return true;
	}
	return false;
}

// --- Subagent identity ------------------------------------------------------

const INTERACTION_REGISTRY_SYMBOL = Symbol.for(
	"pi.subagents.interactionSessions",
);

interface InteractionMetadata {
	origin?: string;
	requester?: { subagentName?: string; description?: string; taskId?: string };
}

/**
 * Resolve the kebab-case subagent `name` for the currently-executing session, or null if this is
 * the main session / a non-pi-subagents runtime. Queries the global interaction-session registry
 * the pi-subagents runner maintains.
 */
function currentSubagentName(ctx: ExtensionContext): string | null {
	try {
		const sessionId =
			(ctx.sessionManager as any)?.getSessionId?.() ??
			(ctx as any).sessionId ??
			null;
		if (typeof sessionId !== "string" || sessionId.length === 0) return null;
		const registry = (globalThis as any)[INTERACTION_REGISTRY_SYMBOL] as
			| Map<string, InteractionMetadata>
			| undefined;
		if (!registry || typeof registry.get !== "function") return null;
		const meta = registry.get(sessionId);
		if (meta && meta.origin === "subagent" && meta.requester?.subagentName) {
			return meta.requester.subagentName;
		}
	} catch {
		// Registry shape drift → fail open (treat as main session).
	}
	return null;
}

/** kebab-case Pi subagent name → upstream manifest key: `draft-writer` → `draft_writer_agent`. */
function manifestKeyFor(subagentName: string): string {
	return `${subagentName.replace(/-/g, "_")}_agent`;
}

// --- Decision core ----------------------------------------------------------

type Decision =
	| { decision: "allow"; reason?: string }
	| { decision: "deny"; reason: string };

const INSPECTED_TOOLS = new Set(["write", "edit", "bash"]);

/** Extract the single target path from a structured write tool call (Pi uses `path`). */
function extractStructuredTarget(input: any): string | null {
	if (!input || typeof input !== "object") return null;
	const fp = input.path ?? input.file_path;
	return typeof fp === "string" && fp.length > 0 ? fp : null;
}

/** Is the target one of THIS package's own enforcement files? (anchored on workspace root). */
function isInfraProtected(relPath: string): boolean {
	return matchesAny(relPath, INFRA_PROTECTED_GLOBS);
}

function evaluateDecision(
	toolName: string,
	input: any,
	cwd: string,
	workspaceRoot: string,
	subagentName: string | null,
	manifest: ScopeManifest,
): Decision {
	const isBucketA =
		Boolean(subagentName) && manifestKeyFor(subagentName!) in manifest.agents;

	// Bash path: DENY ALL for a Bucket A agent; pass through otherwise.
	if (toolName === "bash") {
		if (isBucketA) {
			return {
				decision: "deny",
				reason:
					`ARS scope guard: ${subagentName} (a single-phase agent) may not use bash. ` +
					"Use the grep/find/read tools to inspect and the write/edit tools to write — those are " +
					"scope-enforced deterministically. Bash is denied wholesale because neither 'writes a " +
					"file' nor 'is read-only' can be decided reliably from a command string (a tool can " +
					"spawn a subprocess or be steered by an env var); all-deny is the only zero-fail-open policy.",
			};
		}
		return { decision: "allow" };
	}

	// Structured tools: extract + normalize the single target path.
	const raw = extractStructuredTarget(input);
	if (raw === null) {
		// Schema drift → deny + advisory so the guard cannot silently fail open.
		return {
			decision: "deny",
			reason:
				`ARS scope guard: ${toolName} payload carried no \`path\` (unexpected schema) — ` +
				"denying to avoid silent fail-open. Re-verify the tool input shape.",
		};
	}

	// Step 1: normalize against workspace root (escape / traversal check).
	const { rel, escaped } = normalizeTarget(raw, cwd, workspaceRoot);

	// Step 2: infra self-protection (runs first; applies to EVERY actor including the main session).
	// We check the normalized rel when available, and ALSO the raw lexically-normalized form, so a
	// not-yet-existing target or a symlinked path can't slip past.
	const lexRel = lexicalRel(raw, cwd, workspaceRoot);
	if ((rel && isInfraProtected(rel)) || (lexRel && isInfraProtected(lexRel))) {
		return {
			decision: "deny",
			reason:
				`ARS scope guard: ${raw} is part of the ARS package's enforcement infrastructure ` +
				"and may not be written by any agent.",
		};
	}

	if (escaped) {
		// Escape / traversal deny is a BUCKET A fence only (#302): the main session and non-Bucket-A
		// agents are unconstrained (a main-session write to a sibling worktree resolves outside the
		// workspace root and must be allowed). Infra protection already ran above.
		if (isBucketA) {
			return {
				decision: "deny",
				reason: `ARS scope guard: ${subagentName} write target ${JSON.stringify(raw)} escapes the workspace root (path traversal) — denied.`,
			};
		}
		return { decision: "allow" };
	}

	// Step 3: agent gating — non-Bucket-A actors are unconstrained.
	if (!isBucketA) return { decision: "allow" };

	// Step 4: Bucket A glob check.
	const allowed =
		manifest.agents[manifestKeyFor(subagentName!)].allowed_write_globs ?? [];
	if (!matchesAny(rel!, allowed)) {
		return {
			decision: "deny",
			reason:
				`ARS scope guard: ${subagentName} may not write ${rel} ` +
				`(outside allowed_write_globs ${JSON.stringify(allowed)}).`,
		};
	}
	return { decision: "allow" };
}

/** Lexical (no symlink resolution) workspace-relative path, for a second infra check pass. */
function lexicalRel(
	rawPath: string,
	cwd: string,
	workspaceRoot: string,
): string | null {
	try {
		const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
		const ws = resolve(workspaceRoot);
		if (abs === ws) return null;
		if (abs.startsWith(ws + "/") || abs.startsWith(ws + "\\")) {
			return abs.slice(ws.length + 1).replace(/\\/g, "/");
		}
	} catch {
		// ignore → null
	}
	return null;
}

// --- Testable surface (named exports for unit tests) ----------------------

export {
	evaluateDecision,
	matchSegments,
	matchesAny,
	manifestKeyFor,
	loadManifest,
};
export type { Decision, ScopeManifest, AgentScope };

// --- Audit trail (best-effort, never blocks) --------------------------------
// Appends one JSON line per inspected decision to <workspace>/.pi/ars-write-scope-audit.jsonl.
// Borrowed from pi-secured-setup / pi-access-guard. Any failure is swallowed: a logging
// error must never block a legitimate decision or wedge the session. The .pi/ dir is
// gitignored runtime state, so the log never lands in version control.
const AUDIT_REL_PATH = ".pi/ars-write-scope-audit.jsonl";

function auditTarget(toolName: string, input: any): string {
	if (!input || typeof input !== "object") return "";
	if (toolName === "bash") {
		const c = typeof input.command === "string" ? input.command : "";
		return c.length > 120 ? `${c.slice(0, 117)}...` : c;
	}
	const p = input.path ?? input.file_path;
	return typeof p === "string" ? p : "";
}

function appendAudit(
	ctx: ExtensionContext,
	entry: Record<string, unknown>,
): void {
	try {
		try {
			mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
		} catch {}
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		appendFileSync(join(ctx.cwd, AUDIT_REL_PATH), `${line}\n`);
	} catch {
		// Swallow: audit is observability, not enforcement.
	}
}

// --- Extension entry point --------------------------------------------------

export default function (pi: any): void {
	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		const toolName = event.toolName;
		if (!INSPECTED_TOOLS.has(toolName)) return; // read/grep/find/ls/custom → pass through

		const manifest = loadManifest();
		if (!manifest) return; // manifest unreadable → fail open

		let subagentName: string | null = null;
		let decision: Decision;
		try {
			subagentName = currentSubagentName(ctx);
			decision = evaluateDecision(
				toolName,
				(event as any).input,
				ctx.cwd,
				ctx.cwd,
				subagentName,
				manifest,
			);
		} catch {
			// Any internal error → fail open. Never wedge the session.
			return;
		}

		appendAudit(ctx, {
			subagent: subagentName,
			tool: toolName,
			target: auditTarget(toolName, (event as any).input),
			decision: decision.decision,
			...(decision.reason ? { reason: decision.reason } : {}),
		});

		if (decision.decision === "deny") {
			return { block: true, reason: decision.reason };
		}
		// Non-deny → fall through (no return). We never emit an explicit "allow" that would skip
		// Pi's other permission rules; the guard only ADDS denials.
		return;
	});
}
