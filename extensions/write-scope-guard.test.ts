// Unit tests for the write-scope guard's pure decision core.
// Run: node --experimental-strip-types extensions/write-scope-guard.test.ts
//
// These exercise the ported pure functions directly (no Pi runtime, no subagent registry) by
// passing an explicit subagentName + a real manifest. They mirror the upstream Python guard's
// coverage claim: deterministic for structured tools, wholesale bash deny for Bucket A.

import {
	evaluateDecision,
	manifestKeyFor,
	matchSegments,
	matchesAny,
	loadManifest,
} from "./write-scope-guard.js";

const WS = process.cwd();
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}`);
	}
}

function decide(toolName: string, input: any, subagentName: string | null) {
	const manifest = loadManifest()!;
	return evaluateDecision(toolName, input, WS, WS, subagentName, manifest);
}

console.log("manifest + name mapping");
{
	check("manifest loads", loadManifest() !== null);
	check(
		"kebab draft-writer → draft_writer_agent",
		manifestKeyFor("draft-writer") === "draft_writer_agent",
	);
	check("kebab eic → eic_agent", manifestKeyFor("eic") === "eic_agent");
	check(
		"all 23 manifest keys resolve from a kebab name",
		Object.keys(loadManifest()!.agents).every(
			(k) => manifestKeyFor(k.replace(/_agent$/, "").replace(/_/g, "-")) === k,
		),
	);
}

console.log("glob matcher semantics (faithful to upstream)");
{
	// `phase1_*/**` matches a file UNDER a phase1 dir, NOT a root file masquerading as the dir.
	check(
		"phase1_x/file.md matches phase1_*/**",
		matchesAny("phase1_x/file.md", ["phase1_*/**"]),
	);
	check(
		"root file phase1_x.md does NOT match phase1_*/** (segment-aware)",
		!matchesAny("phase1_x.md", ["phase1_*/**"]),
	);
	// `**/name` matches in a subdir but NOT at root.
	check("sub/x.md matches **/x.md", matchesAny("sub/x.md", ["**/x.md"]));
	check(
		"root x.md does NOT match **/x.md (needs bare entry)",
		!matchesAny("x.md", ["**/x.md"]),
	);
	check("root x.md matches bare x.md", matchesAny("x.md", ["x.md"]));
	// `*` never crosses `/`.
	check("a/b matches a/*", matchesAny("a/b", ["a/*"]));
	check(
		"a/b/c does NOT match a/* (* stays in one segment)",
		!matchesAny("a/b/c", ["a/*"]),
	);
	check(
		"matchSegments deep nesting (2000 segments) does not overflow",
		matchSegments(Array(2000).fill("a"), ["**"]) === true,
	);
}

console.log("Bucket A phase fencing (structured tools)");
{
	// bibliography_agent → phase2_*/** only.
	const inScope = decide(
		"write",
		{ path: "phase2_lit/pre_screened.txt" },
		"bibliography",
	);
	check("bibliography writes phase2 → allow", inScope.decision === "allow");

	const outOfScope = decide(
		"write",
		{ path: "phase1_rq/question.md" },
		"bibliography",
	);
	check(
		"bibliography writes phase1 → deny",
		outOfScope.decision === "deny" &&
			/outside allowed_write_globs/.test(outOfScope.reason ?? ""),
	);

	// draft-writer is the dual-phase union (phase4 + phase6).
	const p4 = decide("write", { path: "phase4_draft/paper.md" }, "draft-writer");
	check("draft-writer writes phase4 → allow", p4.decision === "allow");
	const p6 = decide(
		"edit",
		{ path: "phase6_rev/patch.json", edits: [] },
		"draft-writer",
	);
	check(
		"draft-writer writes phase6 → allow (dual union)",
		p6.decision === "allow",
	);
	const p3 = decide("write", { path: "phase3_x/y.md" }, "draft-writer");
	check("draft-writer writes phase3 → deny", p3.decision === "deny");
}

console.log("Bash policy");
{
	const bDenied = decide("bash", { command: "ls" }, "bibliography");
	check(
		"Bucket A bash → deny",
		bDenied.decision === "deny" &&
			/may not use bash/.test(bDenied.reason ?? ""),
	);
	const bMain = decide("bash", { command: "rm -rf /" }, null);
	check(
		"main session bash → allow (unconstrained)",
		bMain.decision === "allow",
	);
}

console.log("Non-Bucket-A / main session");
{
	const mainWrite = decide("write", { path: "phase1_rq/q.md" }, null);
	check(
		"main session writes phase dir → allow",
		mainWrite.decision === "allow",
	);
	// A subagent NOT in the manifest (e.g. the deep-research devils-advocate) is unconstrained.
	const nonA = decide("write", { path: "phase1_rq/q.md" }, "devils-advocate");
	check("non-manifest subagent write → allow", nonA.decision === "allow");
}

console.log("Infra self-protection (every actor)");
{
	const infra = decide(
		"write",
		{ path: "extensions/write-scope-guard.ts" },
		null,
	);
	check(
		"main session rewrites the guard → deny",
		infra.decision === "deny" &&
			/enforcement infrastructure/.test(infra.reason ?? ""),
	);
	const manifestWrite = decide(
		"write",
		{ path: "extensions/ars_phase_scope_manifest.json" },
		"formatter",
	);
	check("agent rewrites manifest → deny", manifestWrite.decision === "deny");
	const subagentDef = decide(
		"edit",
		{ path: "subagents/bibliography.md", edits: [] },
		"bibliography",
	);
	check(
		"agent rewrites a subagent def → deny",
		subagentDef.decision === "deny",
	);
}

console.log("Path traversal / escape");
{
	// A Bucket A agent trying to escape via `..`.
	const escape = decide(
		"write",
		{ path: "phase2_x/../../etc/passwd" },
		"bibliography",
	);
	check("Bucket A traversal → deny", escape.decision === "deny");
}

console.log("Schema drift (fail loud, not open)");
{
	const noPath = decide("write", { content: "x" }, "bibliography");
	check(
		"write without path → deny",
		noPath.decision === "deny" && /unexpected schema/.test(noPath.reason ?? ""),
	);
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
