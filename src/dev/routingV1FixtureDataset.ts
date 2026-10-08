import { mkdir, writeFile } from "node:fs/promises";
import { fixture, observed, features } from "./routingV1Fixtures.js";
import { routingFamilies } from "../router/routingV1.js";
import { routingDatasetSchema } from "../router/routingV1Evaluation.js";
/** Controlled scripted policy matrix. No actual vendor quality/pricing claims.
 * Training/holdout IDs are disjoint; validator results are generated from fake
 * candidate artifacts independently of the routing implementation. */
export async function writeRoutingFixtureDatasets(directory: string) {
  const base = fixture(),
    priors: any[] = [],
    tasks: any[] = [],
    localHistory: any[] = [];
  for (const family of routingFamilies) {
    const strict = ["frontend_visual", "security", "architecture"].includes(
      family,
    );
    for (const id of base.models.map((m) => m.model.id)) {
      const rows = observed(id, family, 0, 100, "synthetic");
      for (const [i, row] of rows.entries()) {
        // Scripted candidates have deliberately distinct error patterns. The
        // evidence label comes from checking their returned artifact, not from
        // supplied P(success) values or the router's own prediction.
        const artifact =
          (id === base.models[0]!.model.id && strict && i % 4 === 0) || i === 99
            ? { value: "invalid" }
            : { value: "expected" };
        row.success = artifact.value === "expected";
        row.provenance =
          "scripted artifact equality validator; synthetic, not provider evidence";
      }
      priors.push(...rows);
    }
    const local = observed(base.models[0]!.model.id, family, 0, 10, "local");
    local.forEach((r, i) => {
      r.success = i !== 9;
      r.outcome = r.success ? "VERIFIED_SUCCESS" : "FAILED";
      r.provenance = "scripted local transition, not production history";
    });
    localHistory.push(...local);
    for (const split of ["development", "holdout"] as const)
      for (let i = 0; i < 8; i++) {
        const assessment = structuredClone(base.assessment),
          contract = structuredClone(base.contract),
          fingerprint = structuredClone(base.fingerprint);
        fingerprint.taskFamily =
          family === "debugging"
            ? "debugging"
            : family === "backend_api"
              ? "backend_api"
              : family.startsWith("frontend")
                ? "frontend_ui"
                : family === "refactor"
                  ? "refactor"
                  : family === "tests_only"
                    ? "test_change"
                    : family === "config_tooling"
                      ? "devops"
                      : family === "architecture"
                        ? "architecture"
                        : undefined;
        fingerprint.visualRelevant = family === "frontend_visual";
        if (family === "security") assessment.riskFlags.security = true;
        if (family === "architecture") assessment.riskFlags.architecture = true;
        if (family === "config_tooling") assessment.riskFlags.config = true;
        if (family === "multi_file") assessment.scope = "multi_file";
        if (strict) {
          contract.overallStrength = "weak";
          contract.overallFalseAcceptRisk = "high";
          contract.requirements.forEach((r) => {
            r.strength = "weak";
            r.falseAcceptRisk = "high";
            r.proofAvailability = "manual";
          });
        }
        const outcomes = Object.fromEntries(
          base.models.map((m, index) => {
            const artifact =
              index === 0 && strict && i % 4 === 0
                ? { value: "invalid" }
                : { value: "expected" };
            const pass = artifact.value === "expected";
            return [
              m.model.id,
              {
                verified: pass,
                groundTruthPass: pass,
                costUsd: index === 0 ? 0.01 : 0.1,
                wallClockMs: index === 0 ? 1000 : 5000,
              },
            ];
          }),
        );
        tasks.push({
          id: `${split}-${family}-${i}`,
          split,
          assessment,
          contract,
          fingerprint,
          features,
          outcomes,
        });
      }
  }
  await mkdir(directory, { recursive: true });
  for (const split of ["development", "holdout"]) {
    const data = routingDatasetSchema.parse({
      version: 1,
      synthetic: true,
      provenance:
        "controlled scripted routing-policy fixture; costs/latencies simulated; not evidence of real-model performance",
      models: base.models,
      priors,
      localHistory,
      tasks: tasks.filter((t) => t.split === split),
    });
    await writeFile(
      `${directory}/${split}.json`,
      JSON.stringify(data, null, 2),
    );
  }
}
