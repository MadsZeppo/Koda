export const STABLE_EVENTS = {
    mutation: "stable_mutation",
    contextRecovery: "stable_mutation_tool_recovery",
    focusedVerification: "stable_focused_verification",
    sameModelRepair: "stable_same_model_repair",
    modelFallback: "model_fallback",
    readyForFinal: "ready_for_final_verification",
  } as const;
  
  export type StableEventName =
    (typeof STABLE_EVENTS)[keyof typeof STABLE_EVENTS];
  