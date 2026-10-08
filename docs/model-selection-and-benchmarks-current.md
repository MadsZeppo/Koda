# Modelvalg og benchmarkbrug i Koda — aktuel implementering

Dokumenteret fra den lokale kode den 6. oktober 2026. Dette beskriver implementerede
mekanismer og deres begrænsninger, ikke en garanti for faktisk frontier-kvalitet.
Dokumentet beskriver ikke, hvilke lokale cachefiler en bestemt bruger har installeret.

## 1. Hvad bestemmer det faktiske modelvalg?

Normal kørsel styres af den eksisterende `PoolRouter`, planoptimering og den frosne
recovery-policy. **Routing V1 er shadow i produktion:** dens anbefalinger logges,
men bestemmer ikke den udførende model. Det dedikerede real-benchmark kan eksplicit
udføre en V1-anbefaling i sin egen proces. Det aktiverer ikke V1 for normal CLI-brug.

Der findes flere modelvalg i samme run: repository exploration, eventuel semantisk
fortolkning, planlægning, implementation, completion review og recovery. At coding
starter med en billig model betyder derfor ikke, at hele kørslen kun bruger den model.

Det centrale forløb er:

1. Indlæs config, modelpool, providertransport og budget.
2. Profilér repo, checks, sprog, frameworks og mulige implementeringsfiler.
3. Udled execution strategy, opgavefeatures, task fingerprint og localization.
4. Opdag modeller og frys et metadata-snapshot for kørslen.
5. Filtrér teknisk inkompatible kandidater.
6. Estimér kvalitet, usikkerhed, økonomi og latency for kandidater og komplette planer.
7. Sammenlign quality-safe planer og eventuelt execution engines inklusive deres forarbejde.
8. Frys første model og tilladte recovery-kandidater.
9. Kør implementation og deterministisk verification/completion review.
10. Vælg kun recovery, når de konkrete observationer og den frosne policy tillader det.
11. Registrér outcome, økonomi og failure attribution i de relevante historikker.

Kilder: `src/run.ts`, `src/router/modelRouter.ts`, `src/router/routeOptimizer.ts`,
`src/router/controlPolicy.ts` og `src/agent/codingExecutor.ts`.

## 2. Alle inputgrupper, som påvirker modelvalget

| Input                                | Hvordan det påvirker valget                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Brugerens task og constraints        | Opgavetype, eksplicit scope, ønsket ændring, nødvendige checks og risiko                                                             |
| Repo-profil                          | Sprog, frameworks, projektstruktur, package manager, mulige checks og dependencies                                                   |
| Localization                         | Kendte write/read paths, evidens, scopebredde og confidence; påvirker context og execution engine                                    |
| Task fingerprint/features            | Primary/secondary task types, task family, difficulty, forventet filantal, effort, cross-component, repo/terminal/architecture-behov |
| Visuelle krav                        | UI/design-, browser- og eventuelt visionbehov; compile-PASS beviser ikke synlig opfyldelse                                           |
| Execution strategy                   | Direct, planned, stable, Aider og relevante engine-varianter har forskellige token-, tool-, latency- og recoverykrav                 |
| Semantisk fortolkning, når aktiveret | Kan supplere complexity og frontier-justification; er ikke altid et ekstra modelkald                                                 |
| Modelpool/config                     | Enabled, tier, strengths, qualityPrior, latencyPriorMs og planner-specifikke priors                                                  |
| Provider metadata                    | Pris, availability, context, output-cap, supported parameters og endpoint co-support                                                 |
| Benchmark/knowledge evidence         | Taskrelevans, modelidentitet, aktualitet, sample count, målt kvalitet og usikkerhed                                                  |
| Lokal verificeret historik           | Successer og attribuerede coding failures på sammenlignelige opgaver                                                                 |
| Efficiency-historik                  | Faktiske turns, input/output/cache tokens, mutationstid, wall-clock og pris                                                          |
| Operational-historik                 | Providerfejl, timeout og protokolproblemer; påvirker gennemførlighed og økonomi, ikke coding-quality posterior                       |
| Run-/attempt-budget                  | Resterende USD, tokens, tid, iterations, outputreserve og provider context safety                                                    |
| Quality-policy                       | Required quality class, reference-model, permitted regret og verification strength                                                   |
| Recovery-evidens                     | Hvilke rescue-modeller der faktisk løser opgaver efter en konkret første models failure                                              |
| Parallelitet/races                   | Reserverede kandidater, race locks og uafhængige write scopes                                                                        |
| Overrides                            | `forceModel`, modellen fra en allerede valgt plan, deaktiverede kandidater og allerede forsøgte modeller                             |

Task Assessment V1 og Verification Contract V1 er frozen/shadow-systemer. De bruges
som kanoniske input i V1-observationen, men deres tilstedeværelse gør ikke automatisk
alle produktionsbeslutninger til V1-beslutninger. Produktion bruger også eksisterende
features/fingerprint og faktiske verifier-resultater.

## 3. Config og defaults

`src/config.ts` og `src/router/pool.ts` er autoritative for defaults; en lokal config
kan ændre værdierne.

| Felt                                  | Schema-default | Betydning                                                                               |
| ------------------------------------- | -------------: | --------------------------------------------------------------------------------------- |
| routing.minimumQuality                |            0.9 | Kvalitetsmål, bl.a. i den enklere ranker; ingen universel faktisk løsningssandsynlighed |
| routing.maxQualityRegret              |           0.02 | Tilladt modelleret kvalitetstab; den enkelte plan kan få strammere gate                 |
| routing.costWeight / latencyWeight    |    0.55 / 0.45 | Økonomisk prioritering blandt relevante planer                                          |
| routing.priorStrength                 |             10 | Styrke af den konfigurerede kvalitet/latency-prior                                      |
| routing.shortlistSize                 |              8 | Begrænser kandidat-/board-arbejde; V1 begrænser sin shortlist til 5–10                  |
| routing.cacheTtlMs                    |     21.600.000 | Metadata-cache: seks timer                                                              |
| routing.conditionalRecoveryMinSamples |              3 | Minimum for understøttet conditional recovery                                           |
| semanticRouter.enabled                |          false | Semantisk routing er ikke altid aktiv                                                   |
| planner.minimumQuality                |            0.9 | Separat planning-policy                                                                 |
| planner.costWeight / latencyWeight    |      0.4 / 0.6 | Planning har andre økonomiske vægte end coding                                          |

`adaptiveCoding` og `specialistRouting` har false i schemaet, men loaderen aktiverer
som udgangspunkt begge ved den bundled modelpool. Derfor er schema-default alene
ikke nok til at afgøre aktiv routing. `modelsFile`/modelpool, config og overrides
skal læses sammen. `forceModel` skal være en konfigureret kandidat og omgår dele af
normal model-/recoveryoptimering; det fjerner ikke verification-kravene.

## 4. Model discovery og teknisk kompatibilitet

`CapabilityRegistry` samler konfigurerede modeller, discovery/catalog og tilknyttede
benchmarkobservationer. Modeller skal ikke alene være kendte ved navn: de skal være
brugbare til den konkrete request/engine.

Filtre omfatter availability/enabled, kendt pris, input + output inden for context,
output-cap, nødvendige tools/protokolparametre, endpoint co-support og relevante
modalitykrav. Planning kan kræve struktureret output. Aider har andre protokolkrav
end en agentic tool-worker. I den enklere ranker er free- og batch-routes eksplicit
udelukket. Parametermetadata, som mangler, behandles ikke identisk i alle veje:
`supportsParameters` er permissiv ved ukendte modelparametre, mens V1 kræver mere
kritisk kapacitetsevidens. Man kan derfor ikke sige, at alle veje har samme hard gates.

Cold start kan hente pris/catalog; senere valg bruger normalt last-known-good cache.
Discovery-snapshot fryses, så samme run ikke skifter modelunivers undervejs.

## 5. Benchmarkdata, som påvirker produktion

### A. Discovery-benchmarks

Registry kan bruge cachede coding-, agentic-, reasoning-, terminal- og Design Arena
signaler. Artificial Analysis-data kan supplere disse, når integrationens server-
eller direkte udviklingscredentials og cache tillader det. Backend-mode skal ikke
kræve en lokal OpenRouter-key. Manglende data giver mindre evidens, ikke et benchmarkresultat.

For dynamisk opdagede modeller uden konfigureret pool-entry konstruerer registry en
cold-start qualityPrior: 0.5 uden relevante indeks; ellers
`0.78 + 0.18 * clamp(index / 100)` med eksisterende indeks-præference. Dette er en
intern scoringprior, ikke en empirisk Koda solve rate. Konfigurerede modeller beholder
som udgangspunkt deres konfigurerede prior. Indeks omregnes også til særskilte
capability/evidence-signaler.

### B. Routing Knowledge

`RoutingKnowledgeStore` læser `routing-knowledge-v2.json`, når et gyldigt snapshot
findes i routingens state directory; ellers bruges bundled `ROUTING_KNOWLEDGE_V1`.
Bundled data indeholder public seed-observationer og er ikke et bevis på en bestemt
provider-endpoints identitet. Identitet håndteres separat: EXACT og FAMILY_TRANSFER
har forskellig evidensværdi; navnelighed er ikke automatisk eksakt modelmatch.

`knowledge/estimator.ts` bruger task-specificity, identitetsniveau, freshness,
sample-support og usikkerhed. Efficiency-, provider-capability-, market- og
opgavedistributionsdata er ikke direkte succesobservationer i quality-estimatoren.

Den almindelige knowledge-estimator starter ved
`anchor = 0.70 + 0.25 * qualityPrior`, supplerer med vægtede result_at_1/success_rate-
signaler og små legacy benchmarkbidrag. Den beregner separat konservativ kvalitet
og usikkerhed. Valideret contextual knowledge kan erstatte dette med en
opgave-nabolagsestimator. RouteOptimizer kombinerer derefter med lokal historik.

Data kan klargøres/synkroniseres via de eksisterende CLI-subcommands:
`routing-prepare-coderouterbench`, `routing-prepare-coderouterbench-holdout`,
`routing-prepare-swe-rebench`, `routing-sync-evidence`, `routing-refresh-catalog`,
`routing-build-knowledge`, `routing-evidence-report` og `routing-validate-knowledge`.
At kommandoerne eksisterer beviser ikke, at et opdateret snapshot er installeret.
Holdout/probing-splits må ikke blandes til runtime-priors.

### C. Lokal outcome-historik

Success/failure-historik er task- og engineafhængig. RouteOptimizer vægter bl.a.
task family, primary, difficultyafstand, scope, sprog, engine og sammenlignelige
write paths. En succes på en anden fil/repo er svagere end konkret sammenlignelig
evidens. Ældre ufuldstændige rækker har svag transfer-vægt.

Økonomihistorik holdes særskilt fra kvalitet: en gammel agent-loop-overrun kan være
relevant for forventede tokens/latency uden at bevise, at modellen skriver dårlig kode.
Kun godkendt model-attribueret failure må bruges som negativ coding-quality evidence.
Providerfejl, 429, timeout, verifier-infrastruktur og ukendt årsag må ikke behandles
som målt negativ modelkvalitet.

## 6. Produktion: kvalitet først, derefter økonomi

Der er både en enklere ranker og en specialist-/planoptimering. Den enklere ranker
kombinerer konfigureret prior med sammenlignelige successer/failures, estimeret
requestpris og latency. Den kan vælge bedst tilgængelige kandidat under kvalitetsmålet
med en begrundelse; minimumQuality er ikke en universel hard rejection i alle veje.

Specialistoptimeringen modellerer komplette coding-planer: single-model og initial
model + rescue. Den beregner referencekvalitet, konservativ kvalitet, gap/regret,
first-attempt floor, conditional recovery, reserveret budget, forventet samlet pris,
turns og completion latency. Reference er bedste relevante eksekverbare kandidat,
ikke nødvendigvis den dyreste eller et hardcodet frontier-navn.

Et svagt første forsøg bliver ikke automatisk quality-safe, blot fordi en stærk
model findes til sidst. First-attempt gates, verification strength og rescue-evidens
har betydning. Parrede candidate/reference-opgaver kan give et mere direkte regret-
bevis. Få rescue-observationer giver konservativ backoff frem for sikker antagelse
om uafhængige successer.

Economics bruger current providerpriser og token/turn/cache/latency-estimater.
Cost per verified completion og komplet plan-latency er vigtigere end billigste
inputtoken. Joint routing medregner relevante planning-/forarbejdsomkostninger og
sammenligner engines. Ukendt latency bør ikke fremstilles som målt latency.

Der findes også en bounded zero-eligible fallback i produktion: når normal selection
ikke har en brugbar plan, kan kompatible, budgetmæssigt gennemførlige kandidater
bruges med tydelig fallback-begrundelse og fortsat verification/completion review.
Det er en driftsmekanisme, ikke empirisk bevis for at kvalitetsmålet er opnået.

## 7. Recovery og endpointvalg

Den valgte execution policy fryser initial model, approved candidate set, quality
cascade, operational recovery, reference, budget-/stopbetingelser og verification.
Coding quality recovery er begrænset af denne policy. Operational recovery prioriterer
relevante godkendte alternativer ud fra rækkefølge, pris, operational error rate og
latency. No-mutation/token/context recovery kan vægte token-efficiency særligt.

Et execution-mode/context problem er ikke automatisk grund til en større model:
bounded agentic fallback på samme model kan være relevant. Verification infrastructure
failure må ikke starte coding repair, som om en konkret requirement var forkert.

Valg af model og valg af provider-endpoint er forskellige. OpenRouter-policy kan
sortere kompatible endpoints efter pris, kræve parametre og sætte max_price; affinity
/session og fallback-policy påvirker faktisk served model/provider. Backend/direct-
openrouter bestemmer transport og credentials, ikke i sig selv opgavens kvalitetskrav.
Logs skelner mellem `modelRequested` og `modelReturned`/served model. Det faktisk
brugte endpoint er ikke altid identisk med et enkelt navn i en routinganbefaling.

## 8. Routing V1 shadow: separat evidens og policy

V1 læser `routing-v1-priors.json` og `routing-v1-evidence.jsonl`, separat fra
produktionshistorikken. Evidenshierarkiet er global → model family → model/task →
model/task/complexity → lokal outcome. Niveauer tælles disjunkt; brede ancestors
begrænses; external observations får 0.1 vægt og et yderligere cap. Synthetic rows
ignoreres i normal kørsel.

V1 bruger Beta(1,1) som ignorance-regularizer og en konservativ mean-minus-1.64σ-
approximation. Det er ikke en garanteret eller allerede kalibreret confidence bound.
En credible reference kræver mindst tre effektive model/category-observationer og
tre samlede effektive observationer. Uden troværdig evidens kan V1 abstain:
`selected=null`. Den eksisterende configured qualityPrior er ikke nok som empirisk V1-evidens.

V1 bevarer kvalitet som gate før cost/latency. Let, bounded, low-risk arbejde med
stærk requirement-level proof kan tillade exploration; ellers gælder strammere
kvalitets-/regretkrav. V1 neutraliserer legacy tier-tags i en isoleret kopi, ikke i
produktion. Conditional rescue kræver parrede outcomes; ellers bruges konservativ
backoff. Shadow-logging og learning erstatter ikke produktionsselection.

## 9. Hvilke benchmarkkørsler træner routeren faktisk?

| Benchmarktype                           | Effekt nu                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Public benchmark/knowledge-snapshot     | Kan påvirke produktionspriors, capability og economics, når data er indlæst og matcher                       |
| Normal rigtig Koda-run                  | Kan skrive lokal produktionsevidens og separat V1 shadow-evidens efter attribution-regler                    |
| Synthetic/fake provider suite           | Regressionstest; må ikke skabe reel model-quality/performance evidence                                       |
| Synthetic V1 development/holdout matrix | Offline policytest; må ikke installeres som empirisk V1-priors                                               |
| Eksisterende live coding suites         | Måler rigtige runs på deres scenarios; ingen automatisk garanti for korrekt import i V1 knowledge            |
| `realBenchmark.ts`                      | Isolerede rigtige agentkørsler og sammenligningsrapporter; skriver ikke automatisk fælles produktionshistory |
| Claude/Codex baseline-resultater        | Uafhængig sammenligning; automatisk baseline-sejr eller import som produktionsprior er ikke implementeret    |

Real-harnesset kræver et kurateret manifest med fastlåste commit-SHA'er, uafhængige
acceptance validators og frosne ikke-syntetiske priors. Disse inputs er ikke blevet
leveret som et færdigt 30–50-task datasæt i denne implementering. En placeholdersti
eller et synthetic dataset er derfor ikke en køreklar real benchmark.

Med `--claude-models` køres Routing V1, Current Koda og separate Claude-aliasser;
uden dette flag bevares det oprindelige udvalg med V1/Codex/strongest/cheapest.
Alle får samme task og scope i uafhængige, rene kloner. V1's benchmark-only override
kan abstain og kan kun udføre kandidater i den brugbare frosne pool; det må ikke
maskeres som en faktisk V1-succes ved at erstatte planen med production routing.

Output indeholder status, ground truth, false accepts, modeller, tokens, pris,
wall-clock og relevante attribution-artifacts. JSON/Markdown sammenligner solve rate,
cost/time per solve og kategorier. Codex subscription charges er ikke kendte;
API-equivalent estimate er adskilt fra Claude API-billing. Budget og eksplicit CLI
kræves. Frosne holdout-resultater må ikke bruges som træningsdata til samme evaluering.

## 10. Hvorfor kan en lille opgave stadig vælge en stor model?

Mulige mekanismer i den aktuelle kode:

- Opgaven er profileret bredt eller localization/evidens er svag.
- Billige modeller har inkompatibel protokol, context/output-cap eller availability.
- Konfigureret prior, knowledge eller lokal historik understøtter ikke billig kandidat.
- Krævet kvalitet, first-attempt floor eller regret afviser billig første model.
- Svag verification gør cheap-first + rescue mindre sikker.
- Estimerede turns/retries gør den billige model dyrere pr. faktisk løsning.
- Tier-/frontier-justification og engine-strategi begrænser kandidater i produktion.
- Recovery følger en allerede frossen board/cascade frem for frit at vælge billigst.
- Et andet stage, eksempelvis review, bruger en stærkere model end coding-worker.
- Metadata/historik/snapshot er mangelfuld, gammel eller matcher kun modellen svagt.

Det konkrete svar skal findes i den pågældende runs candidate- og planrejections,
ikke udledes alene af promptens længde eller et benchmarkscore.

## 11. Hvad skal man læse i logs og på disken?

`execution_route`, joint-route events, candidate reasons, `quality_safe`,
`rejection_reason`/hard rejection, reference, conservative quality, allowed regret,
expected total cost, latency quantiles og `zero_eligible_model_fallback` beskriver
produktionsvalget. `model_call` viser faktisk request/served model, stage og usage.
`model_attempt`, recovery-events, verifier og completion review forklarer næste valg.

`routing_v1_shadow_decision`, `routing_v1_shadow_joint_decision` og
`routing_v1_learning` beskriver V1-observationen. De er ikke bevis på V1-dispatch.
`real_benchmark_route` markerer den særskilte benchmark-policy.

State directory kommer fra config eller en baseUrl-afledt mappe under
`~/.koda/model-router/`. `History`, registry/catalog-cache, knowledge-store og V1-ledger
har forskellige formål. Kig på de faktiske filer og provenance frem for blot at
antage, at et benchmarknavn i dokumentationen betyder installeret træningsdata.

## 12. Kodekort

- Config/modelpool: `src/config.ts`, `src/router/pool.ts`, `koda.models.json`.
- Opgaveforståelse: `src/router/features.ts`, `taskFingerprint.ts`, `taskProfiler.ts`,
  `taskInterpreter.ts`, `taskAssessment.ts`, `src/agent/handoffPlanner.ts`.
- Discovery/metadata: `src/router/capabilityRegistry.ts`, `src/openrouter/catalog.ts`.
- Produktion: `src/router/modelRouter.ts`, `routeOptimizer.ts`, `controlPolicy.ts`.
- Kvalitet/økonomi-data: `src/router/history.ts`, `src/router/knowledge/` især
  `store.ts`, `estimator.ts`, `contextual.ts`, `identity.ts`, `efficiency.ts` og `ingest.ts`.
- V1 shadow: `src/router/routingV1.ts`, `routingV1History.ts`, `routingV1Evaluation.ts`.
- Orchestration/recovery: `src/run.ts`, `src/agent/codingExecutor.ts`, `attemptPolicy.ts`.
- Verification/attribution: `src/verifier/`, `src/agent/failureAttributionRuntime.ts`.
- Transport/endpoint: `src/provider/transport.ts`, `src/openrouter/client.ts`.
- Evaluering: `src/dev/routingV1Eval.ts`, `routingV1Collect.ts`, `realBenchmark.ts`,
  `realBenchmarkWorker.ts`, `claudeBenchmark.ts`, `codexComparison.ts`.

Den aktuelle router kombinerer håndkonfigurerede priors, public transfer-evidence,
lokal verificeret historik og plan-estimater. Den er endnu ikke en dokumenteret,
automatisk kalibreret modelvælger, der har bevist frontier-paritet og besparelser på
et færdigt real holdout-benchmark.
