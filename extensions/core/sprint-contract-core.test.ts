// Unit tests for the sprint-contract pure validation core.
// Run via: tsc -p tsconfig.test.json && node .test-build/core/sprint-contract-core.test.js
//
// These tests port the upstream Python oracle
// (upstream/scripts/test_check_sprint_contract.py) into the Pi TS test harness:
//   * 34 SCHEMA_MUTATIONS — each must be REJECTED by validate() (AC-3)
//   * 4 shipped templates — each must PASS validate() + check_structural_invariants() (AC-4)
//   * structural / mode-conditional / scoring / F0 / eligibility cases (AC-3b..AC-8)
// This is the AC-17 oracle: if all 34 reject + 4 templates pass, zero-deps is preserved.

import {
	validate,
	check_structural_invariants,
	ROLE_SETS,
	EXPECTED_PANEL_SIZE,
	type SprintContract,
} from "./sprint-contract-core.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// From .test-build/core/ → project root is ../../
const REPO = join(HERE, "..", "..");
const FULL_PATH = join(REPO, "upstream", "shared", "contracts", "reviewer", "full.json");
const MF_PATH = join(REPO, "upstream", "shared", "contracts", "reviewer", "methodology_focus.json");
const WRITER_PATH = join(REPO, "upstream", "shared", "contracts", "writer", "full.json");
const EVALUATOR_PATH = join(REPO, "upstream", "shared", "contracts", "evaluator", "full.json");

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

function load(path: string): SprintContract {
	return JSON.parse(readFileSync(path, "utf-8")) as SprintContract;
}

function full(): SprintContract {
	return load(FULL_PATH);
}

function clone<T>(x: T): T {
	return JSON.parse(JSON.stringify(x)) as T;
}

// ---------------------------------------------------------------------------
// AC-4 (critical for fail-closed gate): 4 shipped templates pass
// ---------------------------------------------------------------------------

console.log("test_shipped_templates_validate");
for (const [label, path] of [
	["reviewer_full", FULL_PATH],
	["reviewer_methodology_focus", MF_PATH],
	["writer_full", WRITER_PATH],
	["evaluator_full", EVALUATOR_PATH],
] as const) {
	const contract = load(path);
	const schemaErrors = validate(contract);
	const structErrors = check_structural_invariants(contract);
	check(`${label} validate() == []`, schemaErrors.length === 0);
	check(
		`${label} check_structural_invariants() == []`,
		structErrors.length === 0,
	);
}

// ---------------------------------------------------------------------------
// AC-3: 34 SCHEMA_MUTATIONS each rejected
// ---------------------------------------------------------------------------

const SCHEMA_MUTATIONS = [
	"missing_contract_id",
	"missing_mode",
	"missing_stage",
	"missing_baseline_version",
	"missing_dimensions",
	"missing_conditions",
	"bad_contract_id",
	"bad_mode",
	"empty_stage",
	"zero_panel",
	"empty_dimensions",
	"bad_dimension_id",
	"bad_dimension_name",
	"empty_description",
	"bad_priority",
	"empty_eligible_roles",
	"bad_eligible_role",
	"bad_owner_role",
	"extra_dimension_field",
	"short_scoring_schema",
	"duplicate_scoring_field",
	"typo_scoring_field",
	"zero_paraphrase_minimum",
	"empty_conditions",
	"bad_condition_id",
	"negative_severity",
	"excessive_severity",
	"bad_quantifier",
	"empty_expression",
	"bad_action",
	"missing_quantifier",
	"missing_panel",
	"short_override_ladder",
	"misordered_override_ladder",
] as const;

// Faithful port of upstream apply_schema_mutation().
function applySchemaMutation(contract: SprintContract, cas: string): void {
	const dims = contract.acceptance_dimensions as Record<string, unknown>[];
	const conds = contract.failure_conditions as Record<string, unknown>[];
	const dim = dims[0];
	const condition = conds[0];

	const missingTopMap: Record<string, string> = {
		contract_id: "contract_id",
		mode: "mode",
		stage: "stage",
		baseline_version: "baseline_version",
	};

	if (cas.startsWith("missing_") && cas.replace("missing_", "") in missingTopMap) {
		delete contract[missingTopMap[cas.replace("missing_", "")]];
	} else if (cas === "missing_dimensions") {
		delete contract.acceptance_dimensions;
	} else if (cas === "missing_conditions") {
		delete contract.failure_conditions;
	} else if (cas === "bad_contract_id") {
		contract.contract_id = "BAD";
	} else if (cas === "bad_mode") {
		contract.mode = "reviewer_quick";
	} else if (cas === "empty_stage") {
		contract.stage = "";
	} else if (cas === "zero_panel") {
		contract.panel_size = 0;
	} else if (cas === "empty_dimensions") {
		contract.acceptance_dimensions = [];
	} else if (cas === "bad_dimension_id") {
		dim.id = "D01";
	} else if (cas === "bad_dimension_name") {
		dim.name = "Bad Name";
	} else if (cas === "empty_description") {
		dim.description = "";
	} else if (cas === "bad_priority") {
		dim.priority = "urgent";
	} else if (cas === "empty_eligible_roles") {
		dim.eligible_roles = [];
	} else if (cas === "bad_eligible_role") {
		dim.eligible_roles = ["copyeditor"];
	} else if (cas === "bad_owner_role") {
		dim.owner_role = "copyeditor";
	} else if (cas === "extra_dimension_field") {
		dim.scoring_scale = ["pass"];
	} else if (cas === "short_scoring_schema") {
		const mp = contract.measurement_procedure as Record<string, unknown>;
		const sps = mp.scoring_plan_schema as Record<string, unknown>;
		(sps.required as string[]).pop();
	} else if (cas === "duplicate_scoring_field") {
		const mp = contract.measurement_procedure as Record<string, unknown>;
		const sps = mp.scoring_plan_schema as Record<string, unknown>;
		const req = sps.required as string[];
		req[req.length - 1] = req[0];
	} else if (cas === "typo_scoring_field") {
		const mp = contract.measurement_procedure as Record<string, unknown>;
		const sps = mp.scoring_plan_schema as Record<string, unknown>;
		const req = sps.required as string[];
		req[req.length - 1] = "fatal_trigger";
	} else if (cas === "zero_paraphrase_minimum") {
		const mp = contract.measurement_procedure as Record<string, unknown>;
		mp.paraphrase_minimum_dimensions = 0;
	} else if (cas === "empty_conditions") {
		contract.failure_conditions = [];
	} else if (cas === "bad_condition_id") {
		condition.condition_id = "F01";
	} else if (cas === "negative_severity") {
		condition.severity = -1;
	} else if (cas === "excessive_severity") {
		condition.severity = 101;
	} else if (cas === "bad_quantifier") {
		condition.cross_reviewer_quantifier = "plurality";
	} else if (cas === "empty_expression") {
		condition.expression = "";
	} else if (cas === "bad_action") {
		condition.action = "editorial_decision=revise";
	} else if (cas === "missing_quantifier") {
		delete condition.cross_reviewer_quantifier;
	} else if (cas === "missing_panel") {
		delete contract.panel_size;
	} else if (cas === "short_override_ladder" || cas === "misordered_override_ladder") {
		contract.override_ladder = [
			{ round: 1, trigger: "first", required: ["a"] },
			{ round: 2, trigger: "second", required: ["b"] },
			{ round: 3, trigger: "third", required: ["c"] },
		];
		if (cas === "short_override_ladder") {
			(contract.override_ladder as unknown[]).pop();
		} else {
			((contract.override_ladder as Record<string, unknown>[])[0]).round = 2;
		}
	} else {
		throw new Error(`unknown mutation: ${cas}`);
	}
}

console.log("test_legacy_schema_mutations_still_fail (34 cases)");
let mutationFailCount = 0;
for (const cas of SCHEMA_MUTATIONS) {
	const contract = clone(full());
	applySchemaMutation(contract, cas);
	const errors = validate(contract);
	if (errors.length > 0) {
		mutationFailCount++;
	} else {
		console.error(`    [FAIL] mutation '${cas}' was NOT rejected`);
	}
}
check(
	`all 34 SCHEMA_MUTATIONS rejected (${mutationFailCount}/34)`,
	mutationFailCount === 34,
);

// ---------------------------------------------------------------------------
// Unmutated reviewer-full accepted
// ---------------------------------------------------------------------------

console.log("test_unmutated_full_accepted");
check("validate(fullContract) == []", validate(full()).length === 0);

// ---------------------------------------------------------------------------
// AC-3b: mode-conditional branches
// ---------------------------------------------------------------------------

console.log("test_reviewer_re_review_mode_rejected");
{
	const contract = full();
	contract.mode = "reviewer_re_review";
	const errors = validate(contract);
	check(
		"error mentions reviewer_re_review or mode",
		errors.some((e) => e.includes("reviewer_re_review") || e.includes("mode")),
	);
}

console.log("test_branch13_reviewer_without_role_scope_fails");
{
	const contract = full();
	const dims = contract.acceptance_dimensions as Record<string, unknown>[];
	delete dims[0].eligible_roles;
	delete dims[0].owner_role;
	const errors = validate(contract);
	check(
		"error mentions eligible_roles or owner_role",
		errors.some((e) => e.includes("eligible_roles") || e.includes("owner_role")),
	);
}

console.log("test_hybrid_action_rejected_by_branch4");
{
	const contract = full();
	(contract.failure_conditions as Record<string, unknown>[])[0].action =
		"editorial_decision=reject_or_major_revision";
	check("validate non-empty", validate(contract).length > 0);
}

console.log("test_generator_mode_action_enum_is_pinned");
for (const [label, path, badAction] of [
	["writer", WRITER_PATH, "editorial_decision=accept"],
	["evaluator", EVALUATOR_PATH, "writer_decision=accept"],
] as const) {
	const contract = load(path);
	(contract.failure_conditions as Record<string, unknown>[])[0].action = badAction;
	check(`${label} bad action rejected`, validate(contract).length > 0);
}

console.log("test_generator_mode_specific_artifact_is_required");
for (const [label, path, field] of [
	["writer", WRITER_PATH, "pre_commitment_artifacts"],
	["evaluator", EVALUATOR_PATH, "disagreement_handling"],
] as const) {
	const contract = load(path);
	delete contract[field];
	check(`${label} missing ${field} rejected`, validate(contract).length > 0);
}

// ---------------------------------------------------------------------------
// AC-3c: F0 accept-grade presence (contains)
// ---------------------------------------------------------------------------

console.log("test_f0_accept_grade_is_schema_required");
{
	const contract = full();
	contract.failure_conditions = (contract.failure_conditions as Record<string, unknown>[]).filter(
		(c) => c.condition_id !== "F0",
	);
	check("F0 removed rejected", validate(contract).length > 0);
}

// ---------------------------------------------------------------------------
// AC-3d: scoring plan schema constraints
// ---------------------------------------------------------------------------

console.log("test_scoring_plan_requires_five_canonical_fields");
{
	const contract = full();
	const mp = contract.measurement_procedure as Record<string, unknown>;
	const sps = mp.scoring_plan_schema as Record<string, unknown>;
	(sps.required as string[]).splice((sps.required as string[]).indexOf("what_triggers_fatal"), 1);
	check("scoring <5 fields rejected", validate(contract).length > 0);
}

console.log("test_scoring_duplicate_field_rejected");
{
	const contract = full();
	const sps = (contract.measurement_procedure as Record<string, unknown>).scoring_plan_schema as Record<string, unknown>;
	const req = sps.required as string[];
	req[req.length - 1] = req[0];
	check("scoring duplicate rejected", validate(contract).length > 0);
}

console.log("test_scoring_typoed_field_rejected");
{
	const contract = full();
	const sps = (contract.measurement_procedure as Record<string, unknown>).scoring_plan_schema as Record<string, unknown>;
	const req = sps.required as string[];
	req[req.length - 1] = "fatal_trigger";
	check("scoring typo rejected", validate(contract).length > 0);
}

// ---------------------------------------------------------------------------
// AC-3e: duplicate eligible_role (uniqueItems)
// ---------------------------------------------------------------------------

console.log("test_schema_rejects_duplicate_eligible_role");
{
	const contract = full();
	(contract.acceptance_dimensions as Record<string, unknown>[])[0]
		.eligible_roles = [
		...((contract.acceptance_dimensions as Record<string, unknown>[])[0].eligible_roles as string[]),
		"methodology",
	];
	check("duplicate eligible role rejected", validate(contract).length > 0);
}

// ---------------------------------------------------------------------------
// AC-4: exact eligibility maps
// ---------------------------------------------------------------------------

console.log("test_full_and_mf_exact_eligibility_maps");
{
	const fullMap: Record<string, unknown> = {};
	for (const dim of (full().acceptance_dimensions as Record<string, unknown>[])) {
		fullMap[dim.id as string] = [dim.eligible_roles, dim.owner_role];
	}
	check("full eligibility map matches", JSON.stringify(fullMap) === JSON.stringify({
		D1: [["methodology"], "methodology"],
		D2: [["domain"], "domain"],
		D3: [["da", "methodology"], "da"],
		D4: [["perspective"], "perspective"],
		D5: [["eic"], "eic"],
		D6: [["eic"], "eic"],
	}));
	const mfMap: Record<string, unknown> = {};
	for (const dim of (load(MF_PATH).acceptance_dimensions as Record<string, unknown>[])) {
		mfMap[dim.id as string] = [dim.eligible_roles, dim.owner_role];
	}
	check("mf eligibility map matches", JSON.stringify(mfMap) === JSON.stringify({
		D1: [["methodology"], "methodology"],
		D2: [["eic"], "eic"],
	}));
}

// ---------------------------------------------------------------------------
// AC-5: uniqueness structural invariants
// ---------------------------------------------------------------------------

console.log("test_duplicate_dimension_and_condition_ids_fail_invariants");
{
	const contract = full();
	(contract.acceptance_dimensions as Record<string, unknown>[])[1].id = "D1";
	(contract.failure_conditions as Record<string, unknown>[])[1].condition_id = "F1";
	const errors = check_structural_invariants(contract);
	check(
		"mentions duplicate acceptance_dimensions id",
		errors.some((e) => e.includes("duplicate acceptance_dimensions id")),
	);
	check(
		"mentions duplicate failure_conditions",
		errors.some((e) => e.includes("duplicate failure_conditions")),
	);
}

// ---------------------------------------------------------------------------
// AC-6: reviewer-mode role coverage
// ---------------------------------------------------------------------------

console.log("test_owner_must_be_eligible");
{
	const contract = full();
	(contract.acceptance_dimensions as Record<string, unknown>[])[0].owner_role = "eic";
	const errors = check_structural_invariants(contract);
	check("mentions owner_role", errors.some((e) => e.includes("owner_role")));
}

console.log("test_roles_must_be_mode_subset");
{
	const contract = load(MF_PATH);
	((contract.acceptance_dimensions as Record<string, unknown>[])[0].eligible_roles as string[]).push(
		"domain",
	);
	const errors = check_structural_invariants(contract);
	check("mentions outside", errors.some((e) => e.includes("outside")));
}

console.log("test_every_mode_role_must_have_a_dimension");
{
	const contract = full();
	for (const dim of contract.acceptance_dimensions as Record<string, unknown>[]) {
		dim.eligible_roles = (dim.eligible_roles as string[]).filter(
			(role) => role !== "perspective",
		);
		if (dim.owner_role === "perspective") {
			dim.eligible_roles = ["eic"];
			dim.owner_role = "eic";
		}
	}
	const errors = check_structural_invariants(contract);
	check("mentions perspective", errors.some((e) => e.includes("perspective")));
}

// ---------------------------------------------------------------------------
// AC-7: fatal-atom mandatory-only scope
// ---------------------------------------------------------------------------

console.log("test_fatal_atom_mandatory_scope_only");
for (const expression of [
	"any high dimension has a fatal block",
	"D4 has a fatal block",
	"D5 has a fatal block",
]) {
	const contract = full();
	(contract.failure_conditions as Record<string, unknown>[])[0].expression = expression;
	const errors = check_structural_invariants(contract);
	check(`'${expression}' mentions fatal atom`, errors.some((e) => e.includes("fatal atom")));
}

console.log("test_mandatory_fatal_atoms_are_valid");
{
	const contract = full();
	const errors = check_structural_invariants(contract);
	check(
		"no fatal atom errors on shipped full",
		!errors.some((e) => e.includes("fatal atom")),
	);
}

// ---------------------------------------------------------------------------
// AC-8: non-reviewer-mode reviewer-field rejection
// ---------------------------------------------------------------------------

console.log("test_writer_evaluator_reject_reviewer_fields");
for (const [label, path] of [
	["writer", WRITER_PATH],
	["evaluator", EVALUATOR_PATH],
] as const) {
	const contract = load(path);
	const dims = contract.acceptance_dimensions as Record<string, unknown>[];
	dims[0].eligible_roles = ["eic"];
	dims[0].owner_role = "eic";
	const errors = check_structural_invariants(contract);
	check(`${label} mentions reviewer-only`, errors.some((e) => e.includes("reviewer-only")));
}

// ---------------------------------------------------------------------------
// AC-16: pinned constants present
// ---------------------------------------------------------------------------

console.log("test_pinned_constants");
check("ROLE_SETS.reviewer_full has 5 roles", ROLE_SETS.reviewer_full?.size === 5);
check(
	"ROLE_SETS.reviewer_methodology_focus has 2 roles",
	ROLE_SETS.reviewer_methodology_focus?.size === 2,
);
check("EXPECTED_PANEL_SIZE.reviewer_full === 5", EXPECTED_PANEL_SIZE.reviewer_full === 5);
check(
	"EXPECTED_PANEL_SIZE.reviewer_methodology_focus === 2",
	EXPECTED_PANEL_SIZE.reviewer_methodology_focus === 2,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
