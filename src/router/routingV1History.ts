import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  routingEvidenceSchema,
  type RescueEvidence,
  type RoutingEvidence,
} from "./routingV1.js";
/** Append-only shadow observations, distinct from production quality history. */
export class RoutingV1History {
  readonly path: string;
  constructor(readonly directory: string) {
    this.path = join(directory, "routing-v1-evidence.jsonl");
  }
  read(): RoutingEvidence[] {
    try {
      return readFileSync(this.path, "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            const parsed = routingEvidenceSchema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }
  priors(): { evidence: RoutingEvidence[]; rescueEvidence: RescueEvidence[] } {
    try {
      const raw = JSON.parse(
        readFileSync(join(this.directory, "routing-v1-priors.json"), "utf8"),
      );
      const evidence = (raw.priors ?? []).map((row: unknown) =>
        routingEvidenceSchema.parse(row),
      );
      const rescueEvidence = (raw.rescueEvidence ?? []).filter(
        (r: RescueEvidence) =>
          typeof r.provenance === "string" &&
          r.provenance.length > 0 &&
          Number.isInteger(r.successes) &&
          r.successes >= 0 &&
          Number.isInteger(r.failures) &&
          r.failures >= 0,
      );
      return { evidence, rescueEvidence };
    } catch {
      return { evidence: [], rescueEvidence: [] };
    }
  }
  record(row: RoutingEvidence) {
    const parsed = routingEvidenceSchema.parse(row);
    if (this.read().some((r) => r.id === parsed.id)) return;
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.path, JSON.stringify(parsed) + "\n", { mode: 0o600 });
  }
}
