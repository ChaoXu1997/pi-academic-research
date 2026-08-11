// Exhaustive decision-profile oracle for panel-synthesis (slice 3b).
// Run via: npm run test:exhaustive
//   (tsc -p tsconfig.test.json && node .test-build/core/panel-synthesis-exhaustive.test.js)
//
// This file is COMPILED by every `npm test` run (type-checked via tsconfig.test.json)
// but is NOT executed by the default test script chain. It must be invoked explicitly.
//
// AC-40: the brute-force oracle over every (D1–D6) scoring combination × D3 split
// states = 13,824 profiles. Every profile fires ≥1 condition, every decision resolves
// to a member of ACTION_ENUM, and the union of all decisions equals ACTION_ENUM.

import {
	evaluate_expression,
	resolve_decision,
	ACTION_ENUM,
} from "./panel-synthesis-core.js";
import {
	load_contract,
	type DimensionScore,
	type SprintContract,
	type ExpressionAtom,
} from "./reviewer-gate-core.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const FULL_PATH = join(
	REPO,
	"upstream",
	"shared",
	"contracts",
	"reviewer",
	"full.json",
);

const FULL: SprintContract = JSON.parse(readFileSync(FULL_PATH, "utf-8"));

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
	} else {
		failed++;
		console.error(`  \u2717 ${name}`);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function state(value: string): DimensionScore {
	if (value === "fatal")
		return { score: "block", block_class: "fatal", trigger: "fatal trigger", abstain_reason: null };
	if (value === "block")
		return { score: "block", block_class: "repairable", trigger: "block trigger", abstain_reason: null };
	if (value === "warn")
		return { score: "warn", block_class: null, trigger: "warn trigger", abstain_reason: null };
	if (value === "abstain")
		return { score: "not_assessed", block_class: null, trigger: null, abstain_reason: "not applicable" };
	return { score: value, block_class: null, trigger: null, abstain_reason: null };
}

function evaluateProfile(
	contract: SprintContract,
	expressions: Record<string, readonly ExpressionAtom[]>,
	assessed: Record<string, DimensionScore[]>,
): [string[], string] {
	const failureConditions = contract.failure_conditions as Record<
		string,
		unknown
	>[];
	const fired = failureConditions
		.filter((condition) =>
			evaluate_expression(
				expressions[condition.condition_id as string],
				assessed,
				condition.cross_reviewer_quantifier as string,
				[],
			),
		)
		.map((condition) => condition.condition_id as string);
	const decision = resolve_decision(failureConditions, new Set(fired));
	return [fired, decision];
}

// ---------------------------------------------------------------------------
// AC-40: 13,824-profile exhaustive
// ---------------------------------------------------------------------------

console.log("AC-40: full 13,824-profile exhaustive");

{
	const [, expressions] = load_contract(FULL_PATH);
	const mandatorySingle = ["pass", "warn", "block", "fatal"];
	const nonmandatorySingle = ["pass", "warn", "block"];
	const d3Values = ["pass", "warn", "block", "fatal", "abstain"];
	// Build D3 split states: all pairs except (abstain, abstain)
	const d3States: [string, string][] = [];
	for (const a of d3Values) {
		for (const b of d3Values) {
			if (a !== "abstain" || b !== "abstain") {
				d3States.push([a, b]);
			}
		}
	}

	let count = 0;
	const decisions = new Set<string>();
	let allFired = true;
	let allValid = true;

	for (const d1 of mandatorySingle) {
		for (const d2 of mandatorySingle) {
			for (const d6 of mandatorySingle) {
				for (const [d3a, d3b] of d3States) {
					for (const d4 of nonmandatorySingle) {
						for (const d5 of nonmandatorySingle) {
							const assessed: Record<string, DimensionScore[]> = {
								D1: [state(d1)],
								D2: [state(d2)],
								D3: [d3a, d3b]
									.filter((v) => v !== "abstain")
									.map((v) => state(v)),
								D4: [state(d4)],
								D5: [state(d5)],
								D6: [state(d6)],
							};
							const [fired, decision] = evaluateProfile(
								FULL,
								expressions,
								assessed,
							);
							if (fired.length === 0) allFired = false;
							if (!ACTION_ENUM.has(decision)) allValid = false;
							decisions.add(decision);
							count++;
						}
					}
				}
			}
		}
	}

	check(`count == 13824 (got ${count})`, count === 13824);
	check("every profile fires ≥1 condition", allFired);
	check("every decision ∈ ACTION_ENUM", allValid);
	check(
		"decisions union == ACTION_ENUM",
		decisions.size === ACTION_ENUM.size &&
			[...decisions].every((d) => ACTION_ENUM.has(d)),
	);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
