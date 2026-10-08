# VNext cold-start evidence: clamp shadow replay

Production routing and VNext selection thresholds are unchanged. No provider requests or paid calibration were run.

## Root cause

The runtime read `~/.koda/routing-quality/contextual-quality-v1.json`: 24 KB, 39,848 fit observations, eight historical model names, unknown execution engines, no semantic examples, no paired outcomes. The newer frozen artifact under `vnext-final/` was never loaded by this runtime path. It contains 42,668 fit observations, 14 historical model identities, 2,820 text-derived examples and 1,768 paired task outcomes. Additionally, the predictor explicitly reported support=0 for every cross-harness/version/family transfer even when real outcomes were present.

## Evidence path

`publicRoutingEvidence.ts` / canonical ingestion → admissible fit rows → `contextualMilestoneEval.ts` → `freezeColdStartArtifact()` → packaged `contextual-cold-start-v1.json.gz` → `contextualShadowDecision()` → `ContextualRouterVNext.decide()` → `predictContextualQuality()`.

The packaged artifact is approximately 409 KB compressed. Source artifacts are validated and compacted offline; runtime reads no raw public benchmark files and makes no network requests. A fresh installation can use this packaged artifact without a local user-history directory. The existing coarse local artifact falls back to the richer packaged artifact. Native cells in local frozen artifacts are preserved.

The existing offline artifact builder accepts `--cold-start-output /path/to/contextual-cold-start-v1.json.gz`, with optional `--native-ledger`. It uses the same admissibility and disjoint FIT/calibration/development partitions. No new benchmark harness was added.

## Prediction hierarchy and safety

Same model + relevant native Koda task/engine/harness evidence takes priority. Otherwise, same-model source evidence and relevant normalized task-family buckets are used, with text-derived nearest-task retrieval when available. Explicit version mappings are retained; family transfer and global public priors are separately labeled. Paired outcomes stay in their source harness and are not counted as extra independent successes. Neighbor support is deduplicated by task; aggregate family support assumes maximal overlap between model outcomes when task IDs are unavailable.

Source provenance, public/native counts, effective support and source-domain Wilson bounds are logged separately from transfer calibration. Cross-harness/version/family/global estimates retain [0,1] Koda uncertainty and calibratedDomain=false unless transfer has actually been established. Public support does not imply measured current-model Koda success. Selection thresholds and false-accept gates are unchanged.

No admissible native support for the current candidate identities was present in the loaded artifacts. The earlier Gemini 2.5 native smoke has oracle success but an empty servedModels receipt list; the existing strict native adapter therefore did not publish a revision-proven canonical observation. This fix does not manufacture that identity proof.

## Exact replay

Input: the original Danish clamp prompt, original task assessment/verification contract/fingerprint, original ten candidate model capabilities and prices, input reserve 370 tokens, output reserve 4,096 tokens, budget $0.50. Both an empty user directory and the existing installation were checked.

Result: **ABSTAIN**, `no_supported_compatible_candidate`. Every candidate now has public source support; all still lack calibrated current-model-to-Koda transfer.

| Candidate                         | Effective support | Nearest tasks | Native | Public observations used | Predicted source success | Source interval | Evidence tier   |
| --------------------------------- | ----------------: | ------------: | -----: | -----------------------: | -----------------------: | --------------- | --------------- |
| qwen/qwen3-coder-30b-a3b-instruct |            538.00 |             0 |      0 |                     1076 |                    0.060 | [0.042, 0.082]  | family_transfer |
| qwen/qwen3-coder-next             |            538.00 |             0 |      0 |                     1076 |                    0.060 | [0.042, 0.082]  | family_transfer |
| z-ai/glm-5.3-flash                |            538.00 |             0 |      0 |                      538 |                    0.172 | [0.142, 0.205]  | family_transfer |
| deepseek/deepseek-v4.1-flash      |             23.63 |            32 |      0 |                       32 |                    0.704 | [0.519, 0.860]  | global_prior    |
| openai/gpt-5.6-luna               |             23.63 |            32 |      0 |                       32 |                    0.780 | [0.607, 0.916]  | family_transfer |
| google/gemini-3.8-flash           |             23.63 |            32 |      0 |                       32 |                    0.704 | [0.519, 0.860]  | global_prior    |
| z-ai/glm-5.3                      |            538.00 |             0 |      0 |                      538 |                    0.172 | [0.142, 0.205]  | family_transfer |
| anthropic/claude-sonnet-5         |            538.00 |             0 |      0 |                      538 |                    0.183 | [0.152, 0.217]  | family_transfer |
| openai/gpt-5.6-sol                |             23.63 |            32 |      0 |                       32 |                    0.780 | [0.607, 0.916]  | family_transfer |
| anthropic/claude-opus-5           |            538.00 |             0 |      0 |                      538 |                    0.272 | [0.236, 0.310]  | family_transfer |

Qwen/GLM/Claude family buckets use `coderouterbench-id:huggingface-main`. GPT family retrieval uses the existing OpenHands GPT-5 SWE-bench submission. Global priors use the existing SWE-bench public submissions collectively. Exact current Luna/Sol/GLM revision outcomes were not invented.

Koda-transfer uncertainty is [0,1] for every candidate. Source intervals above are uncertainty in source outcomes, not a calibrated probability of Koda completing this task.

Machine-readable replay: `/tmp/koda-clamp-vnext-cold-start.json`. Initial unloaded measurements were about 61–68 ms cold and 5 ms cached. Measurements while the full suite runs are affected by CPU contention.

## Verification

Typecheck passed. Focused cold-start, contextual routing, milestone and authority tests: 56/56 passed. Full `pnpm test`: 1,079 tests, 1,077 passed, one skipped, one failed. The sole failure is the pre-existing planner concurrency assertion (`maxConcurrentCodingWorkers >= 2`) under full-suite load; its isolated rerun passed (1/1). No unrelated planner changes were made.

Latest isolated replay: 66.0 ms cold; 5.7 ms cached.
