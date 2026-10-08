export type RoutingAuthorityMode = "legacy" | "shadow" | "contextual-vnext";
/** An explicit authority switch, never an ensemble or fallback. Not a production activation flag. */
export function authoritativeRoutingDecision<L, V>(
  mode: RoutingAuthorityMode,
  legacy: () => L,
  contextual: () => V,
):
  | { authority: "legacy"; decision: L }
  | { authority: "contextual-vnext"; decision: V } {
  return mode === "contextual-vnext"
    ? { authority: "contextual-vnext", decision: contextual() }
    : { authority: "legacy", decision: legacy() };
}
