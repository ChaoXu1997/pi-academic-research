/**
 * ARS sprint-contract validation core — pure TypeScript port of
 * `upstream/scripts/check_sprint_contract.py` schema + structural logic.
 *
 * This module holds ONLY the contract-foundation surface consumed by both upper
 * gates (panel_synthesis, phase_conformance). It deliberately excludes
 * warn_suspicious (CLI-local), markdown/report helpers, and the load_contract()
 * orchestrator — those belong to later slices.
 *
 * The schema validator is HAND-WRITTEN (no ajv): the Draft 2020-12 subset used by
 * Schema 13.2 (`upstream/shared/sprint_contract.schema.json`) is fully covered by
 * mechanical if/then checks. See design Decision 2 + AC-17: if fewer than 34 of
 * the 34 SCHEMA_MUTATIONS reject, escalate to ajv (never silently adopted).
 *
 * Public API (PINNED — design Decision 4): `SprintContract`, `validate`,
 * `check_structural_invariants`, `ROLE_SETS`, `EXPECTED_PANEL_SIZE`. Everything
 * else is `@internal`.
 */

// ---------------------------------------------------------------------------
// Pinned public type
// ---------------------------------------------------------------------------

/**
 * A sprint contract JSON object. This is the parsed output of JSON.parse() on a
 * contract file — an untyped bag that validate() inspects. Future slices receive
 * a SprintContract that has already passed validate() + check_structural_invariants().
 *
 * @public — pinned for port-panel-synthesis-gate and port-phase-conformance-gate.
 */
export type SprintContract = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Pinned public constants
// ---------------------------------------------------------------------------

/**
 * Reviewer-mode → eligible-role-set mapping. Frozen per upstream.
 *
 * reviewer_full:                {eic, methodology, domain, perspective, da}
 * reviewer_methodology_focus:   {eic, methodology}
 *
 * @public — pinned. Future slices use this for mode-validation and role-scoping.
 */
export const ROLE_SETS: Readonly<Record<string, ReadonlySet<string>>> = {
	reviewer_full: new Set(["eic", "methodology", "domain", "perspective", "da"]),
	reviewer_methodology_focus: new Set(["eic", "methodology"]),
};

/**
 * Canonical shipped-mode panel sizes. Frozen per upstream.
 *
 * reviewer_full:                5
 * reviewer_methodology_focus:   2
 *
 * @public — pinned. panel_synthesis.load_contract() validates panel_size against this.
 */
export const EXPECTED_PANEL_SIZE: Readonly<Record<string, number>> = {
	reviewer_full: 5,
	reviewer_methodology_focus: 2,
};

// ---------------------------------------------------------------------------
// @internal — enums / regexes translated from the frozen Schema 13.2
// ---------------------------------------------------------------------------

const MODE_ENUM = [
	"reviewer_full",
	"reviewer_methodology_focus",
	"reviewer_calibration",
	"reviewer_guided",
	"writer_full",
	"evaluator_full",
] as const;

const PRIORITY_ENUM = ["mandatory", "high", "normal"] as const;
const REVIEWER_ROLE_ENUM = [
	"eic",
	"methodology",
	"domain",
	"perspective",
	"da",
] as const;
const QUANTIFIER_ENUM = ["any", "majority", "all"] as const;

const SCORING_FIELDS = [
	"dimension_id",
	"what_to_look_for",
	"what_triggers_block",
	"what_triggers_warn",
	"what_triggers_fatal",
] as const;

const REVIEWER_ACTION_ENUM = [
	"editorial_decision=accept",
	"editorial_decision=minor_revision",
	"editorial_decision=major_revision",
	"editorial_decision=reject",
] as const;

const WRITER_ACTION_ENUM = [
	"writer_decision=accept",
	"writer_decision=revise_in_phase_4b",
	"writer_decision=escalate_to_evaluator",
] as const;

const EVALUATOR_ACTION_ENUM = [
	"evaluator_decision=accept",
	"evaluator_decision=accept_with_dissent_note",
	"evaluator_decision=request_revision",
	"evaluator_decision=flag_for_reviewer_stage",
] as const;

const EVALUATOR_DISAGREEMENT_ENUM = [
	"evaluator_decision=request_revision",
	"evaluator_decision=accept_with_dissent_note",
	"evaluator_decision=flag_for_reviewer_stage",
] as const;

const CONTRACT_ID_RE = /^[a-z_]+\/[a-z_]+\/v\d+$/;
const BASELINE_VERSION_RE = /^v\d+\.\d+\.\d+$/;
const DIM_ID_RE = /^D[1-9][0-9]?$/;
const DIM_NAME_RE = /^[a-z][a-z0-9_]*$/;
const CONDITION_ID_RE = /^F(0|[1-9][0-9]?)$/;
const REVIEWER_MODE_RE = /^reviewer_/;

// Top-level allowed keys (Schema 13.2 `properties` + additionalProperties:false).
const TOP_LEVEL_KEYS = new Set([
	"contract_id",
	"mode",
	"stage",
	"baseline_version",
	"panel_size",
	"acceptance_dimensions",
	"measurement_procedure",
	"pre_commitment_artifacts",
	"disagreement_handling",
	"failure_conditions",
	"override_ladder",
	"agent_amendments",
	"generated_at",
]);

const DIMENSION_KEYS = new Set([
	"id",
	"name",
	"description",
	"priority",
	"eligible_roles",
	"owner_role",
]);

const MEASUREMENT_PROCEDURE_KEYS = new Set([
	"reviewer_must_output_before_paper",
	"scoring_plan_schema",
	"paraphrase_minimum_dimensions",
]);

const SCORING_PLAN_SCHEMA_KEYS = new Set(["required"]);

const PRE_COMMITMENT_ARTIFACTS_KEYS = new Set([
	"acceptance_criteria_paraphrase",
]);
const ACCEPTANCE_CRITERIA_PARAPHRASE_KEYS = new Set(["minimum_dimensions"]);

const DISAGREEMENT_HANDLING_KEYS = new Set([
	"paraphrase_minimum_dimensions",
	"scoring_plan",
	"pre_commitment_check_protocol",
	"disagreement_resolution",
]);
const SCORING_PLAN_KEYS = new Set(["per_dimension_criteria"]);
const PER_DIMENSION_CRITERIA_KEYS = new Set([
	"dimension_id",
	"what_to_look_for",
	"what_triggers_block",
	"what_triggers_warn",
]);
const PRE_COMMITMENT_CHECK_PROTOCOL_KEYS = new Set(["check_writer_artifact"]);
const DISAGREEMENT_RESOLUTION_KEYS = new Set([
	"on_dimension_disagreement",
	"on_structural_drift",
]);

const FAILURE_CONDITION_KEYS = new Set([
	"condition_id",
	"severity",
	"cross_reviewer_quantifier",
	"expression",
	"action",
]);

const OVERRIDE_LADDER_ITEM_KEYS = new Set(["round", "trigger", "required"]);
const AGENT_AMENDMENTS_KEYS = new Set([
	"stage_specific_notes",
	"additional_measurement_hints",
]);

// Fatal-atom regexes (structural invariants).
const FATAL_PRIORITY_RE = /^any ([a-z]+) dimension has a fatal block$/;
const FATAL_DIM_RE = /^(D\d+) has a fatal block$/;

// ---------------------------------------------------------------------------
// @internal — type guards
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isStr(x: unknown): x is string {
	return typeof x === "string";
}

function isInt(x: unknown): x is number {
	return typeof x === "number" && Number.isInteger(x);
}

function hasUniqueItems(arr: unknown[]): boolean {
	const seen = new Set<string>();
	for (const item of arr) {
		const key = JSON.stringify(item);
		if (seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}

// ---------------------------------------------------------------------------
// Pinned public: validate()
// ---------------------------------------------------------------------------

/**
 * Hand-written Draft 2020-12 subset schema validator for sprint contracts.
 * Equivalent to upstream check_sprint_contract.validate() (which delegates to
 * jsonschema.Draft202012Validator).
 *
 * @param contract - The parsed sprint contract JSON object.
 * @returns List of schema violation strings. Empty list = pass. Non-empty = fail
 *   (caller must not proceed to structural checks — schema errors short-circuit).
 *
 * @public — pinned for port-panel-synthesis-gate and port-phase-conformance-gate.
 */
export function validate(contract: SprintContract): string[] {
	const errors: string[] = [];

	if (!isPlainObject(contract)) {
		errors.push("root: contract must be a JSON object");
		return errors;
	}

	// --- additionalProperties:false (top level) ---
	for (const key of Object.keys(contract)) {
		if (!TOP_LEVEL_KEYS.has(key)) {
			errors.push(`root: additional property '${key}' not allowed`);
		}
	}

	// --- required (top level) ---
	const requiredTop = [
		"contract_id",
		"mode",
		"stage",
		"baseline_version",
		"acceptance_dimensions",
		"failure_conditions",
	];
	for (const k of requiredTop) {
		if (!(k in contract)) errors.push(`root: missing required property '${k}'`);
	}

	// --- contract_id ---
	if ("contract_id" in contract) {
		const v = contract.contract_id;
		if (!isStr(v)) errors.push("contract_id: must be a string");
		else if (!CONTRACT_ID_RE.test(v))
			errors.push(
				`contract_id: '${v}' does not match pattern ^[a-z_]+/[a-z_]+/v\\d+$`,
			);
	}

	// --- mode ---
	if ("mode" in contract) {
		const v = contract.mode;
		if (!isStr(v)) errors.push("mode: must be a string");
		else if (!(MODE_ENUM as readonly string[]).includes(v))
			errors.push(`mode: '${v}' is not one of [${MODE_ENUM.join(", ")}]`);
	}

	// --- stage ---
	if ("stage" in contract) {
		const v = contract.stage;
		if (!isStr(v)) errors.push("stage: must be a string");
		else if (v.length < 1) errors.push("stage: must have minLength 1");
	}

	// --- baseline_version ---
	if ("baseline_version" in contract) {
		const v = contract.baseline_version;
		if (!isStr(v)) errors.push("baseline_version: must be a string");
		else if (!BASELINE_VERSION_RE.test(v))
			errors.push(
				`baseline_version: '${v}' does not match pattern ^v\\d+\\.\\d+\\.\\d+$`,
			);
	}

	// --- panel_size ---
	if ("panel_size" in contract) {
		const v = contract.panel_size;
		if (!isInt(v)) errors.push("panel_size: must be an integer");
		else if (v < 1) errors.push(`panel_size: ${v} is less than minimum 1`);
	}

	// --- acceptance_dimensions ---
	if ("acceptance_dimensions" in contract) {
		validateDimensions(contract.acceptance_dimensions, errors);
	}

	// --- measurement_procedure ---
	if ("measurement_procedure" in contract) {
		validateMeasurementProcedure(contract.measurement_procedure, errors);
	}

	// --- pre_commitment_artifacts ---
	if ("pre_commitment_artifacts" in contract) {
		validatePreCommitmentArtifacts(contract.pre_commitment_artifacts, errors);
	}

	// --- disagreement_handling ---
	if ("disagreement_handling" in contract) {
		validateDisagreementHandling(contract.disagreement_handling, errors);
	}

	// --- failure_conditions ---
	if ("failure_conditions" in contract) {
		validateFailureConditions(contract.failure_conditions, errors);
	}

	// --- override_ladder (base item schema; branch 2 adds count/prefixItems) ---
	if ("override_ladder" in contract) {
		validateOverrideLadder(contract.override_ladder, errors);
	}

	// --- agent_amendments ---
	if ("agent_amendments" in contract) {
		validateAgentAmendments(contract.agent_amendments, errors);
	}

	// --- generated_at (optional, format date-time) ---
	if ("generated_at" in contract) {
		const v = contract.generated_at;
		if (!isStr(v)) errors.push("generated_at: must be a string");
		else if (Number.isNaN(Date.parse(v)))
			errors.push(`generated_at: '${v}' is not a valid date-time`);
	}

	// --- 13 conditional allOf if/then branches ---
	applyConditionalBranches(contract, errors);

	return errors;
}

// ---------------------------------------------------------------------------
// @internal — property validators
// ---------------------------------------------------------------------------

function validateDimensions(raw: unknown, errors: string[]): void {
	if (!Array.isArray(raw)) {
		errors.push("acceptance_dimensions: must be an array");
		return;
	}
	if (raw.length < 1) {
		errors.push(
			"acceptance_dimensions: must have at least 1 item (minItems 1)",
		);
	}
	raw.forEach((dim, i) => {
		const path = `acceptance_dimensions[${i}]`;
		if (!isPlainObject(dim)) {
			errors.push(`${path}: must be an object`);
			return;
		}
		for (const key of Object.keys(dim)) {
			if (!DIMENSION_KEYS.has(key))
				errors.push(`${path}: additional property '${key}' not allowed`);
		}
		for (const k of ["id", "name", "description", "priority"]) {
			if (!(k in dim)) errors.push(`${path}: missing required property '${k}'`);
		}
		if ("id" in dim) {
			const v = dim.id;
			if (!isStr(v)) errors.push(`${path}.id: must be a string`);
			else if (!DIM_ID_RE.test(v))
				errors.push(`${path}.id: '${v}' does not match pattern ^D[1-9][0-9]?$`);
		}
		if ("name" in dim) {
			const v = dim.name;
			if (!isStr(v)) errors.push(`${path}.name: must be a string`);
			else if (!DIM_NAME_RE.test(v))
				errors.push(
					`${path}.name: '${v}' does not match pattern ^[a-z][a-z0-9_]*$`,
				);
		}
		if ("description" in dim) {
			const v = dim.description;
			if (!isStr(v)) errors.push(`${path}.description: must be a string`);
			else if (v.length < 1)
				errors.push(`${path}.description: must have minLength 1`);
		}
		if ("priority" in dim) {
			const v = dim.priority;
			if (!(PRIORITY_ENUM as readonly string[]).includes(v as string))
				errors.push(
					`${path}.priority: '${v}' is not one of [${PRIORITY_ENUM.join(", ")}]`,
				);
		}
		if ("eligible_roles" in dim) {
			const v = dim.eligible_roles;
			if (!Array.isArray(v)) {
				errors.push(`${path}.eligible_roles: must be an array`);
			} else {
				if (v.length < 1)
					errors.push(
						`${path}.eligible_roles: must have at least 1 item (minItems 1)`,
					);
				if (!hasUniqueItems(v as unknown[]))
					errors.push(
						`${path}.eligible_roles: items must be unique (uniqueItems)`,
					);
				v.forEach((role, j) => {
					if (
						!(REVIEWER_ROLE_ENUM as readonly string[]).includes(role as string)
					)
						errors.push(
							`${path}.eligible_roles[${j}]: '${role}' is not one of [${REVIEWER_ROLE_ENUM.join(", ")}]`,
						);
				});
			}
		}
		if ("owner_role" in dim) {
			const v = dim.owner_role;
			if (!(REVIEWER_ROLE_ENUM as readonly string[]).includes(v as string))
				errors.push(
					`${path}.owner_role: '${v}' is not one of [${REVIEWER_ROLE_ENUM.join(", ")}]`,
				);
		}
	});
}

function validateMeasurementProcedure(raw: unknown, errors: string[]): void {
	const path = "measurement_procedure";
	if (!isPlainObject(raw)) {
		errors.push(`${path}: must be an object`);
		return;
	}
	for (const key of Object.keys(raw)) {
		if (!MEASUREMENT_PROCEDURE_KEYS.has(key))
			errors.push(`${path}: additional property '${key}' not allowed`);
	}
	for (const k of [
		"reviewer_must_output_before_paper",
		"scoring_plan_schema",
		"paraphrase_minimum_dimensions",
	]) {
		if (!(k in raw)) errors.push(`${path}: missing required property '${k}'`);
	}
	if ("reviewer_must_output_before_paper" in raw) {
		const v = raw.reviewer_must_output_before_paper;
		if (!Array.isArray(v)) {
			errors.push(
				`${path}.reviewer_must_output_before_paper: must be an array`,
			);
		} else {
			if (v.length < 2)
				errors.push(
					`${path}.reviewer_must_output_before_paper: must have at least 2 items (minItems 2)`,
				);
			v.forEach((item, j) => {
				if (!isStr(item))
					errors.push(
						`${path}.reviewer_must_output_before_paper[${j}]: must be a string`,
					);
				else if (item.length < 1)
					errors.push(
						`${path}.reviewer_must_output_before_paper[${j}]: must have minLength 1`,
					);
			});
		}
	}
	if ("scoring_plan_schema" in raw) {
		const sps = raw.scoring_plan_schema;
		const spsPath = `${path}.scoring_plan_schema`;
		if (!isPlainObject(sps)) {
			errors.push(`${spsPath}: must be an object`);
		} else {
			for (const key of Object.keys(sps)) {
				if (!SCORING_PLAN_SCHEMA_KEYS.has(key))
					errors.push(`${spsPath}: additional property '${key}' not allowed`);
			}
			if (!("required" in sps))
				errors.push(`${spsPath}: missing required property 'required'`);
			if ("required" in sps) {
				const req = sps.required;
				if (!Array.isArray(req)) {
					errors.push(`${spsPath}.required: must be an array`);
				} else {
					if (req.length < 5)
						errors.push(
							`${spsPath}.required: must have at least 5 items (minItems 5)`,
						);
					if (!hasUniqueItems(req as unknown[]))
						errors.push(
							`${spsPath}.required: items must be unique (uniqueItems)`,
						);
					req.forEach((field, j) => {
						if (
							!(SCORING_FIELDS as readonly string[]).includes(field as string)
						)
							errors.push(
								`${spsPath}.required[${j}]: '${field}' is not one of [${SCORING_FIELDS.join(", ")}]`,
							);
					});
				}
			}
		}
	}
	if ("paraphrase_minimum_dimensions" in raw) {
		validateAnyOfAllOrInt(
			raw.paraphrase_minimum_dimensions,
			`${path}.paraphrase_minimum_dimensions`,
			errors,
		);
	}
}

function validatePreCommitmentArtifacts(raw: unknown, errors: string[]): void {
	const path = "pre_commitment_artifacts";
	if (!isPlainObject(raw)) {
		errors.push(`${path}: must be an object`);
		return;
	}
	for (const key of Object.keys(raw)) {
		if (!PRE_COMMITMENT_ARTIFACTS_KEYS.has(key))
			errors.push(`${path}: additional property '${key}' not allowed`);
	}
	if (!("acceptance_criteria_paraphrase" in raw))
		errors.push(
			`${path}: missing required property 'acceptance_criteria_paraphrase'`,
		);
	if ("acceptance_criteria_paraphrase" in raw) {
		const acp = raw.acceptance_criteria_paraphrase;
		const acpPath = `${path}.acceptance_criteria_paraphrase`;
		if (!isPlainObject(acp)) {
			errors.push(`${acpPath}: must be an object`);
		} else {
			for (const key of Object.keys(acp)) {
				if (!ACCEPTANCE_CRITERIA_PARAPHRASE_KEYS.has(key))
					errors.push(`${acpPath}: additional property '${key}' not allowed`);
			}
			if (!("minimum_dimensions" in acp))
				errors.push(
					`${acpPath}: missing required property 'minimum_dimensions'`,
				);
			if ("minimum_dimensions" in acp) {
				validateAnyOfAllOrInt(
					acp.minimum_dimensions,
					`${acpPath}.minimum_dimensions`,
					errors,
				);
			}
		}
	}
}

function validateDisagreementHandling(raw: unknown, errors: string[]): void {
	const path = "disagreement_handling";
	if (!isPlainObject(raw)) {
		errors.push(`${path}: must be an object`);
		return;
	}
	for (const key of Object.keys(raw)) {
		if (!DISAGREEMENT_HANDLING_KEYS.has(key))
			errors.push(`${path}: additional property '${key}' not allowed`);
	}
	for (const k of [
		"paraphrase_minimum_dimensions",
		"scoring_plan",
		"pre_commitment_check_protocol",
		"disagreement_resolution",
	]) {
		if (!(k in raw)) errors.push(`${path}: missing required property '${k}'`);
	}
	if ("paraphrase_minimum_dimensions" in raw) {
		validateAnyOfAllOrInt(
			raw.paraphrase_minimum_dimensions,
			`${path}.paraphrase_minimum_dimensions`,
			errors,
		);
	}
	if ("scoring_plan" in raw) {
		const sp = raw.scoring_plan;
		const spPath = `${path}.scoring_plan`;
		if (!isPlainObject(sp)) {
			errors.push(`${spPath}: must be an object`);
		} else {
			for (const key of Object.keys(sp)) {
				if (!SCORING_PLAN_KEYS.has(key))
					errors.push(`${spPath}: additional property '${key}' not allowed`);
			}
			if (!("per_dimension_criteria" in sp))
				errors.push(
					`${spPath}: missing required property 'per_dimension_criteria'`,
				);
			if ("per_dimension_criteria" in sp) {
				const pdc = sp.per_dimension_criteria;
				if (!Array.isArray(pdc)) {
					errors.push(`${spPath}.per_dimension_criteria: must be an array`);
				} else {
					if (pdc.length < 1)
						errors.push(
							`${spPath}.per_dimension_criteria: must have at least 1 item (minItems 1)`,
						);
					pdc.forEach((crit, j) => {
						const cPath = `${spPath}.per_dimension_criteria[${j}]`;
						if (!isPlainObject(crit)) {
							errors.push(`${cPath}: must be an object`);
							return;
						}
						for (const key of Object.keys(crit)) {
							if (!PER_DIMENSION_CRITERIA_KEYS.has(key))
								errors.push(
									`${cPath}: additional property '${key}' not allowed`,
								);
						}
						for (const k of [
							"dimension_id",
							"what_to_look_for",
							"what_triggers_block",
							"what_triggers_warn",
						]) {
							if (!(k in crit))
								errors.push(`${cPath}: missing required property '${k}'`);
						}
						if ("dimension_id" in crit) {
							const v = crit.dimension_id;
							if (!isStr(v))
								errors.push(`${cPath}.dimension_id: must be a string`);
							else if (!DIM_ID_RE.test(v))
								errors.push(
									`${cPath}.dimension_id: '${v}' does not match pattern ^D[1-9][0-9]?$`,
								);
						}
						for (const f of [
							"what_to_look_for",
							"what_triggers_block",
							"what_triggers_warn",
						]) {
							if (f in crit) {
								const v = (crit as Record<string, unknown>)[f];
								if (!isStr(v)) errors.push(`${cPath}.${f}: must be a string`);
								else if (v.length < 1)
									errors.push(`${cPath}.${f}: must have minLength 1`);
							}
						}
					});
				}
			}
		}
	}
	if ("pre_commitment_check_protocol" in raw) {
		const pccp = raw.pre_commitment_check_protocol;
		const pccpPath = `${path}.pre_commitment_check_protocol`;
		if (!isPlainObject(pccp)) {
			errors.push(`${pccpPath}: must be an object`);
		} else {
			for (const key of Object.keys(pccp)) {
				if (!PRE_COMMITMENT_CHECK_PROTOCOL_KEYS.has(key))
					errors.push(`${pccpPath}: additional property '${key}' not allowed`);
			}
			if (!("check_writer_artifact" in pccp))
				errors.push(
					`${pccpPath}: missing required property 'check_writer_artifact'`,
				);
			if (
				"check_writer_artifact" in pccp &&
				pccp.check_writer_artifact !== "pre_commitment_artifacts"
			)
				errors.push(
					`${pccpPath}.check_writer_artifact: '${pccp.check_writer_artifact}' must be const 'pre_commitment_artifacts'`,
				);
		}
	}
	if ("disagreement_resolution" in raw) {
		const dr = raw.disagreement_resolution;
		const drPath = `${path}.disagreement_resolution`;
		if (!isPlainObject(dr)) {
			errors.push(`${drPath}: must be an object`);
		} else {
			for (const key of Object.keys(dr)) {
				if (!DISAGREEMENT_RESOLUTION_KEYS.has(key))
					errors.push(`${drPath}: additional property '${key}' not allowed`);
			}
			for (const k of ["on_dimension_disagreement", "on_structural_drift"]) {
				if (!(k in dr))
					errors.push(`${drPath}: missing required property '${k}'`);
				if (k in dr) {
					const v = (dr as Record<string, unknown>)[k];
					if (
						!(EVALUATOR_DISAGREEMENT_ENUM as readonly string[]).includes(
							v as string,
						)
					)
						errors.push(
							`${drPath}.${k}: '${v}' is not one of [${EVALUATOR_DISAGREEMENT_ENUM.join(", ")}]`,
						);
				}
			}
		}
	}
}

function validateFailureConditions(raw: unknown, errors: string[]): void {
	if (!Array.isArray(raw)) {
		errors.push("failure_conditions: must be an array");
		return;
	}
	if (raw.length < 1) {
		errors.push("failure_conditions: must have at least 1 item (minItems 1)");
	}
	raw.forEach((cond, i) => {
		const path = `failure_conditions[${i}]`;
		if (!isPlainObject(cond)) {
			errors.push(`${path}: must be an object`);
			return;
		}
		for (const key of Object.keys(cond)) {
			if (!FAILURE_CONDITION_KEYS.has(key))
				errors.push(`${path}: additional property '${key}' not allowed`);
		}
		for (const k of ["condition_id", "severity", "expression", "action"]) {
			if (!(k in cond))
				errors.push(`${path}: missing required property '${k}'`);
		}
		if ("condition_id" in cond) {
			const v = cond.condition_id;
			if (!isStr(v)) errors.push(`${path}.condition_id: must be a string`);
			else if (!CONDITION_ID_RE.test(v))
				errors.push(
					`${path}.condition_id: '${v}' does not match pattern ^F(0|[1-9][0-9]?)$`,
				);
		}
		if ("severity" in cond) {
			const v = cond.severity;
			if (!isInt(v)) errors.push(`${path}.severity: must be an integer`);
			else {
				if (v < 0) errors.push(`${path}.severity: ${v} is less than minimum 0`);
				if (v > 100)
					errors.push(`${path}.severity: ${v} is greater than maximum 100`);
			}
		}
		if ("cross_reviewer_quantifier" in cond) {
			const v = cond.cross_reviewer_quantifier;
			if (!(QUANTIFIER_ENUM as readonly string[]).includes(v as string))
				errors.push(
					`${path}.cross_reviewer_quantifier: '${v}' is not one of [${QUANTIFIER_ENUM.join(", ")}]`,
				);
		}
		if ("expression" in cond) {
			const v = cond.expression;
			if (!isStr(v)) errors.push(`${path}.expression: must be a string`);
			else if (v.length < 1)
				errors.push(`${path}.expression: must have minLength 1`);
		}
		if ("action" in cond) {
			const v = cond.action;
			if (!isStr(v)) errors.push(`${path}.action: must be a string`);
		}
	});
}

function validateOverrideLadder(raw: unknown, errors: string[]): void {
	if (!Array.isArray(raw)) {
		errors.push("override_ladder: must be an array");
		return;
	}
	raw.forEach((entry, i) => {
		const path = `override_ladder[${i}]`;
		if (!isPlainObject(entry)) {
			errors.push(`${path}: must be an object`);
			return;
		}
		for (const key of Object.keys(entry)) {
			if (!OVERRIDE_LADDER_ITEM_KEYS.has(key))
				errors.push(`${path}: additional property '${key}' not allowed`);
		}
		for (const k of ["round", "trigger", "required"]) {
			if (!(k in entry))
				errors.push(`${path}: missing required property '${k}'`);
		}
		if ("round" in entry) {
			const v = entry.round;
			if (!isInt(v)) errors.push(`${path}.round: must be an integer`);
			else if (![1, 2, 3].includes(v))
				errors.push(`${path}.round: ${v} is not one of [1, 2, 3]`);
		}
		if ("trigger" in entry) {
			const v = entry.trigger;
			if (!isStr(v)) errors.push(`${path}.trigger: must be a string`);
			else if (v.length < 1)
				errors.push(`${path}.trigger: must have minLength 1`);
		}
		if ("required" in entry) {
			const v = entry.required;
			if (!Array.isArray(v)) {
				errors.push(`${path}.required: must be an array`);
			} else {
				v.forEach((item, j) => {
					if (!isStr(item))
						errors.push(`${path}.required[${j}]: must be a string`);
					else if (item.length < 1)
						errors.push(`${path}.required[${j}]: must have minLength 1`);
				});
			}
		}
	});
}

function validateAgentAmendments(raw: unknown, errors: string[]): void {
	const path = "agent_amendments";
	if (!isPlainObject(raw)) {
		errors.push(`${path}: must be an object`);
		return;
	}
	for (const key of Object.keys(raw)) {
		if (!AGENT_AMENDMENTS_KEYS.has(key))
			errors.push(`${path}: additional property '${key}' not allowed`);
	}
	if ("stage_specific_notes" in raw) {
		const v = raw.stage_specific_notes;
		if (!isStr(v))
			errors.push(`${path}.stage_specific_notes: must be a string`);
		else if (v.length > 500)
			errors.push(`${path}.stage_specific_notes: must have maxLength 500`);
	}
	if ("additional_measurement_hints" in raw) {
		const v = raw.additional_measurement_hints;
		if (!Array.isArray(v)) {
			errors.push(`${path}.additional_measurement_hints: must be an array`);
		} else {
			v.forEach((item, j) => {
				if (!isStr(item))
					errors.push(
						`${path}.additional_measurement_hints[${j}]: must be a string`,
					);
				else if (item.length < 1)
					errors.push(
						`${path}.additional_measurement_hints[${j}]: must have minLength 1`,
					);
			});
		}
	}
}

/** anyOf: const "all" OR integer minimum 1. */
function validateAnyOfAllOrInt(
	raw: unknown,
	path: string,
	errors: string[],
): void {
	if (raw === "all") return;
	if (isInt(raw)) {
		if (raw < 1) errors.push(`${path}: ${raw} is less than minimum 1`);
		return;
	}
	errors.push(
		`${path}: '${raw}' is not 'all' and not an integer >= 1 (anyOf failed)`,
	);
}

// ---------------------------------------------------------------------------
// @internal — 13 conditional allOf if/then branches
// ---------------------------------------------------------------------------

function applyConditionalBranches(
	contract: SprintContract,
	errors: string[],
): void {
	const mode = contract.mode;
	const isReviewer = isStr(mode) && REVIEWER_MODE_RE.test(mode);
	const isWriter = mode === "writer_full";
	const isEvaluator = mode === "evaluator_full";
	const conds = Array.isArray(contract.failure_conditions)
		? (contract.failure_conditions as Record<string, unknown>[])
		: [];
	const dims = Array.isArray(contract.acceptance_dimensions)
		? (contract.acceptance_dimensions as Record<string, unknown>[])
		: [];

	// Branch 1: reviewer → failure_conditions[].cross_reviewer_quantifier required.
	if (isReviewer) {
		conds.forEach((c, i) => {
			if (!("cross_reviewer_quantifier" in c))
				errors.push(
					`failure_conditions[${i}]: missing required property 'cross_reviewer_quantifier' (reviewer mode)`,
				);
		});
	}

	// Branch 2: override_ladder present → exactly 3 items, rounds 1, 2, 3 in order.
	if ("override_ladder" in contract) {
		const ladder = contract.override_ladder;
		if (Array.isArray(ladder)) {
			if (ladder.length !== 3)
				errors.push(
					`override_ladder: must have exactly 3 items (got ${ladder.length})`,
				);
			const expected = [1, 2, 3];
			ladder.forEach((entry, i) => {
				if (
					i < 3 &&
					isPlainObject(entry) &&
					isInt(entry.round) &&
					entry.round !== expected[i]
				) {
					errors.push(
						`override_ladder[${i}]: round must be ${expected[i]} (prefixItems), got ${entry.round}`,
					);
				}
			});
		}
	}

	// Branch 3: reviewer → measurement_procedure required.
	if (isReviewer && !("measurement_procedure" in contract))
		errors.push(
			"root: missing required property 'measurement_procedure' (reviewer mode)",
		);

	// Branch 4: reviewer → each action ∈ editorial_decision enum.
	if (isReviewer) {
		conds.forEach((c, i) => {
			if (
				"action" in c &&
				!(REVIEWER_ACTION_ENUM as readonly string[]).includes(
					c.action as string,
				)
			) {
				errors.push(
					`failure_conditions[${i}].action: '${c.action}' is not one of [${REVIEWER_ACTION_ENUM.join(", ")}] (reviewer mode)`,
				);
			}
		});
	}

	// Branch 5: writer_full → each action ∈ writer_decision enum.
	if (isWriter) {
		conds.forEach((c, i) => {
			if (
				"action" in c &&
				!(WRITER_ACTION_ENUM as readonly string[]).includes(c.action as string)
			) {
				errors.push(
					`failure_conditions[${i}].action: '${c.action}' is not one of [${WRITER_ACTION_ENUM.join(", ")}] (writer_full mode)`,
				);
			}
		});
	}

	// Branch 6: evaluator_full → each action ∈ evaluator_decision enum.
	if (isEvaluator) {
		conds.forEach((c, i) => {
			if (
				"action" in c &&
				!(EVALUATOR_ACTION_ENUM as readonly string[]).includes(
					c.action as string,
				)
			) {
				errors.push(
					`failure_conditions[${i}].action: '${c.action}' is not one of [${EVALUATOR_ACTION_ENUM.join(", ")}] (evaluator_full mode)`,
				);
			}
		});
	}

	// Branches 7/8/9: contains F0 + mode-specific accept action.
	const expectedAccept = isReviewer
		? "editorial_decision=accept"
		: isWriter
			? "writer_decision=accept"
			: isEvaluator
				? "evaluator_decision=accept"
				: null;
	if (expectedAccept !== null) {
		const hasF0 = conds.some(
			(c) => c.condition_id === "F0" && c.action === expectedAccept,
		);
		if (!hasF0)
			errors.push(
				`failure_conditions: must contain an entry with condition_id 'F0' and action '${expectedAccept}'`,
			);
	}

	// Branch 10: reviewer → panel_size required.
	if (isReviewer && !("panel_size" in contract))
		errors.push("root: missing required property 'panel_size' (reviewer mode)");

	// Branch 11: writer_full → pre_commitment_artifacts required.
	if (isWriter && !("pre_commitment_artifacts" in contract))
		errors.push(
			"root: missing required property 'pre_commitment_artifacts' (writer_full mode)",
		);

	// Branch 12: evaluator_full → disagreement_handling required.
	if (isEvaluator && !("disagreement_handling" in contract))
		errors.push(
			"root: missing required property 'disagreement_handling' (evaluator_full mode)",
		);

	// Branch 13: reviewer → each dimension requires eligible_roles + owner_role.
	if (isReviewer) {
		dims.forEach((dim, i) => {
			if (!("eligible_roles" in dim))
				errors.push(
					`acceptance_dimensions[${i}]: missing required property 'eligible_roles' (reviewer mode)`,
				);
			if (!("owner_role" in dim))
				errors.push(
					`acceptance_dimensions[${i}]: missing required property 'owner_role' (reviewer mode)`,
				);
		});
	}
}

// ---------------------------------------------------------------------------
// Pinned public: check_structural_invariants()
// ---------------------------------------------------------------------------

/**
 * Structural invariant checker. Runs ONLY after validate() returns [].
 * Checks: unique dimension IDs/names, unique condition IDs, reviewer-mode role
 * coverage (owner-in-eligible, eligible-in-ROLE_SETS, full coverage), fatal-atom
 * mandatory-only scope, non-reviewer-mode reviewer-field rejection.
 *
 * @param contract - A contract that has already passed validate().
 * @returns List of structural violation strings. Empty = pass.
 *
 * @public — pinned for port-panel-synthesis-gate and port-phase-conformance-gate.
 */
export function check_structural_invariants(
	contract: SprintContract,
): string[] {
	const errors: string[] = [];

	const dims = Array.isArray(contract.acceptance_dimensions)
		? (contract.acceptance_dimensions as Record<string, unknown>[])
		: [];
	const conds = Array.isArray(contract.failure_conditions)
		? (contract.failure_conditions as Record<string, unknown>[])
		: [];

	// --- uniqueness: dimension id ---
	const ids = dims
		.map((d) => d.id)
		.filter((x): x is string => typeof x === "string");
	for (const dup of sortedDuplicates(ids)) {
		errors.push(
			`duplicate acceptance_dimensions id '${dup}'; downstream aggregation assumes unique ids`,
		);
	}

	// --- uniqueness: dimension name ---
	const names = dims
		.map((d) => d.name)
		.filter((x): x is string => typeof x === "string");
	for (const dup of sortedDuplicates(names)) {
		errors.push(
			`duplicate acceptance_dimensions name '${dup}'; downstream lint assumes unique names`,
		);
	}

	// --- uniqueness: condition_id ---
	const cids = conds
		.map((c) => c.condition_id)
		.filter((x): x is string => typeof x === "string");
	for (const dup of sortedDuplicates(cids)) {
		errors.push(
			`duplicate failure_conditions condition_id '${dup}'; precedence resolution assumes unique condition_ids`,
		);
	}

	const mode = typeof contract.mode === "string" ? contract.mode : "";
	const reviewerMode = mode.startsWith("reviewer_");
	const roleSet = ROLE_SETS[mode];

	if (reviewerMode && roleSet === undefined) {
		errors.push(`reviewer mode '${mode}' has no published ROLE_SETS mapping`);
	}

	if (reviewerMode && roleSet !== undefined) {
		const coveredRoles = new Set<string>();
		const priorities = new Map<string, unknown>();
		for (const d of dims) {
			if (typeof d.id === "string") priorities.set(d.id, d.priority);
		}
		for (const dim of dims) {
			const did = dim.id;
			const eligibleRaw = Array.isArray(dim.eligible_roles)
				? (dim.eligible_roles as string[])
				: [];
			const eligible = new Set(eligibleRaw);
			const owner = dim.owner_role;
			if (!eligible.has(owner as string)) {
				errors.push(`${did}: owner_role '${owner}' must be in eligible_roles`);
			}
			const outside = [...eligible].filter((r) => !roleSet.has(r));
			if (outside.length) {
				errors.push(
					`${did}: eligible_roles ${JSON.stringify(outside.sort())} are outside ROLE_SETS[${mode}]`,
				);
			}
			for (const r of eligible) coveredRoles.add(r);
		}
		const missingRoles = [...roleSet].filter((r) => !coveredRoles.has(r));
		if (missingRoles.length) {
			errors.push(
				`ROLE_SETS[${mode}] roles with no eligible dimension: ${JSON.stringify(missingRoles.sort())}`,
			);
		}

		for (const cond of conds) {
			const expr = typeof cond.expression === "string" ? cond.expression : "";
			const cid = cond.condition_id;
			for (const atom of expr.split(" AND ")) {
				const m1 = FATAL_PRIORITY_RE.exec(atom);
				if (m1) {
					if (m1[1] !== "mandatory") {
						errors.push(`${cid}: fatal atom priority must be mandatory`);
					}
					continue;
				}
				const m2 = FATAL_DIM_RE.exec(atom);
				if (m2) {
					const dref = m2[1];
					if (priorities.get(dref) !== "mandatory") {
						errors.push(
							`${cid}: fatal atom dimension ${dref} must be mandatory`,
						);
					}
				}
			}
		}
	} else if (!reviewerMode) {
		for (const dim of dims) {
			const leaked = ["eligible_roles", "owner_role"].filter((f) => f in dim);
			if (leaked.length) {
				errors.push(
					`${dim.id}: reviewer-only fields ${JSON.stringify(leaked)} are forbidden for mode=${mode}`,
				);
			}
		}
	}

	return errors;
}

/** Return sorted unique values that appear more than once in `arr`. */
function sortedDuplicates(arr: string[]): string[] {
	const counts = new Map<string, number>();
	for (const x of arr) counts.set(x, (counts.get(x) ?? 0) + 1);
	return [...counts.entries()]
		.filter(([, n]) => n > 1)
		.map(([k]) => k)
		.sort();
}
