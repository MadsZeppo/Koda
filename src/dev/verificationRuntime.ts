import { access, readFile, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { digest } from "../router/knowledge/evidenceRegistry.js";
import {
  verify,
  verificationResult,
  runtimeInfrastructureFailure,
} from "../verifier/verifier.js";
import type { CommandResult } from "../types.js";
export type VerificationRuntime =
  | {
      kind: "container";
      image: string;
      workdir?: string;
      path?: string;
      harnessVersion?: string;
    }
  | { kind: "repository"; path?: string; provenance: string };
export interface PreflightItem {
  name: string;
  status: "PASS" | "WARN" | "BLOCKED";
  detail: string;
}
const probe = async (bin: string, args: string[]) =>
  execa(bin, args, { reject: false, timeout: 15000 }).then(
    (r) => ({ ok: r.exitCode === 0, text: r.stdout || r.stderr }),
    (e) => ({ ok: false, text: String(e) }),
  );
/** Runtime selection is explicit for benchmark/container tasks. Local inference never installs global dependencies. */
export async function resolveVerificationRuntime(
  repo: string,
  explicit?: VerificationRuntime,
) {
  if (explicit) {
    if (
      explicit.kind === "container" &&
      (!explicit.image ||
        !/^\/[a-zA-Z0-9_./-]+$/.test(explicit.workdir ?? "/testbed") ||
        (explicit.workdir ?? "/testbed").split("/").includes("..") ||
        explicit.workdir === "/")
    )
      throw Error("Invalid verification container");
    return explicit;
  }
  if (
    await access(join(repo, ".venv/bin/python")).then(
      () => true,
      () => false,
    )
  )
    return {
      kind: "repository",
      path: `${resolve(repo, ".venv/bin")}:${process.env.PATH}`,
      provenance: "repository .venv",
    } as const;
  // Node/Go/Rust/JVM command selection belongs to repository-defined checks, not a pytest default.
  return {
    kind: "repository",
    provenance: "repository-defined commands; host runtime explicit fallback",
  } as const;
}
export async function verificationPreflight(input: {
  repo: string;
  commit: string;
  runtime?: VerificationRuntime;
  candidateAvailable?: boolean;
  truthAvailable?: boolean;
  truthIsolated?: boolean;
  output?: string;
}) {
  const runtime = await resolveVerificationRuntime(input.repo, input.runtime);
  const docker = await probe("docker", ["--version"]);
  const daemon = docker.ok
    ? await probe("docker", [
        "info",
        "--format",
        "{{.OSType}}/{{.Architecture}}",
      ])
    : { ok: false, text: "Docker unavailable" };
  const disk = await statfs(input.output ?? input.repo).then(
    (s) => Number(s.bavail) * Number(s.bsize),
    () => null,
  );
  const checkout = await probe("git", [
    "-C",
    resolve(input.repo),
    "cat-file",
    "-e",
    input.commit + "^{commit}",
  ]);
  const items: PreflightItem[] = [
    {
      name: "Docker",
      status: docker.ok
        ? "PASS"
        : runtime.kind === "container"
          ? "BLOCKED"
          : "WARN",
      detail: docker.text,
    },
    {
      name: "daemon/architecture",
      status: daemon.ok
        ? "PASS"
        : runtime.kind === "container"
          ? "BLOCKED"
          : "WARN",
      detail: daemon.text,
    },
    {
      name: "disk",
      status:
        disk === null ? "WARN" : disk < 512 * 1024 * 1024 ? "BLOCKED" : "PASS",
      detail: disk === null ? "UNKNOWN" : `${disk} bytes available`,
    },
    {
      name: "repo checkout",
      status: checkout.ok ? "PASS" : "BLOCKED",
      detail: checkout.text || input.commit,
    },
    {
      name: "candidate artifact",
      status: input.candidateAvailable === false ? "BLOCKED" : "PASS",
      detail: "runtime candidate only",
    },
    {
      name: "hidden truth separation",
      status: input.truthIsolated === false ? "BLOCKED" : "PASS",
      detail: "Stage B source never mounted or passed to Stage A",
    },
    {
      name: "Stage B truth source",
      status: input.truthAvailable === false ? "WARN" : "PASS",
      detail:
        input.truthAvailable === undefined
          ? "not inspected by Stage A"
          : "external label artifact",
    },
  ];
  let imageDigest: string | undefined;
  if (runtime.kind === "container") {
    const image = await probe("docker", [
      "image",
      "inspect",
      runtime.image,
      "--format",
      "{{.Id}}",
    ]);
    imageDigest = image.ok ? image.text : undefined;
    items.push({
      name: "task environment/image",
      status: image.ok ? "PASS" : "BLOCKED",
      detail: image.ok
        ? image.text
        : "Image missing: explicit prepare/pull required; automatic pull disabled",
    });
    items.push({
      name: "runtime/package manager",
      status: image.ok ? "PASS" : "BLOCKED",
      detail: "Commands run inside pinned task image; host pytest irrelevant",
    });
  } else {
    const node = await probe("node", ["--version"]);
    items.push({
      name: "runtime/package manager",
      status: node.ok ? "PASS" : "WARN",
      detail: `Repository commands determine required tools; Node ${node.text}`,
    });
  }
  items.push({
    name: "Stage A runner",
    status: items.some((i) => i.status === "BLOCKED") ? "BLOCKED" : "PASS",
    detail: "No model calls; no automatic environment downloads",
  });
  return {
    runtime,
    items,
    imageDigest,
    usable: !items.some((i) => i.status === "BLOCKED"),
    architecture: process.arch,
  };
}
export async function runVerificationRuntime(
  repo: string,
  commands: string[],
  runtime: VerificationRuntime,
  timeout: number,
) {
  if (runtime.kind === "repository") {
    // Do not mutate process.env across parallel jobs. Explicit venv PATH is resolved into command interpreter instead.
    const runtimePath = runtime.path;
    const checks = runtimePath
      ? commands.map((c) =>
          c.replace(
            /\bpython(?:3)?\b/g,
            join(runtimePath.split(":")[0]!, "python"),
          ),
        )
      : commands;
    const result = await verify(repo, checks, timeout);
    result.checks.forEach((c, i) => (c.command = commands[i] ?? c.command));
    return {
      result,
      versions: { node: process.version, provenance: runtime.provenance },
      runtimeDigest: digest(runtime),
    };
  }
  const image = await probe("docker", [
    "image",
    "inspect",
    runtime.image,
    "--format",
    "{{.Id}}",
  ]);
  if (!image.ok)
    throw Error(
      "VERIFICATION_INFRA_FAILURE: task image absent; no automatic pull",
    );
  const name = `koda-verifier-${randomUUID()}`;
  // No host mounts, Docker socket, credentials, network or truth directories. Only the prepared base tree is copied.
  await execa("docker", [
    "create",
    "--pull=never",
    "--network=none",
    "--cpus=2",
    "--memory=2g",
    "--pids-limit=256",
    "--name",
    name,
    "--entrypoint",
    "/bin/sh",
    image.text,
    "-c",
    "while :; do sleep 60; done",
  ]);
  try {
    await execa("docker", ["start", name]);
    const wd = runtime.workdir ?? "/testbed";
    await execa("docker", [
      "exec",
      name,
      "sh",
      "-c",
      `mkdir -p '${wd}'; find '${wd}' -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
    ]);
    await execa("docker", ["cp", repo + "/.", name + ":" + wd]);
    const versions = await probe("docker", [
      "exec",
      name,
      "sh",
      "-c",
      "node --version 2>/dev/null; python --version 2>/dev/null; git --version 2>/dev/null; true",
    ]);
    const checks: CommandResult[] = [];
    for (const command of commands) {
      const start = Date.now();
      try {
        const r = await execa(
          "docker",
          [
            "exec",
            "-w",
            wd,
            ...(runtime.path ? ["-e", `PATH=${runtime.path}`] : []),
            name,
            "sh",
            "-c",
            command,
          ],
          { reject: false, timeout },
        );
        const c: CommandResult = {
          command,
          exitCode: r.exitCode ?? 1,
          stdout: r.stdout,
          stderr: r.stderr,
          wallClockMs: Date.now() - start,
          timedOut: false,
          requirement: "required",
        };
        if (runtimeInfrastructureFailure(c)) {
          c.unavailable = runtimeInfrastructureFailure(c);
          c.outcome = "INFRA_FAILURE";
        }
        checks.push(c);
      } catch (e) {
        checks.push({
          command,
          exitCode: 1,
          stdout: "",
          stderr: String(e),
          wallClockMs: Date.now() - start,
          timedOut: true,
          unavailable: "verification_runtime_failure",
          outcome: "INFRA_FAILURE",
        });
      }
    }
    // Capture repository mutation caused by tests; byte differences are checked by Stage A before decision.
    await execa("docker", ["cp", name + ":" + wd + "/.", repo]);
    return {
      result: verificationResult(checks),
      versions: {
        imageDigest: image.text,
        harnessVersion: runtime.harnessVersion ?? "repository-defined",
        tools: versions.text,
      },
      runtimeDigest: digest([runtime, image.text]),
    };
  } finally {
    await execa("docker", ["rm", "-f", name], { reject: false });
  }
}
