// Unit tests for the citation-gate pure logic (DOI extraction + verdict classification).
// Run via: tsc -p tsconfig.test.json && node .test-build/citation-gate.test.js
// (The end-to-end runGate needs the ref-verify CLI installed; these tests cover the bug-prone
// parsing layer that does NOT need it.)

import { classify, extractDois, appendCitationAudit } from "./citation-gate.js";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.error(`  \u2717 ${name}`);
	}
}

console.log("DOI extraction");
{
	const dois = extractDois(
		"see 10.1126/science.287.5454.836 and also 10.1016/j.cell.2023.01.001; plus 10.48550/arXiv.2401.00001.",
	);
	check("extracts 3 DOIs", dois.length === 3);
	check("keeps the first", dois.includes("10.1126/science.287.5454.836"));
	check(
		"strips trailing punctuation (period)",
		dois.includes("10.1016/j.cell.2023.01.001"),
	);
	check("handles arXiv-style", dois.includes("10.48550/arXiv.2401.00001"));
	check(
		"strips BibTeX trailing brace",
		extractDois("10.1234/test.123},")[0] === "10.1234/test.123",
	);
	check("dedupes", extractDois("10.1234/aaa 10.1234/aaa").length === 1);
	check("empty input → none", extractDois("no dois here").length === 0);
	check(
		"ignores too-short prefix (10.1/x fails the >=4-digit DOI regex)",
		extractDois("10.1/x").length === 0,
	);
}

console.log("verdict classification (PASS / REJECT / REVIEW)");
{
	// Calibrated against real ref-verify 1.2.0 JSON shapes:
	//   PASS:  {"verdict":"PASS", "mismatches":[], ...}            (metadata matches)
	//   WARN:  {"verdict":"WARN", ...}                              (minor mismatch OR insufficient metadata)
	//   DEAD:  {"error":"HTTP Error 404: Not Found"}  (no verdict!) (DOI does not resolve)
	// Note: exit code is NOT reliable (minor-mismatch WARN exits 0; insufficient-metadata WARN exits 2).

	// No JSON at all → REVIEW regardless of exit code (exit 0 isn't a reliable PASS signal).
	check(
		"no json exit 0 → REVIEW (exit code unreliable)",
		classify("", 0).verdict === "REVIEW",
	);
	check("no json non-zero → REVIEW", classify("", 2).verdict === "REVIEW");
	// JSON verdict PASS
	const p = classify(JSON.stringify({ verdict: "PASS", mismatches: [] }), 0);
	check("json verdict PASS → PASS", p.verdict === "PASS");
	// JSON verdict REJECT → REJECT (hard fail)
	const r = classify(JSON.stringify({ verdict: "REJECT" }), 1);
	check("json verdict REJECT → REJECT", r.verdict === "REJECT");
	// JSON verdict WARN → REVIEW (real shape: insufficient-metadata OR minor mismatch)
	const w = classify(
		JSON.stringify({
			verdict: "WARN",
			reason: "Insufficient citation metadata...",
		}),
		2,
	);
	check("json verdict WARN → REVIEW", w.verdict === "REVIEW");
	// DEAD DOI: {"error":"HTTP Error 404..."} with NO verdict → REJECT (the load-bearing real-shape case)
	const dead = classify(
		JSON.stringify({ error: "HTTP Error 404: Not Found" }),
		1,
	);
	check("error 404 (no verdict) → REJECT", dead.verdict === "REJECT");
	// JSON error_code DOI_MISMATCH → REJECT even without verdict token
	const m = classify(JSON.stringify({ error_code: "DOI_MISMATCH" }), 1);
	check("error_code DOI_MISMATCH → REJECT", m.verdict === "REJECT");
	// JSON error_code RETRACTED → REJECT
	check(
		"error_code RETRACTED → REJECT",
		classify(JSON.stringify({ error_code: "RETRACTED" }), 1).verdict ===
			"REJECT",
	);
	// JSON error_code NO_ABSTRACT → REVIEW (unverifiable, not wrong)
	const u = classify(JSON.stringify({ error_code: "NO_ABSTRACT" }), 1);
	check("error_code NO_ABSTRACT → REVIEW", u.verdict === "REVIEW");
	// JSON error_code CLAIM_SUPPORTED → PASS
	check(
		"CLAIM_SUPPORTED → PASS",
		classify(JSON.stringify({ error_code: "CLAIM_SUPPORTED" }), 0).verdict ===
			"PASS",
	);
	// malformed JSON → REVIEW regardless of exit (cannot confirm)
	check(
		"malformed json exit 0 → REVIEW",
		classify("{not json", 0).verdict === "REVIEW",
	);
	check(
		"malformed json exit 1 → REVIEW",
		classify("{not json", 1).verdict === "REVIEW",
	);
}

console.log("audit trail");
{
	const dir = mkdtempSync(join(tmpdir(), "ars-cite-audit-"));
	try {
		const ctx = { cwd: dir } as any;
		appendCitationAudit(ctx, {
			source: "tool",
			input: "10.1126/science.287.5454.836",
			metadataFile: undefined,
			result: {
				outcome: "pass",
				total: 1,
				pass: 1,
				reject: 0,
				review: 0,
				perDoi: [{ doi: "10.1126/science.287.5454.836", verdict: "PASS" }],
			},
		});
		const logPath = join(dir, ".pi", "ars-citation-audit.jsonl");
		check("audit file written", existsSync(logPath));
		const raw = readFileSync(logPath, "utf-8").trim();
		const entry = JSON.parse(raw);
		check("audit entry has ts", typeof entry.ts === "string");
		check("audit entry records outcome=pass", entry.outcome === "pass");
		check("audit entry records source=tool", entry.source === "tool");
		check(
			"audit entry has perDoi[0].doi",
			entry.perDoi[0]?.doi === "10.1126/science.287.5454.836",
		);
		check(
			"audit truncates long input (200+ char)",
			(() => {
				const longDir = mkdtempSync(join(tmpdir(), "ars-cite-audit-long-"));
				try {
					appendCitationAudit({ cwd: longDir } as any, {
						source: "command",
						input: "x".repeat(300),
						result: {
							outcome: "advisory",
							total: 0,
							pass: 0,
							reject: 0,
							review: 0,
							perDoi: [],
						},
					});
					const e = JSON.parse(
						readFileSync(
							join(longDir, ".pi", "ars-citation-audit.jsonl"),
							"utf-8",
						),
					);
					return (
						typeof e.input === "string" &&
						e.input.endsWith("...") &&
						e.input.length === 200
					);
				} finally {
					rmSync(longDir, { recursive: true, force: true });
				}
			})(),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
