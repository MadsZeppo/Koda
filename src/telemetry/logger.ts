import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export class Logger {
  events: any[] = [];
  constructor(
    readonly directory: string,
    readonly runId: string,
    readonly quiet = false,
  ) {
    mkdirSync(directory, { recursive: true });
  }
  log(type: string, data: Record<string, any> = {}) {
    const raw = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      type,
      ...data,
    };
    let line = JSON.stringify(raw);
    const secret = process.env.OPENROUTER_API_KEY;
    if (secret) line = line.split(secret).join("[REDACTED]");
    const event = JSON.parse(line);
    this.events.push(event);
    appendFileSync(join(this.directory, "events.jsonl"), line + "\n");
    if (this.quiet) return;
    const d = event;
    const label = d.subtaskId ? ` ${d.subtaskId}` : "";
    let detail: string;
    switch (type) {
      case "model_router":
        detail = `selected_model=${d.selected_model} estimated_quality=${d.estimated_quality?.toFixed(3) ?? "unknown"} routing_reason=${d.routing_reason}`;
        break;
      case "model_attempt":
        detail = `${d.modelRequested}: ${d.verification}`;
        break;
      case "planner_policy":
        detail = `complexity=${d.planner_complexity} strategy=${d.planner_strategy} reason=${d.reason}`;
        break;
      case "planner_route":
        detail = `model=${d.planner_model} phase=${d.phase} reason=${d.routing_reason}`;
        break;
      case "planner_summary":
        detail = `strategy=${d.planner_strategy} calls=${d.planner_model_calls} latency=${d.planner_latency_ms}ms cost=$${d.planner_cost ?? "unknown"} tokens=${d.planning_tokens} fallbacks=${d.planner_fallback_count}`;
        break;
      case "worker_scope":
        detail = `writes=${JSON.stringify(d.allowed_write_paths)} context=${JSON.stringify(d.context_files)}`;
        break;
      case "write_scope_violation":
        detail = `attempted=${JSON.stringify(d.attempted_write_paths)} allowed=${JSON.stringify(d.allowed_write_paths)}`;
        break;
      case "repo_profile":
        detail = `ecosystem=${d.ecosystem?.ecosystem} languages=${JSON.stringify(d.ecosystem?.languages)} frameworks=${JSON.stringify(d.ecosystem?.frameworks)} package_manager=${d.ecosystem?.packageManager?.name ?? "unresolved"} monorepo=${d.ecosystem?.monorepo}`;
        break;
      case "workspace":
        detail = `state=${d.state} backend=${d.backend} files=${d.baseline_files} bytes=${d.baseline_bytes} preexisting_modified=${d.preexisting_modified} preexisting_untracked=${d.preexisting_untracked}`;
        break;
      case "changes":
        detail = `modified=${d.modified} created=${d.created} deleted=${d.deleted}${d.paths.length ? ` ${d.paths.join(", ")}` : ""}`;
        break;
      case "apply":
        detail = `status=${d.status}${d.modified === undefined ? "" : ` modified=${d.modified} created=${d.created} deleted=${d.deleted}`}${d.conflicts?.length ? ` conflicts=${d.conflicts.join(", ")}` : ""}${d.error ? ` error=${d.error}` : ""}`;
        break;
      case "verification_plan":
        detail = d.candidates
          .map(
            (c: any) =>
              `${c.kind}=${c.command}${c.available ? "" : ` (unavailable: ${c.reason})`}`,
          )
          .join("; ");
        break;
      case "profile":
        detail = `${d.profile.files.length} files; checks: ${d.profile.verificationCommands.join(", ") || "none discovered"}`;
        break;
      case "dag":
        detail = d.plan.subtasks
          .map((t: any) => `${t.id} <- [${t.dependsOn.join(", ")}]: ${t.title}`)
          .join("\n  ");
        break;
      case "model_call":
        detail = `${d.modelRequested} → ${d.modelReturned}; $${d.costUsd ?? "unknown"}; ${d.promptTokens + d.completionTokens} tokens; ${d.wallClockMs}ms`;
        break;
      case "tool":
        detail = `${d.name} ${d.path ?? d.command ?? ""}`;
        break;
      case "tool_result":
        detail = String(d.result).replaceAll("\n", " ").slice(0, 180);
        break;
      case "verification":
      case "final_verification":
        detail = `${d.outcome ?? (d.unavailable ? "CHECK_UNAVAILABLE" : d.exitCode === 0 ? "CHECK_PASS" : "CHECK_FAIL")} ${d.command} (${d.wallClockMs}ms)${d.exitCode ? "\n" + (d.stderr || d.stdout).slice(-600) : ""}`;
        break;
      case "progress":
        detail = `${d.measurableProgress ? "improving" : `${d.noProgressCycles} cycles without measured progress`}; ${d.diffBytes} diff bytes`;
        break;
      case "escalation":
        detail = `${d.from} → ${d.to}`;
        break;
      default:
        detail = JSON.stringify(event);
    }
    console.log(`[${type}${label}] ${detail}`);
  }
}
