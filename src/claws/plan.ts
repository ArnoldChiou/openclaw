// The grouped schema has one lifecycle planner: add is read-only when dry-run is set.
export { buildClawAddPlan } from "./lifecycle.js";
export type { ClawAddPlanContext } from "./lifecycle.js";
