import { isTestPath } from "../context/compiler.js";
import ts from "typescript";

export interface MutationPath {
  path: string;
}

export const isExplicitTestOnlyTask = (task: string) =>
  /\b(?:only|solely|exclusively)\b[^.\n]{0,50}\btests?\b|\btests?\s+only\b/i.test(
    task,
  ) ||
  /^\s*in\s+[\w./-]*(?:tests?|spec)[\w./-]*\.[\w]+\s*,?\s*(?:add|write|create|update|modify|fix|repair)\b/i.test(
    task,
  ) ||
  /^\s*(?:add|write|create|update|modify|fix|repair)\s+(?:(?:a|an|one|the|new|existing|focused|regression|unit|integration|deterministic|missing|failing|broken)\s+){0,8}tests?\b/i.test(
    task,
  );

const taskConceptWords = (task: string) =>
  (
    task
      .replace(
        /(?:^|\s)[\w./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb)(?=\s|[,.:;]|$)/gi,
        " ",
      )
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z][a-z0-9]*/g) ?? []
  ).filter(
    (word) =>
      !/^(?:add|write|create|update|modify|fix|repair|a|an|the|new|existing|focused|regression|unit|integration|deterministic|test|tests|that|which|verifies|verify|includes|include|contains|contain|and|or|with|for|from|into|in|proving|proves|stop|stops|when|reach|reached|make|smallest|necessary|change|run|relevant|is|are)$/.test(
        word,
      ),
  );

const identifierWords = (identifier: string) =>
  identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/_+/)
    .filter(Boolean);

/**
 * Resolve just enough local test structure to prove an existing behavioral
 * assertion. String literals and test titles are deliberately ignored. A
 * task concept must appear in the asserted expression, while the remaining
 * constraint concepts may come from parameters of helpers called by that
 * same test block. This catches a real bounded-behavior regression without
 * accepting a filename, comment, or nearby keyword as proof.
 */
function typescriptBehaviorAlreadyCovered(
  taskWords: readonly string[],
  path: string,
  content: string,
) {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return false;
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const helperParameters = new Map<string, string[]>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      helperParameters.set(
        statement.name.text,
        statement.parameters.flatMap((parameter) =>
          identifierWords(parameter.name.getText(source)),
        ),
      );
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        (!ts.isArrowFunction(declaration.initializer) &&
          !ts.isFunctionExpression(declaration.initializer))
      )
        continue;
      helperParameters.set(
        declaration.name.text,
        declaration.initializer.parameters.flatMap((parameter) =>
          identifierWords(parameter.name.getText(source)),
        ),
      );
    }
  }

  let covered = false;
  const inspect = (node: ts.Node) => {
    if (covered) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const testCall =
        (ts.isIdentifier(callee) && /^(?:test|it)$/.test(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          /^(?:test|it)$/.test(callee.expression.getText(source)));
      const callback = node.arguments.find(
        (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
      );
      if (testCall && callback) {
        const blockWords = new Set<string>();
        const assertionWords = new Set<string>();
        const setupWords = new Set<string>();
        const calledHelpers = new Set<string>();
        const visitBlock = (part: ts.Node) => {
          if (ts.isIdentifier(part))
            for (const word of identifierWords(part.text)) blockWords.add(word);
          if (ts.isCallExpression(part)) {
            if (ts.isIdentifier(part.expression))
              calledHelpers.add(part.expression.text);
            const text = part.expression.getText(source);
            if (/^(?:assert(?:\.|$)|expect$)/.test(text)) {
              const visitAssertion = (assertionPart: ts.Node) => {
                if (ts.isIdentifier(assertionPart))
                  for (const word of identifierWords(assertionPart.text))
                    assertionWords.add(word);
                ts.forEachChild(assertionPart, visitAssertion);
              };
              visitAssertion(part);
            }
          }
          ts.forEachChild(part, visitBlock);
        };
        visitBlock(callback.body);
        for (const helper of calledHelpers)
          for (const word of helperParameters.get(helper) ?? []) {
            blockWords.add(word);
            setupWords.add(word);
          }
        const relevant = new Set(
          taskWords.filter((word) => blockWords.has(word)),
        );
        const asserted = taskWords.filter((word) => assertionWords.has(word));
        const constrained = taskWords.filter((word) => setupWords.has(word));
        if (
          relevant.size >= Math.min(4, taskWords.length) &&
          asserted.length >= 1 &&
          constrained.length >= Math.min(2, taskWords.length - 1)
        )
          covered = true;
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return covered;
}

/**
 * Prove that an explicit test-only request is already represented by actual
 * assertion code. Test names, comments and filenames cannot satisfy it.
 */
export function testRequirementAlreadyCovered(
  task: string,
  files: readonly { path: string; content: string }[],
) {
  if (
    !isExplicitTestOnlyTask(task) ||
    !files.length ||
    files.some((file) => !isTestPath(file.path))
  )
    return false;
  const words = taskConceptWords(task);
  if (words.length < 2) return false;
  if (
    files.some((file) =>
      typescriptBehaviorAlreadyCovered(words, file.path, file.content),
    )
  )
    return true;
  const assertions = files.flatMap((file) =>
    file.content
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g, "")
      .split("\n")
      .filter((line) =>
        /\b(?:assert(?:\.|\s|\()|expect\s*\(|should\b|self\.assert)/i.test(
          line,
        ),
      ),
  );
  const identifiers = assertions
    .flatMap((line) => line.match(/[A-Za-z_$][\w$]*/g) ?? [])
    .map((identifier) =>
      identifier.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
    );
  const covered = new Set(
    words.filter((word) =>
      identifiers.some((identifier) => identifier.split("_").includes(word)),
    ),
  );
  const compositeAssertions = identifiers.filter(
    (identifier) =>
      words.filter((word) => identifier.split("_").includes(word)).length >= 2,
  );
  if (
    new Set(compositeAssertions).size >= 2 &&
    covered.size >= Math.min(4, words.length)
  )
    return true;
  return false;
}

/** Stable mutation success requires a non-test change whenever its locked scope owns implementation. */
export function taskRelevantMutationPaths(
  task: string,
  lockedPaths: readonly string[],
  changes: readonly MutationPath[],
) {
  const owns = (root: string, path: string) => {
    const normalized = root.replace(/\/$/, "");
    return (
      normalized === "." ||
      path === normalized ||
      path.startsWith(normalized + "/")
    );
  };

  const changed = changes.filter((change) =>
    lockedPaths.some((root) => owns(root, change.path)),
  );

  const implementationRequired =
    lockedPaths.some((path) => !isTestPath(path)) &&
    !isExplicitTestOnlyTask(task);

  return implementationRequired
    ? changed
        .filter((change) => !isTestPath(change.path))
        .map((change) => change.path)
    : changed.map((change) => change.path);
}
