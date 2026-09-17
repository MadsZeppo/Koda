import { access, lstat, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, posix } from "node:path";
import { parse } from "smol-toml";
import { safePath } from "../agent/tools.js";
import { dependencyPathAvailable } from "./dependencies.js";

export type Ecosystem = "javascript" | "python" | "generic";
export type CheckKind = "test" | "typecheck" | "lint" | "build" | "check";
export interface VerificationCandidate {
  kind: CheckKind;
  command: string;
  cwd: string;
  source: string;
  confidence: number;
  available: boolean;
  reason?: string;
  origin?: "declared" | "inferred" | "generic";
  mutatesSource: false;
  requiresInstalledDependencies: boolean;
}
export interface Manager {
  name: string;
  source: string;
  confidence: number;
}
export interface ProjectUnit {
  root: string;
  ecosystem: Ecosystem;
  packageName?: string;
  languages: string[];
  frameworks: string[];
  packageManager?: Manager;
  environmentManager?: Manager;
  buildBackend?: string;
  testRunners: string[];
  taskRunners: string[];
  scripts: Record<string, string>;
  configFiles: string[];
  verification: VerificationCandidate[];
}
export interface EcosystemProfile {
  ecosystem: Ecosystem;
  languages: string[];
  frameworks: string[];
  packageManager?: Manager;
  environmentManager?: Manager;
  projectRoot: string;
  monorepo: boolean;
  projectUnits: ProjectUnit[];
  configFiles: string[];
  evidence: { source: string; fact: string }[];
  ambiguities: string[];
}
export const generatedPath = (p: string) =>
  /(?:^|\/)(?:node_modules|\.venv|venv|vendor|dist|build|\.next|coverage|\.git|\.pytest_cache|\.mypy_cache|\.ruff_cache|__pycache__|\.turbo)(?:\/|$)/.test(
    p,
  );
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export const scopedCheck = (cwd: string, cmd: string) =>
  cwd === "." ? cmd : `cd ${quote(cwd)} && ${cmd}`;
export function projectFor(
  profile: EcosystemProfile | undefined,
  path: string,
) {
  return profile?.projectUnits
    .filter(
      (u) => u.root === "." || path === u.root || path.startsWith(u.root + "/"),
    )
    .sort((a, b) => b.root.length - a.root.length)[0];
}
export function compactEcosystem(
  profile: EcosystemProfile | undefined,
  paths: string[] = [],
) {
  if (!profile) return undefined;
  const units = paths.length
    ? [
        ...new Set(
          paths
            .map((p) => projectFor(profile, p))
            .filter((u): u is ProjectUnit => !!u),
        ),
      ]
    : profile.projectUnits.slice(0, 8);
  return {
    ecosystem: profile.ecosystem,
    languages: profile.languages,
    frameworks: profile.frameworks,
    monorepo: profile.monorepo,
    projects: units.map((u) => ({
      root: u.root,
      frameworks: u.frameworks,
      manager: u.packageManager?.name,
      environmentManager: u.environmentManager?.name,
      testRunners: u.testRunners,
    })),
  };
}
const unique = <T>(a: T[]) => [...new Set(a)];
export async function executable(name: string) {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean))
    for (const ext of process.platform === "win32"
      ? [".exe", ".cmd", ".bat", ""]
      : [""])
      try {
        await access(join(dir, name + ext), constants.X_OK);
        return true;
      } catch {}
  return false;
}
export const verificationKind = (name: string): CheckKind | undefined =>
  /^(?:test(?::(?:unit|ci|integration))?)$/.test(name)
    ? "test"
    : /^(?:typecheck|type-check|check-types|check:types)$/.test(name)
      ? "typecheck"
      : name === "lint"
        ? "lint"
        : name === "build"
          ? "build"
          : /^(?:check|verify|validate)$/.test(name)
            ? "check"
            : undefined;
const recursiveScript = (body: string) =>
  body.match(/^pnpm (?:-r|--recursive) (?:run )?([\w:-]+)$/)?.[1] ??
  body.match(/^npm (?:run )?([\w:-]+) --workspaces$/)?.[1];
/** Only recognized verification entrypoints; inspect script chains and hooks too.
 * This is conservative selection, not a shell security boundary. Execution stays sandboxed. */
export function safeVerificationScript(
  body: string,
  scripts: Record<string, string>,
  seen = new Set<string>(),
): boolean {
  if (/[\x00-\x08]|\$\(|`/.test(body)) return false;
  if (
    !body.trim() ||
    /no test specified|\b(?:install|sync|deploy|publish|release|rm|rmdir|mv|sudo|runserver|uvicorn|serve|watch|reset-db|seed|migrate|curl|wget)\b|--(?:fix|write)\b|\b(?:ruff|prettier)\s+format\b|\b(?:next|vite)\s+dev\b|\bnpx\b|\bbunx\b|\bdlx\b/i.test(
      body,
    )
  )
    return false;
  if (/^(?:true|echo|printf|pwd|ls|git status)(?:\s|$)/.test(body.trim()))
    return false;
  if (/\b(?:start|dev)\b/.test(body) || /^vite\s*$/.test(body.trim()))
    return false;
  if (recursiveScript(body)) return !!verificationKind(recursiveScript(body)!);
  for (const m of body.matchAll(
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/g,
  )) {
    if (m[0] === "bun test" || /^(?:pnpm|yarn)\s+exec$/.test(m[0])) continue;
    const name = m[1]!;
    if (!verificationKind(name) || seen.has(name) || !scripts[name])
      return false;
    const next = new Set(seen).add(name);
    if (!safeVerificationScript(scripts[name]!, scripts, next)) return false;
    for (const hook of ["pre" + name, "post" + name])
      if (
        scripts[hook] &&
        !safeVerificationScript(scripts[hook]!, scripts, next)
      )
        return false;
  }
  return true;
}
const configName = (p: string) =>
  /(?:^|\/)requirements\/[^/]+\.txt$/.test(p) ||
  /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|(?:ts|js)config(?:\.[^/]+)?\.json|(?:next|vite|vitest|jest|playwright|eslint)\.config\.[^/]+|\.eslintrc[^/]*|pyproject\.toml|requirements(?:[^/]*)\.txt|setup\.(?:cfg|py)|Pipfile|tox\.(?:ini|toml)|noxfile\.py|pytest\.(?:ini|toml)|\.?ruff\.toml|\.?mypy\.ini|manage\.py|nx\.json|turbo\.json)$/.test(
    p,
  );
export async function detectEcosystem(
  root: string,
  files: string[],
): Promise<EcosystemProfile> {
  const evidence: EcosystemProfile["evidence"] = [],
    ambiguities: string[] = [];
  const cache = new Map<string, string>();
  const text = async (path: string) => {
    if (cache.has(path)) return cache.get(path)!;
    try {
      const full = await safePath(root, path);
      if ((await lstat(full)).size > 65536) {
        ambiguities.push(`Metadata too large: ${path}`);
        return "";
      }
      const value = await readFile(full, "utf8");
      cache.set(path, value);
      return value;
    } catch {
      return "";
    }
  };
  const json = async (path: string) => {
    try {
      const value = JSON.parse(await text(path));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error("Expected manifest object");
      return value;
    } catch {
      if (files.includes(path)) ambiguities.push(`Invalid JSON: ${path}`);
      return {};
    }
  };
  const toml = async (path: string) => {
    try {
      return parse(await text(path)) as any;
    } catch {
      ambiguities.push(`Invalid TOML: ${path}`);
      return {};
    }
  };
  const exists = async (path: string) => {
    try {
      await access(join(root, path));
      return true;
    } catch {
      return dependencyPathAvailable(root, path);
    }
  };
  const at = (dir: string, file: string) => posix.join(dir, file);
  const rootPkg = await json("package.json");
  let patterns: string[] = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? []);
  if (!Array.isArray(patterns)) {
    ambiguities.push("Invalid workspaces declaration");
    patterns = [];
  }
  patterns = patterns.filter((p) => typeof p === "string");
  // Bounded support for ordinary pnpm package glob lists; unsupported YAML is recorded.
  const workspace = await text("pnpm-workspace.yaml");
  if (workspace) {
    const block = workspace.match(
      /^packages:\s*\n((?:[ \t]+[^\n]*\n?)*)/m,
    )?.[1];
    const lines =
      block?.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")) ??
      [];
    const parsed = lines.map(
      (l) => l.match(/^\s*-\s*['"]?(!?[\w./*\-]+)['"]?\s*(?:#.*)?$/)?.[1],
    );
    if (!lines.length || parsed.some((p) => !p))
      ambiguities.push(
        "Unsupported pnpm workspace syntax; nested manifests remain independent units",
      );
    else patterns.push(...(parsed as string[]));
  }
  const matches = (path: string, pattern: string) => {
    if (pattern.includes("..")) return false;
    const re = pattern
      .replace(/[.+^$(){}|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*");
    return new RegExp("^" + re + "/?$").test(path);
  };
  const manifests = files
    .filter((f) => /(?:^|\/)(?:package\.json|pyproject\.toml)$/.test(f))
    .slice(0, 64);
  const roots = unique([".", ...manifests.map(posix.dirname)]);
  if (
    files.some((f) =>
      /^(?:requirements(?:\/.*)?\.txt|pytest\.(?:ini|toml)|setup\.(?:py|cfg)|manage\.py|Pipfile)$/.test(
        f,
      ),
    ) &&
    !roots.includes(".")
  )
    roots.unshift(".");
  const units: ProjectUnit[] = [];
  let rootManager: Manager | undefined;
  for (const dir of roots) {
    const own = files.filter((f) => posix.dirname(f) === dir);
    const pkg = dir === "." ? rootPkg : await json(at(dir, "package.json"));
    const py = files.includes(at(dir, "pyproject.toml"))
      ? await toml(at(dir, "pyproject.toml"))
      : {};
    const prefix = dir === "." ? "" : dir + "/";
    const local = files.filter(
      (f) =>
        f.startsWith(prefix) &&
        !roots.some(
          (r) =>
            r !== dir &&
            r !== "." &&
            r.startsWith(prefix) &&
            f.startsWith(r + "/"),
        ),
    );
    const hasJS = files.includes(at(dir, "package.json"));
    const hasPy =
      files.includes(at(dir, "pyproject.toml")) ||
      own.some((f) =>
        /(?:requirements.*\.txt|setup\.(?:py|cfg)|pytest\.(?:ini|toml)|manage\.py|Pipfile)$/.test(
          f,
        ),
      );
    const langs = unique(
      local.flatMap((f) =>
        /\.[cm]?tsx?$/.test(f)
          ? ["typescript"]
          : /\.[cm]?jsx?$/.test(f)
            ? ["javascript"]
            : /\.py$/.test(f)
              ? ["python"]
              : [],
      ),
    );
    if (
      own.some((f) => /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(f)) &&
      !langs.includes("typescript")
    )
      langs.push("typescript");
    const ecosystem: Ecosystem =
      hasJS ||
      own.some((f) => /(?:^|\/)(?:ts|js)config(?:\.[^/]+)?\.json$/.test(f))
        ? "javascript"
        : hasPy
          ? "python"
          : langs.includes("python")
            ? "python"
            : local.some(
                  (f) => posix.dirname(f) === dir && /\.[cm]?[jt]sx?$/.test(f),
                )
              ? "javascript"
              : "generic";
    const unit: ProjectUnit = {
      root: dir,
      ecosystem,
      languages: langs,
      frameworks: [],
      testRunners: [],
      taskRunners: [],
      scripts: {},
      configFiles: local.filter(configName).slice(0, 24),
      verification: [],
    };
    const candidate = (
      kind: CheckKind,
      cmd: string,
      source: string,
      available: boolean,
      reason?: string,
      confidence = 1,
    ) => {
      unit.verification.push({
        kind,
        command: scopedCheck(dir, cmd),
        cwd: dir,
        source,
        confidence,
        available,
        reason,
        origin: source.startsWith("generic:")
          ? "generic"
          : /scripts\.|:task\./.test(source)
            ? "declared"
            : "inferred",
        mutatesSource: false,
        requiresInstalledDependencies: !/^node\s/.test(cmd),
      });
    };
    if (ecosystem === "javascript") {
      unit.packageName = pkg.name;
      unit.scripts = Object.fromEntries(
        Object.entries(pkg.scripts ?? {}).filter(
          ([, v]) => typeof v === "string",
        ),
      ) as Record<string, string>;
      const locks = [
        ["pnpm", "pnpm-lock.yaml"],
        ["npm", "package-lock.json"],
        ["npm", "npm-shrinkwrap.json"],
        ["yarn", "yarn.lock"],
        ["bun", "bun.lock"],
        ["bun", "bun.lockb"],
      ].filter(([, f]) => own.includes(at(dir, f!)));
      for (const [name, file] of locks)
        evidence.push({ source: at(dir, file!), fact: `lockfile:${name}` });
      const declaration = String(
        pkg.packageManager ?? pkg.devEngines?.packageManager?.name ?? "",
      );
      const explicit = declaration.match(/^(pnpm|npm|yarn|bun)(?:@|$)/)?.[1];
      const unsupported = !!declaration && !explicit;
      if (unsupported)
        ambiguities.push(`Unsupported package manager declaration at ${dir}`);
      const locked = unique(locks.map(([n]) => n!));
      const declared =
        patterns.some((p) => !p.startsWith("!") && matches(dir, p)) &&
        !patterns.some((p) => p.startsWith("!") && matches(dir, p.slice(1)));
      const name = unsupported
        ? undefined
        : (explicit ??
          (locked.length === 1
            ? locked[0]
            : locked.length > 1
              ? undefined
              : dir !== "." && declared
                ? rootManager?.name
                : dir === "." && workspace
                  ? "pnpm"
                  : hasJS
                    ? "npm"
                    : undefined));
      if (locked.length > 1 || (explicit && locked.some((n) => n !== explicit)))
        ambiguities.push(
          `Conflicting package managers at ${dir}: ${[explicit, ...locked].filter(Boolean).join(", ")}`,
        );
      if (name)
        unit.packageManager = {
          name,
          source: explicit
            ? at(dir, "package.json:packageManager")
            : (locks.find(([n]) => n === name)?.[1] ??
              (declared
                ? "workspace declaration"
                : workspace
                  ? "pnpm-workspace.yaml"
                  : "package.json fallback")),
          confidence: explicit
            ? 1
            : locked.length === 1
              ? 0.95
              : declared
                ? 0.95
                : 0.8,
        };
      if (dir === ".") rootManager = unit.packageManager;
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };
      for (const [dep, framework] of [
        ["next", "nextjs"],
        ["react", "react"],
        ["vite", "vite"],
        ["express", "express"],
        ["@nestjs/core", "nestjs"],
      ])
        if (dep! in deps) {
          unit.frameworks.push(framework!);
          evidence.push({
            source: at(dir, "package.json"),
            fact: `dependency:${dep}`,
          });
        }
      for (const [pattern, framework] of [
        [/^next\.config\./, "nextjs"],
        [/^vite\.config\./, "vite"],
      ] as const)
        if (
          own.some((f) => pattern.test(posix.basename(f))) &&
          !unit.frameworks.includes(framework)
        )
          unit.frameworks.push(framework);
      if (!unit.frameworks.length) unit.frameworks.push("nodejs");
      for (const runner of ["vitest", "jest", "@playwright/test"])
        if (
          runner in deps ||
          Object.values(unit.scripts).some((s) =>
            new RegExp(
              "\\b" +
                (runner === "@playwright/test" ? "playwright" : runner) +
                "\\b",
            ).test(s),
          )
        )
          unit.testRunners.push(
            runner === "@playwright/test" ? "playwright" : runner,
          );
      if (Object.values(unit.scripts).some((s) => /\bnode\s+--test\b/.test(s)))
        unit.testRunners.push("node");
      for (const runner of ["vitest", "jest", "playwright"])
        if (
          own.some((f) => posix.basename(f).startsWith(runner + ".config.")) &&
          !unit.testRunners.includes(runner)
        )
          unit.testRunners.push(runner);
      for (const runner of ["nx", "turbo"])
        if (runner in deps || own.includes(at(dir, runner + ".json")))
          unit.taskRunners.push(runner);
      const managerAvailable = !!name && (await executable(name));
      const localBin = async (bin: string) => {
        for (const base of unique([dir, "."]))
          if (
            await exists(
              at(
                base,
                `node_modules/.bin/${bin}${process.platform === "win32" ? ".cmd" : ""}`,
              ),
            )
          )
            return true;
        return false;
      };
      const scriptAvailable = async (
        body: string,
        seen = new Set<string>(),
      ): Promise<boolean> => {
        if (recursiveScript(body)) return true; // Child contracts are checked after all units have been profiled.
        if (/^bun test(?:\s|$)/.test(body)) return await executable("bun");
        if (/^(?:pnpm|yarn)\s+exec\s+/.test(body))
          return scriptAvailable(
            body.replace(/^(?:pnpm|yarn)\s+exec\s+/, ""),
            seen,
          );
        if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]+/.test(body)) {
          for (const m of body.matchAll(
            /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/g,
          )) {
            if (seen.has(m[1]!) || !unit.scripts[m[1]!]) return false;
            if (
              !(await scriptAvailable(
                unit.scripts[m[1]!]!,
                new Set(seen).add(m[1]!),
              ))
            )
              return false;
          }
          return true;
        }
        if (body.includes("&&"))
          return (
            await Promise.all(
              body.split("&&").map((b) => scriptAvailable(b.trim(), seen)),
            )
          ).every(Boolean);
        const bin = body.trim().split(/\s+/)[0]!;
        if (bin === "node")
          return (
            (await executable("node")) &&
            (!Object.keys(deps).length ||
              (await exists(at(dir, "node_modules"))) ||
              (await exists("node_modules")))
          );
        return /^[\w-]+$/.test(bin) && (await localBin(bin));
      };
      for (const [script, body] of Object.entries(unit.scripts)) {
        const kind = verificationKind(script);
        if (!kind) continue;
        const bodies = [
          body,
          ...["pre" + script, "post" + script].flatMap((h) =>
            unit.scripts[h] ? [unit.scripts[h]!] : [],
          ),
        ];
        const safe = bodies.every((b) =>
          safeVerificationScript(b, unit.scripts),
        );
        const available =
          safe &&
          managerAvailable &&
          (await Promise.all(bodies.map((b) => scriptAvailable(b)))).every(
            Boolean,
          );
        candidate(
          kind,
          `${name ?? "npm"} run ${script}`,
          at(dir, `package.json:scripts.${script}`),
          available,
          !safe
            ? "unsafe_verification_command"
            : !name
              ? "package_manager_ambiguous"
              : !available
                ? "dependencies_not_available"
                : undefined,
        );
      }
      const tsconfigs = own.filter((f) =>
        /^tsconfig(?:\.[^/]+)?\.json$/.test(posix.basename(f)),
      );
      if (
        !unit.verification.some((c) => c.kind === "typecheck") &&
        tsconfigs.length
      ) {
        const project = own.includes(at(dir, "tsconfig.json"))
          ? at(dir, "tsconfig.json")
          : tsconfigs.length === 1
            ? tsconfigs[0]!
            : undefined;
        const references =
          project && /["']references["']\s*:/.test(await text(project));
        const local = await localBin("tsc");
        const bin = (await exists(at(dir, "node_modules/.bin/tsc")))
          ? "./node_modules/.bin/tsc"
          : dir === "."
            ? "./node_modules/.bin/tsc"
            : posix.relative(dir, "node_modules/.bin/tsc");
        candidate(
          "typecheck",
          `${quote(bin)} --noEmit -p ${project ? posix.basename(project) : "tsconfig.json"}`,
          project ?? at(dir, "tsconfig.*.json"),
          local && !!project && !references,
          !project
            ? "ambiguous_typescript_project"
            : references
              ? "project_references_require_explicit_command"
              : local
                ? undefined
                : "dependencies_not_available",
          0.9,
        );
      }
    }
    if (ecosystem === "python" || hasPy) {
      const tool = py.tool ?? {};
      const locks = [
        ["uv", "uv.lock"],
        ["poetry", "poetry.lock"],
        ["pdm", "pdm.lock"],
        ["pipenv", "Pipfile.lock"],
      ].filter(([, f]) => own.includes(at(dir, f!)));
      const hints = unique(
        locks.length
          ? locks.map(([n]) => n!)
          : ["uv", "poetry", "pdm"].filter((n) => tool[n]),
      );
      if (hints.length > 1)
        ambiguities.push(
          `Conflicting Python environments at ${dir}: ${hints.join(", ")}`,
        );
      const name =
        hints.length === 1
          ? hints[0]
          : hints.length > 1
            ? undefined
            : own.some((f) => /requirements.*\.txt|Pipfile$/.test(f))
              ? "pip"
              : undefined;
      if (name)
        unit.environmentManager = {
          name,
          source: locks[0]?.[1] ?? "pyproject/tool or requirements",
          confidence: 0.95,
        };
      if (ecosystem === "python") unit.packageManager = unit.environmentManager;
      if (unit.environmentManager)
        evidence.push({
          source: at(dir, unit.environmentManager.source),
          fact: `environment_manager:${unit.environmentManager.name}`,
        });
      unit.buildBackend = py["build-system"]?.["build-backend"];
      const strings = (v: any): string[] =>
        typeof v === "string"
          ? [v]
          : Array.isArray(v)
            ? v.flatMap(strings)
            : v && typeof v === "object"
              ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)])
              : [];
      const dependencyText = [
        ...strings(py.project?.dependencies),
        ...strings(py.project?.["optional-dependencies"]),
        ...strings(py["dependency-groups"]),
        ...strings(tool.poetry?.dependencies),
        ...strings(tool.poetry?.group),
        ...strings(tool.pdm?.["dev-dependencies"]),
        ...(await Promise.all(
          local
            .filter((p) => /requirements.*\.txt$/.test(p))
            .slice(0, 8)
            .map(text),
        )),
      ]
        .join("\n")
        .toLowerCase();
      const dependencySource =
        [
          ...(files.includes(at(dir, "pyproject.toml"))
            ? [at(dir, "pyproject.toml")]
            : []),
          ...local.filter((p) => /requirements.*\.txt$/.test(p)).slice(0, 8),
        ].join(", ") || at(dir, "dependency metadata");
      const dep = (name: string) =>
        new RegExp(`(?:^|[\\s"'])${name}(?:[\\s[<>=!~;"]|$)`, "im").test(
          dependencyText,
        );
      for (const framework of ["fastapi", "django"])
        if (dep(framework)) {
          unit.frameworks.push(framework);
          evidence.push({
            source: dependencySource,
            fact: `dependency:${framework}`,
          });
        }
      if (
        own.includes(at(dir, "manage.py")) &&
        !unit.frameworks.includes("django")
      )
        unit.frameworks.push("django");
      const ini = await Promise.all(
        ["pytest.ini", "setup.cfg", "tox.ini"].map((f) => text(at(dir, f))),
      );
      const pytest =
        !!tool.pytest ||
        own.includes(at(dir, "pytest.toml")) ||
        ini.some((s) => /\[(?:tool:)?pytest\]|\bpytest\b/.test(s)) ||
        dep("pytest") ||
        dep("pytest-django");
      const ruff =
        !!tool.ruff || own.some((f) => /\.?ruff\.toml$/.test(f)) || dep("ruff");
      const mypy =
        !!tool.mypy ||
        own.some((f) => /\.?mypy\.ini$/.test(f)) ||
        ini.some((s) => /\[mypy\]/.test(s)) ||
        dep("mypy");
      for (const runner of ["tox", "nox"])
        if (
          own.some((f) =>
            new RegExp(
              `${runner === "nox" ? "noxfile\\.py" : "tox\\.(?:ini|toml)"}$`,
            ).test(f),
          ) ||
          tool[runner]
        )
          unit.taskRunners.push(runner);
      let environment: string | undefined;
      for (const env of [".venv", "venv"])
        if (await exists(at(dir, env + "/pyvenv.cfg"))) {
          environment = env;
          break;
        }
      const pybin = environment
        ? at(
            environment,
            process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
          )
        : undefined;
      const python =
        pybin && (await exists(at(dir, pybin)))
          ? quote("./" + pybin)
          : undefined;
      const installed = async (module: string) => {
        if (!environment || !python) return false;
        const envroot = at(dir, environment);
        const candidates =
          process.platform === "win32"
            ? [at(envroot, "Lib/site-packages")]
            : await readdir(join(root, envroot, "lib"))
                .then((ds) =>
                  ds
                    .filter((d) => /^python\d/.test(d))
                    .slice(0, 4)
                    .map((d) => at(envroot, `lib/${d}/site-packages`)),
                )
                .catch(() => []);
        return (
          await Promise.all(
            candidates.map((p) => exists(at(p, module.replaceAll("-", "_")))),
          )
        ).some(Boolean);
      };
      const addPy = async (
        kind: CheckKind,
        module: string,
        args: string,
        source: string,
      ) => {
        const local = await installed(module);
        const global =
          !environment &&
          (!name || name === "pip") &&
          (await executable(module));
        const available = local || global;
        candidate(
          kind,
          (global
            ? `${module} ${args}`
            : `${python ?? "python"} -B -m ${module} ${args}`
          ).trim(),
          source,
          available,
          available ? undefined : "dependencies_not_available",
          0.9,
        );
      };
      // Direct use of an existing environment avoids manager sync/lock mutations on all versions.
      if (pytest) {
        unit.testRunners.push("pytest");
        await addPy(
          "test",
          "pytest",
          "-p no:cacheprovider",
          tool.pytest
            ? at(dir, "pyproject.toml:tool.pytest")
            : (own.find((f) => /pytest\.(?:ini|toml)$/.test(f)) ??
                (["setup.cfg", "tox.ini"].find((f, i) =>
                  /\bpytest\b/.test(ini[i + 1] ?? ""),
                )
                  ? at(
                      dir,
                      ["setup.cfg", "tox.ini"].find((f, i) =>
                        /\bpytest\b/.test(ini[i + 1] ?? ""),
                      )!,
                    )
                  : dependencySource)),
        );
      } else if (unit.frameworks.includes("django")) {
        unit.testRunners.push("django");
        const available = await installed("django");
        candidate(
          "test",
          `${python ?? "python"} -B manage.py test`,
          at(dir, "manage.py"),
          available,
          available ? undefined : "dependencies_not_available",
          0.9,
        );
      } else if (local.some((f) => /(?:^|\/)test_.*\.py$/.test(f))) {
        unit.testRunners.push("pytest");
        await addPy(
          "test",
          "pytest",
          "-p no:cacheprovider",
          "inferred:test-file convention",
        );
      }
      if (ruff)
        await addPy(
          "lint",
          "ruff",
          "check --no-cache .",
          tool.ruff
            ? at(dir, "pyproject.toml:tool.ruff")
            : (own.find((f) => /\.?ruff\.toml$/.test(f)) ?? dependencySource),
        );
      if (mypy)
        await addPy(
          "typecheck",
          "mypy",
          typeof tool.mypy?.files === "string" ||
            Array.isArray(tool.mypy?.files) ||
            ini.some((s) => /^files\s*=/m.test(s))
            ? ""
            : ".",
          tool.mypy
            ? at(dir, "pyproject.toml:tool.mypy")
            : (own.find((f) => /\.?mypy\.ini$/.test(f)) ??
                (ini.some((s) => /\[mypy\]/.test(s))
                  ? at(dir, "setup.cfg:mypy")
                  : dependencySource)),
        );
      for (const runner of unit.taskRunners)
        candidate(
          "check",
          runner,
          at(dir, `${runner} configuration`),
          false,
          "environment_provisioning_not_allowed",
          1,
        );
      const commands =
        tool.pdm?.scripts ?? tool.hatch?.envs?.default?.scripts ?? {};
      for (const [script, value] of Object.entries(commands)) {
        const kind = verificationKind(script),
          body = typeof value === "string" ? value : undefined;
        if (!kind || !body) continue;
        const safe = safeVerificationScript(body, {});
        const native = body.match(/^(pytest|ruff|mypy)\b(.*)$/);
        const available =
          safe &&
          !!native &&
          !/[;&|<>]/.test(body) &&
          (await installed(native[1]!));
        candidate(
          kind,
          native && python ? `${python} -B -m ${native[1]} ${native[2]}` : body,
          at(dir, `pyproject.toml:task.${script}`),
          available,
          available
            ? undefined
            : safe
              ? "task_environment_not_resolved"
              : "unsafe_verification_command",
        );
      }
    } else if (ecosystem === "generic") {
      if (own.includes(at(dir, "Cargo.toml")))
        for (const cmd of ["cargo test", "cargo check"])
          candidate(
            cmd.endsWith("test") ? "test" : "typecheck",
            cmd,
            "generic:Cargo.toml",
            true,
          );
      if (own.includes(at(dir, "go.mod")))
        candidate("test", "go test ./...", "generic:go.mod", true);
    }
    evidence.push({ source: dir, fact: `ecosystem:${ecosystem}` });
    units.push(unit);
  }
  for (const unit of units)
    for (const candidate of unit.verification) {
      const body =
        unit.scripts[candidate.source.split("scripts.")[1] ?? ""] ?? "";
      const target = recursiveScript(body);
      if (!target) continue;
      const children = units
        .filter((u) => u.root !== unit.root)
        .flatMap((u) =>
          u.verification.filter((c) => c.source.endsWith("scripts." + target)),
        );
      if (!children.length || children.some((c) => !c.available)) {
        candidate.available = false;
        candidate.reason = children.some(
          (c) => c.reason === "unsafe_verification_command",
        )
          ? "unsafe_verification_command"
          : "dependencies_not_available";
      }
    }
  return {
    ecosystem: units[0]!.ecosystem,
    languages: unique(units.flatMap((u) => u.languages)),
    frameworks: unique(units.flatMap((u) => u.frameworks)),
    packageManager: units[0]!.packageManager,
    environmentManager: units[0]!.environmentManager,
    projectRoot: ".",
    monorepo:
      units.length > 1 ||
      patterns.length > 0 ||
      files.includes("nx.json") ||
      files.includes("turbo.json"),
    projectUnits: units,
    configFiles: unique(units.flatMap((u) => u.configFiles)),
    evidence,
    ambiguities,
  };
}
