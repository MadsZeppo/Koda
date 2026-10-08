/** Shadow-only security evidence. Rules combine an implementation action with
 * a boundary in the same clause. Names and vocabulary are candidates, not proof. */
export interface SecurityEvidence {
  candidate: boolean;
  resolution: "security" | "non_security" | "unresolved";
  confidence: number;
  evidence: {
    source: "prompt" | "localization";
    description: string;
    strong: boolean;
  }[];
}
const boundaries = [
  /authenticat\w*|autentifi\w*|autentika\w*/,
  /authoriz\w*|unauthoriz\w*|permission\w*|privileg\w*|administrator\w*|access control|access policy|adgang\w*|rettighed\w*|tilladel\w*|administratorrettighed\w*/,
  /credentials?|secrets?|private api|hemmelig\w*|signeringsnøgle/,
  /signatures?|signed requests?|hmac|authenticity|integrity|autenticitet|integritet|signatur\w*/,
  /sessions?|jwt|oauth|reset tokens?|password reset|reset links|passwords?|session\w*|adgangskod\w*|nulstilling/,
];
// Ambiguous vocabulary asks for resolution; it never supplies proof.
const candidateVocabulary = /\b(?:secure|auth|tokens?)\b|sikkerhed|tokenet/;
const actions = [
  /\b(?:verify|validate|check|enforce|require|reject|restrict|protect|prevent|stop|keep|rotate|hash|calculate|implement|add|fix|repair|change|handle|store)\b/,
  /verific[eé]r|valid[eé]r|kontroll[eé]r|afvis|begræns|beskyt|forhindr|rot[eé]r|indfør|håndt[eé]r|hash|ændr|ret|tilføj/,
];
const presentation =
  /\b(?:rename|document|documentation|guide|buttons?|headings?|copy|text|labels?|placeholder|spacing|display|show|count)\b|omdøb|dokumentation|overskrift|knap|placeholder|brugerflade|antal|teksten/;
const intrinsic =
  /\bhmac(?:-sha\d+)?\b|password hash(?:ing)?|signature verification|authorization enforcement|secret handling|access.control|adgangskontrol|hash.{0,20}adgangskod/;
const negated =
  /\b(?:do not|don't|without|preserve|keep existing)\s+(?:change|modify|implement|add|verify|validate)|(?:ændr ikke|bevar eksisterende)/;
const securityPath =
  /(?:^|[/_.-])(?:auth(?:entication|orization)?|sessions?|permissions?|credentials?|secrets?|security|acl|middleware)(?:[/_.-]|$)/i;
export function collectSecurityEvidence(
  task: string,
  paths: string[],
): SecurityEvidence {
  const evidence: SecurityEvidence["evidence"] = [];
  let candidate = false,
    proven = false,
    behavioral = false,
    unresolved = false;
  // Strip copied labels but retain identifiers as candidate vocabulary. A rename
  // or documentation action suppresses proof only in its own clause.
  const clauses = task
    .toLowerCase()
    .replace(/`[^`]*`|"[^"\n]*"|'[^'\n]*'/g, " ")
    .split(/[.!?;\n]+|\b(?:but|however)\b|\bmen\b/);
  for (const clause of clauses) {
    const boundary = boundaries.some((pattern) => pattern.test(clause));
    const hint = boundary || candidateVocabulary.test(clause);
    const action = actions.some((pattern) => pattern.test(clause));
    const cosmetic = presentation.test(clause);
    const ignored = negated.test(clause);
    candidate ||= hint;
    // Password-field copy and token counts do not modify security behavior.
    if (cosmetic || ignored) {
      if (hint)
        evidence.push({
          source: "prompt",
          description: `Non-behavioral or preserved boundary: ${clause.trim()}`,
          strong: false,
        });
      continue;
    }
    behavioral ||= action;
    const matched = intrinsic.test(clause) || (boundary && action);
    if (matched) {
      proven = true;
      candidate = true;
      evidence.push({
        source: "prompt",
        description: `Security implementation action and boundary: ${clause.trim()}`,
        strong: true,
      });
    } else if (hint) {
      unresolved = true;
      evidence.push({
        source: "prompt",
        description: `Possible security boundary without resolved implementation intent: ${clause.trim()}`,
        strong: false,
      });
    }
  }
  const localized = paths.filter((path) => securityPath.test(path));
  if (localized.length) {
    candidate ||= behavioral;
    unresolved ||= behavioral && !proven;
    evidence.push({
      source: "localization",
      description: `Localized security boundary: ${JSON.stringify(localized)}; behavioral action=${behavioral}. Path alone does not establish a security mutation.`,
      strong: false,
    });
  }
  const resolution = proven
    ? "security"
    : unresolved
      ? "unresolved"
      : "non_security";
  return {
    candidate,
    resolution,
    confidence: proven ? 0.9 : unresolved ? 0.4 : 0.85,
    evidence,
  };
}
