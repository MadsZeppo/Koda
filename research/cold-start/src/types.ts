import { createHash } from 'node:crypto';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type Mode = 'task-holdout' | 'model-holdout' | 'ood';
export interface Task { taskId: string; taskText: string | null; taskSplit: 'probing' | 'id_test' | 'ood'; taskDimension: string | null; taskMetadata: Record<string, unknown> }
/** Deliberately excludes IDs, splits and arbitrary metadata from predictive features. */
export interface PreexecutionTask { text: string | null; dimension: string | null }
export interface Outcome extends Task {
  dataset: string; harness: string; sourceFile: string; sourceRevisionOrFingerprint: string;
  modelId: string; modelRevision: string | null; modelMetadata: Record<string, unknown>;
  outcome: number; costUsd: number | null; latencyMs: number | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  rawRecordReference: string;
}
export interface Dataset { tasks: Task[]; models: string[]; outcomes: Outcome[]; summary: Record<string, unknown>; fingerprint: Record<string, unknown> }
export interface Options { mode: Mode; seed: number; limit?: number; taskHoldout?: number; holdoutModel?: string; models?: string[]; k: number; minimumNeighbors: number; metric: 'cosine' | 'jaccard'; features: 'text' | 'dimension' | 'text-dimension' }
export interface Decision { model: string | null; estimates: Record<string, number | null>; neighbors: { taskId: string; similarity: number }[]; reason: string }
export interface Prediction extends Decision { router: string; taskId: string }
export const preexecution = (task: Task): PreexecutionTask => ({ text: task.taskText, dimension: task.taskDimension });
export const stableCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
