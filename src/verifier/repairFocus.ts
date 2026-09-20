import type { CommandResult } from "../types.js";
import { verificationFailureIdentities } from "./verifier.js";

/** Only derive selectors from executable pytest evidence, never model text. */
export function newFailureIds(check: CommandResult, baseline: CommandResult[]) {
  const prior = baseline.find((item) => item.command === check.command);
  const known = new Set(prior ? verificationFailureIdentities(prior) : []);
  return verificationFailureIdentities(check).filter((id) => !known.has(id));
}

export function focusedRepairCommand(check: CommandResult, baseline: CommandResult[]) {
  const ids = newFailureIds(check, baseline);
  const invocation = check.command.match(/^(python[\d.]*\s+(?:-B\s+)?-m\s+pytest|pytest)\s*((?:-p\s+no:cacheprovider\s*|-q\s*|-v\s*|-x\s*|--tb=\w+\s*|[\w./-]+\.py\s*|\.\s*)*)$/);
  if (!invocation || !ids.length || ids.length > 4 ||
      ids.some((id) => !/^[\w/-]+(?:\.py)(?:::[\w.-]+)+$/.test(id) || id.startsWith("/") || id.split("/").includes(".."))) return undefined;
  // Replace collection paths: appending a node id to '.' still collects every test.
  return `${invocation[1]} -p no:cacheprovider -q ${ids.map((id) => `'${id}'`).join(" ")}`;
}

/** Reproduce the selected regression; never reuse broad stdout under a new command. */
export async function prepareRepairChecks(checks: CommandResult[], baseline: CommandResult[],
  execute: (command: string) => Promise<CommandResult | undefined>) {
  const results: CommandResult[] = [];
  for (const check of checks) {
    const command = focusedRepairCommand(check, baseline);
    if (!command) { results.push(check); continue; }
    const focused = await execute(command);
    if (focused?.outcome === "INFRA_FAILURE")
      throw Error("Stable focused repair diagnostics infrastructure failed");
    // A passing/non-reproducing selector cannot replace the failing check.
    results.push(focused?.outcome === "CHECK_FAIL" ? focused : check);
  }
  return results;
}
