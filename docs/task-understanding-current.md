# Task understanding i Koda — nuværende implementation

Status: den lokale kode læst 5. oktober 2026. Dette er en beskrivelse af den eksisterende pipeline, inklusive begrænsninger. Det er ikke et forslag til en ny arkitektur.

## 1. Hvad betyder task understanding i Koda?

Koda har ikke én model, der først producerer en komplet, autoritativ forståelse af opgaven. Forståelsen bygges i flere lag:

1. Brugerprompten omformes til en bounded TaskSpec.
2. Repository profileres, og en foreløbig execution-strategi vælges.
3. Localization finder relevante implementation-filer og evidens.
4. Et deterministisk task profile kombineres med baseline checks og eventuelt en semantisk modelvurdering.
5. Routeren får et fingerprint med scope, kompleksitet, risiko og verificerbarhed.
6. Ved planned execution produceres subtasks og afhængigheder.
7. Coding-worker får prompt, scope og bounded kontekst.
8. Completion review vurderer det faktiske resultat mod kravene; deterministisk verification vurderer checks/regressioner.

Disse repræsentationer er beslægtede, men ikke identiske. TaskSpec, task profile, fingerprint og completion checklist har forskellige parsere og forskellige formål.

## 2. Desktop-chatten og CLI-input

CLI modtager opgaven gennem `--task`. Desktop-appens `startDesktopRun` sender tekstfeltet som ét argument til samme CLI uden shell-evaluering.

**Desktop-historik er ikke samtalekontekst.** Tidligere beskeder gemmes lokalt, men sendes ikke automatisk til modellen. Hver klik på Kør opgave er en selvstændig opgave. Formuleringer som “gør den ligesom før” har derfor ikke nødvendigvis den tidligere chatbesked som kontekst; repository-filerne er den tilgængelige aktuelle tilstand.

Kilder: `src/cli.ts`, `src/desktop/runner.ts`, `desktop/renderer.js`.

## 3. Første repræsentation: TaskSpec

`run` gemmer originalprompten i `originalTask`, kalder `compileTaskSpec` og skriver resultatet til `task-spec.json` i run-outputtet. Derefter bliver `options.task` erstattet med TaskSpecens `routingPrompt`.

TaskSpec indeholder:

| Felt | Nuværende betydning |
|---|---|
| `original` | Hele originalprompten |
| `hash` | SHA-256 af originalprompten |
| `goal` | Første udledte clause |
| `requirements` | Unikke clauses fra prompten |
| `constraints` | Clauses med bl.a. must/never/preserve/only/without/unchanged/do not |
| `acceptanceCriteria` | Clauses med bl.a. verify/test/check/pass/cover/ensure |
| `exactLiterals` | Indhold mellem backticks, dobbelte eller enkelte citationstegn |
| `explicitPaths` | Tekst, der matcher en path med slash og filendelse |
| `parts` | Requirement-grupper inden for byte-grænsen |
| `routingPrompt` | Den enkelte gruppe, eller første gruppe med besked om afhængig decomposition |

Dette er **regelbaseret extraction**, ikke en LLM-genereret opsummering. Der sker ikke en generel semantisk omskrivning af lange prompts til et kort, ækvivalent mål.

### Opdeling og grænser

TaskSpec opdeles ved newline eller `.`, `!`, `?` efterfulgt af whitespace uden for de understøttede quotes. Identiske clauses deduplikeres. En gruppe må højst fylde **6000 UTF-8 bytes** (`MAX_TASK_SPEC_BYTES`).

Hvis én udelelig clause overstiger grænsen, kastes `task_spec_requires_decomposition`; den bliver ikke bare trunkeret. Flere grupper kræver planned decomposition. Originalen bevares, men de tidlige routing/localization-trin modtager ikke nødvendigvis alle grupper samtidig.

### Kendte begrænsninger

- `goal` er første clause, ikke nødvendigvis en korrekt sammenfatning af hele opgaven.
- Constraints/acceptance-extraction bruger hovedsageligt engelske ord.
- Punktummer i uquoted navne kan blive opfattet som sætningsgrænser. “fra sample. til newname” kan derfor blive opdelt i to requirements, selvom det er én navneændring.
- TaskSpecens path-regex og execution-strategiens `explicitTaskPaths` er separate mekanismer.
- Quotes og præcise paths hjælper parsningen, men er ikke nødvendige for alle understøttede opgaver.

Kilder: `src/planner/taskSpec.ts`, `src/context/packetPolicy.ts`, `src/run.ts`.

## 4. Repository-fakta og første strategivalg

Repository profiling etablerer bl.a. filoversigt, sprog, frameworks, package manager, projektstruktur og verification commands.

`chooseExecutionStrategy` vurderer prompten sammen med disse fakta og udleder:

- `execution_strategy`: direct, stable eller planned.
- `execution_effort`: tiny, normal eller complex.
- `likelyFiles`: hints om relevante filer.
- `preciseTarget`: en mere konkret target, når den kan etableres.
- Begrundelse for strategien.

Eksplicitte file paths, konkrete tekstændringer, uafhængige workstreams, dependencies og brede ændringer påvirker valget. Det er en heuristisk vurdering, som kan justeres efter localization og joint routing.

**Lexical hints er ikke automatisk skriveautorisation.** En fil kan matche opgavens ord uden at eje den ønskede ændring.

Kilder: `src/repo/profiler.ts`, `src/router/executionStrategy.ts`.

## 5. Localization: hvor skal arbejdet faktisk ske?

Den aktuelle rækkefølge i `run.ts` er:

1. `fastPathExploration` for tilstrækkeligt konkret scope.
2. `boundedTextEditExploration` for afgrænsede tekstændringer.
3. Deterministisk repository exploration, inklusive framework-baserede creation targets, hvis evidensen er tilstrækkelig.
4. Modelbaseret OpenHands exploration, når de lokale metoder ikke kan etablere scope.

Exploration returnerer et struktureret resultat med confidence, editable candidates, readonly-filer, related tests, dependencies, evidens og unresolved questions.

Et provider-/exploration-problem kan føre til en degraded root-discovery-path frem for at stoppe hele opgaven før coding. Det er ikke bevis for, at en model er dårlig til at kode.

### Små tekstændringer

`explicitLiteralReplacement` genkender bestemte old/new-formuleringer, fx replace X with Y og ændr/ændrer … fra X til Y. `explicitDesiredLiteral` håndterer bl.a. ønsket quoted tekst efter to/til. Det er afgrænset parsing, ikke generel dansk/engelsk sprogforståelse.

`boundedTextEditExploration` kræver en simpel tekstændring, relevante literals og faktisk læst file content. Eksplicitte fil-/directory-restriktioner får denne genvej til at afstå, så den almindelige scope-path kan håndtere restriktionen.

For homepage-copy undersøges få entry-filer. For header-copy findes header/nav/layout-kandidater og relevante UI-imports. Den seneste implementation følger også path aliases, som er erklæret i repositoryets `tsconfig.json`/`jsconfig.json`.

Header-pathen går højst to importniveauer ned. Læsning er bounded: højst 12 besøgte UI-filer, højst 32.000 bytes pr. fil og 48.000 bytes samlet UI-indhold. Alias-config må højst være 16.000 bytes og parses aktuelt med `JSON.parse`; config med kommentarer eller aliases fra en arvet config kan derfor kræve den almindelige discovery-path.

Der skal være én entydig teksttarget. Flere targets, for stor kontekst eller manglende evidens giver fallback, ikke et gættet sikkert scope. Et ens tekstmatch i en favicon-fil beviser ikke, at den ejer headeren; den afgrænsede header-path følger headerens UI-imports.

**Begrænsning:** importgraf og source-content er stadig ikke en fuld browser-rendering eller semantisk reachability-analyse. Uafklaret scope skal håndteres videre af agenten.

Kilder: `src/agent/openHandsExplorer.ts`, `src/agent/literalEdit.ts`, `src/context/compiler.ts`.

## 6. Deterministisk task profile

`profileTask` udfører ingen I/O og ingen modelkald. Den bruger allerede kendte repository-fakta, prompten og strategien.

Den laver en lexical rangering af højst 1500 paths med op til 12 discovery hints. Word extraction er primært ASCII/engelsk. `likelyPaths` dannes fra eksplicitte paths og grounded strategy-targets; lexical discovery alene er ikke implementation ownership.

Profilet indeholder bl.a.:

- Task family, sprog, frameworks og repo scale.
- Discovery candidates, likely paths/tests/components og project roots.
- Cross-component, API/schema/concurrency/architecture/security-risk.
- Localization entropy, expected blast radius og scope/decomposition confidence.
- Verification strength og en evidensliste.
- Et stabilt `profileKey` baseret på udvalgte repository-/scope-/risk-fakta.

Small/medium/large repo scale er aktuelt under 40 / under 500 / mindst 500 filer.

Risikovurdering bruger både vocabulary og nogle konkrete repository-boundaries. Den er ikke en matematisk garanti: regex-matches og forskellige profileringslag kan stadig klassificere samme opgave forskelligt.

## 7. Baseline og kanonisk evidens

Efter localization kan Koda køre routing baseline-preflight. I bestemte paths kan baseline udskydes til en kandidatfejl kræver sammenligning.

I `run.ts` bliver task profilets verificationStrength sat til **strong**, hvis der findes observerede CHECK_PASS/CHECK_FAIL-resultater fra routing-baseline. Det kan fx være lint. Dette er routing-evidens; det betyder ikke, at lint beviser brugerens ønskede implementering.

Senere fingerprint-felter skelner bl.a. mellem targeted executable verification og bred project verification. Derfor skal et enkelt “strong”-label ikke læses som en garanti for task-specifik testdækning.

Exploration-evidens flettes ind i det kanoniske profile. Editable candidates bliver likelyPaths; related tests og readonly-filer bliver separate kategorier.

Kilder: `src/run.ts`, `src/router/taskProfiler.ts`, `src/router/taskFingerprint.ts`.

## 8. Valgfri semantisk forståelse

`interpretTask` er et separat valgfrit trin, styret af `semanticRouter.enabled`. Schema-default er **false**. Ved force-model bruges det ikke. Den faktiske konfiguration kan aktivere det.

Det bruger en structured decision-path med spørgsmål om:

- Semantic difficulty: easy/normal/hard/frontier.
- Repo reasoning og localization difficulty.
- Verification strength og consequence risk.
- Expected change size.
- Starting tier og frontier justification.
- Confidence og reason.

Input er bounded task/repository-profile/baseline-state, ikke hele repoet. Resultatet valideres. Frontier start kræver explicit justification i schemaet og en konfigureret probability threshold i decision-fortolkningen.

Budget-, protocol- og providerproblemer giver fallback uden semantisk assessment. Repository-fakta forbliver autoritative. Den semantiske vurdering er rådgivning til routing, ikke en færdig plan, write-autorisation eller accept af implementeringen.

Kilder: `src/router/taskInterpreter.ts`, `src/config.ts`.

## 9. TaskResume og coding-fingerprint

`buildTaskResume` samler profile, relevant paths og evidens. I den aktuelle top-level `run.ts`-path sættes research-budgettet for denne resume-bygning til nul, og exploration-resultatet indsættes som scout-evidens. Det betyder ikke, at der er en ekstra micro-scout-modelrunde her.

`taskFingerprint` omsætter subtask/objective, profile, features, effort og baseline til routing-dimensioner: type, scope, kompleksitet, risiko, localization, forventet blast radius, verification/recovery-detectability mv.

`preserveCanonicalTaskEvidence` bevarer relevante kanoniske fakta under vurdering af alternative execution-strategier og coding-subtasks. Routing mellem modeller er beskrevet separat i [model-routing-current.md](model-routing-current.md).

## 10. Fra forståelse til plan og handoff

Direct/stable kan gå videre som ét workstream. Planned execution bruger `compileTask` og planning policy til en DAG med objectives, acceptance criteria, read/write paths, dependencies, integration contracts og verification commands.

Den almindelige model-planner bliver bedt om højst fire subtasks. Bounded decomposition af flere TaskSpec-grupper/stort lokaliseret scope har en separat deterministisk path og kan producere flere afhængige jobs. Den er ikke et generelt bevis for en optimal opdeling.

Planning skal valideres og reconciles mod repository/scope-evidens. Parallel workers må ikke have overlappende mutation ownership.

Handoff vælger coding-mode og konkret writable/context-packet. Related tests er normalt kontekst/verification og bliver ikke alene af deres relation automatisk editable. User write restrictions og runtime WriteScope er execution-grænser; et modeludsagn om en relevant fil er ikke i sig selv tilladelse til at skrive den.

Agentic discovery skal føre til faktisk læsning før implementation; Aider får komplette editable-filer, når packet passer, ellers kan bounded Agentic reads bruges. Hele repository må ikke sendes ukritisk med.

Kilder: `src/planner/taskCompiler.ts`, `src/planner/policy.ts`, `src/agent/handoffPlanner.ts`, `src/agent/agenticCodingWorker.ts`, `src/repo/writeScope.ts`.

## 11. Krav-checklist og completion review

`taskRequirementChecklist` laver en ny liste med stabile lokale IDs R1, R2 osv. fra task, subtask objective, integration contract og acceptance criteria.

Den splitter på newline og visse sætningsgrænser, normaliserer bullets, deduplikerer og fjerner rene verification-instruktioner fra implementation-review. Lint/build/typecheck/test-krav skal stadig håndhæves af deterministisk verification.

Denne parser er **ikke identisk med TaskSpec-parseren**. Et punktum i et navn eller en planner-omskrivning kan derfor påvirke requirement-opdelingen forskelligt.

Review vurderer diff, ændrede paths, bounded repository-evidens og relevante checks. En snæver mekanisk ændring kan have deterministisk completion-proof, men ikke alle små ændringer kvalificerer sig. Den nylige navneændring brugte model-review, selvom selve ændringen var lille.

Malformed model-review giver én structured retry. Fortsat protocol/infrastructure failure er ikke bevis for manglende requirements og må ikke alene starte coding repair. Repair kræver konkret evidens om manglende implementation. Et typecheck-PASS er ikke i sig selv bevis for, at opgaven allerede var løst.

For UI findes visse CSS-cascade-kontroller, men source checks og model-review er ikke en universel objektiv designvurdering eller automatisk garanti for et browser-screenshot, der ser godt ud.

Kilder: `src/agent/completionReview.ts`, `src/agent/codingExecutor.ts`, `src/run.ts`.

## 12. Hvad kan task understanding stadig fejle på?

- En uklar prompt kan give et uklart mål; der er ikke en universel clarification-dialog før coding.
- Dansk og engelsk har forskellig dækning i de forskellige regex-parsere.
- Gamle chatbeskeder fra desktop er ikke automatisk task-kontekst.
- Literal-/path-match kan være discovery hints uden korrekt implementation ownership.
- Broad scope, constraints og complexity kan blive blandet sammen af vocabulary-regler.
- De forskellige task-repræsentationer kan få forskellige families/strengths/requirement-grænser.
- En eksisterende side med en heading kan teknisk opfylde en snæver formulering, uden at være en komplet, gennemarbejdet produktside. Review måler de udledte krav; det kan ikke garantere alle brugerens uudtalte forventninger.
- En forstået opgave kan stadig fejle på provider, runtime, budget eller verification environment. Det er ikke nødvendigvis et forståelsesproblem.

## 13. Sådan debugges en konkret forståelse

Læs disse artefakter/events:

| Artefakt/event | Hvad det viser |
|---|---|
| `task-spec.json` | Original, clauses, constraints, literals, paths og grupper |
| `repo_scope_selected` | Editable, readonly og related tests |
| `repo_exploration_finish` | Lokal/model discovery og indsamlet scope |
| `execution_strategy` | Valgt strategy/effort og begrundelse |
| `task_profile` | Kanonisk profile og repository-evidens |
| `semantic_router_*` | Valgfri semantic decision/fallback |
| `task_fingerprint` | Coding-routerens konkrete vurdering |
| `task_requirement_checklist` | Kravene completion review skal vurdere |
| `coding_handoff` / `worker_scope` | Faktisk worker-kontekst og skrivegrænser |
| `completion_review` | Hvilken evidens der accepterer/afviser hvert krav |
| `summary.json` | Final status, ændrede filer og apply-status |

Der skal skelnes mellem **forstået**, **implementeret**, **verificeret** og **anvendt**. En god profile-score er ikke VERIFIED_SUCCESS. Et candidate-resultat er ikke nødvendigvis skrevet tilbage til brugerens repo; apply-status skal kontrolleres separat.
