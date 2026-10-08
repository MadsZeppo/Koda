export interface LiteralReplacement {
  oldLiteral: string;
  newLiteral: string;
}

const literalToken = String.raw`["“'‘]?([\p{L}\p{N}_.:/-]{1,100})["”'’]?`;

/** Extract only an explicit old/new replacement stated by the user. */
export function explicitLiteralReplacement(task: string): LiteralReplacement | undefined {
  const patterns: Array<{ expression: RegExp; order: "new-old" | "old-new" }> = [
    { expression: new RegExp(String.raw`\b(?:står|siger|viser|say|says|show|shows)\s+${literalToken}\s+(?:i\s+stedet\s+for|instead\s+of)\s+${literalToken}`, "iu"), order: "new-old" },
    { expression: new RegExp(String.raw`\b(?:replace|erstat)\s+${literalToken}\s+(?:with|med)\s+${literalToken}`, "iu"), order: "old-new" },
    { expression: new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:change|ændr(?:e|er)?|skift|rename|omdøb)[^\n]{0,120}?\b(?:from|fra)\s+${literalToken}\s+(?:to|til)\s+${literalToken}`, "iu"), order: "old-new" },
  ];
  for (const { expression, order } of patterns) {
    const match = task.match(expression);
    if (!match?.[1] || !match[2] || match[1] === match[2]) continue;
    return order === "new-old"
      ? { newLiteral: match[1], oldLiteral: match[2] }
      : { oldLiteral: match[1], newLiteral: match[2] };
  }
  return undefined;
}

export function isOnlyLiteralReplacementTask(task: string) {
  return !!explicitLiteralReplacement(task) &&
    !/(?:\b(?:add|create|delete|remove|implement|refactor|migrat\w*|test|wire|redesign)\b|tilføj|opret|slet|fjern|implement|omskriv|test)/iu.test(task);
}

/** Desired copy for a bounded label/text change where the old copy is omitted. */
export function explicitDesiredLiteral(task: string): string | undefined {
  const match = task.match(/\b(?:to|til)\s*["“'‘]([^"”'’\n]{1,160})["”'’]/iu);
  return match?.[1]?.trim() || undefined;
}

export function isOnlyLocalizedCopyTask(task: string) {
  return !!explicitDesiredLiteral(task) &&
    /(?:\b(?:text|label|copy|caption|heading|title|button|logo)\b|logo\w*|tekst|knap|overskrift)/iu.test(task) &&
    !/(?:\b(?:add|create|delete|remove|implement|refactor|migrat\w*|test|wire|redesign|route)\b|tilføj|opret|slet|fjern|implement|omskriv|test|rute)/iu.test(task);
}
