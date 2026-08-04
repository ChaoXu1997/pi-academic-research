// End-to-end integration test for the citation gate against a REAL ref-verify install + live
// CrossRef. Self-skips (exit 0) if ref-verify is not installed or unreachable, so it can live in
// the suite without making CI/network a hard dependency.
//
// Run: tsc -p tsconfig.test.json && node .test-build/citation-gate.e2e.test.js

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, parseMetadataFile } from "./citation-gate.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.error(`  \u2717 ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

// Skip if ref-verify is not installed.
let haveRefVerify = false;
try {
	execFileSync("ref-verify", ["--help"], { stdio: "ignore", timeout: 8000 });
	haveRefVerify = true;
} catch {
	haveRefVerify = false;
}

if (!haveRefVerify) {
	console.log(
		"SKIP — ref-verify CLI not installed (install: pipx install Moonweave-Research/ref-verify)",
	);
	console.log("0 passed, 0 failed (skipped)");
	process.exit(0);
}

const PELRINE = "10.1126/science.287.5454.836"; // Pelrine 2000, Science — a real, well-indexed DOI.

console.log("end-to-end (real ref-verify + live CrossRef)");
{
	// 1. Metadata mode, correct metadata → PASS.
	const dir = mkdtempSync(join(tmpdir(), "ars-e2e-"));
	const metaPath = join(dir, "meta.jsonl");
	writeFileSync(
		metaPath,
		JSON.stringify({
			doi: PELRINE,
			title:
				"High-Speed Electrically Actuated Elastomers with Strain Greater Than 100%",
			first_author: "Pelrine",
			year: 2000,
		}) + "\n",
	);
	const meta = parseMetadataFile(metaPath);
	const res = await runGate(PELRINE, meta);
	check(
		`metadata-correct → outcome pass (got ${res.outcome}, ${res.pass}/${res.total} pass)`,
		res.outcome === "pass" && res.pass === 1,
		JSON.stringify(res.perDoi[0]),
	);

	// 2. Bare mode (no metadata) → REVIEW for every DOI (insufficient-metadata WARN).
	const bare = await runGate(PELRINE);
	check(
		`bare mode → outcome review (got ${bare.outcome}, ${bare.review} review)`,
		bare.outcome === "review" && bare.review === 1,
		JSON.stringify(bare.perDoi[0]),
	);

	// 3. Dead/fake DOI → REJECT → outcome fail.
	const fake = await runGate("10.9999/fake.nonexistent.doi.xyz");
	check(
		`dead DOI → outcome fail (got ${fake.outcome}, ${fake.reject} reject)`,
		fake.outcome === "fail" && fake.reject === 1,
		JSON.stringify(fake.perDoi[0]),
	);
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
