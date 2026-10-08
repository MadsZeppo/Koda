import { optimizeSpecialists } from "./routeOptimizer.js";

/** The sole owner of legacy quality estimates. VNext must never import this module. */
export class LegacyProductionRouter {
  decide(...input: Parameters<typeof optimizeSpecialists>) {
    return optimizeSpecialists(...input);
  }
}
