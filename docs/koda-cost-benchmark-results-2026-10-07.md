# Koda: målte prissammenligninger

Dato: 7. oktober 2026. Priser i USD. Rapporten samler de tilgængelige Koda-vs-Codex, Auto-vs-frontier og Koda-vs-Claude sammenligninger fra denne session; den er ikke en opgørelse over alle tidligere smoke-, calibration- eller regressionstests. Ingen nye modelkald blev lavet for at skrive rapporten.

## Hovedresultater

- Auto vs fast frontier: 5/5 bestået hos begge; **94,6% lavere samlet providerpris**.
- Koda vs Claude Code Sonnet 5.5, fem opgaver: se de faktiske genkontroller nedenfor. Alle priser medregner de loggede kald, inklusive Koda review/recovery.
- Codex med ChatGPT-abonnement: faktisk dollarpris pr. opgave er ukendt. Ingen dollarbesparelse mod abonnementet kan beregnes.
- Tid er opført for gennemsigtighed; pris og bestået adfærd er hovedmålene.

## Auto vs fast frontier — fem opgaver

| Arm | Bestået | Samlet pris | Pris/bestået | Samlet tid |
|---|---:|---:|---:|---:|
| auto | 5/5 | $0.002667 | $0.000533 | 108.9s |
| frontier | 5/5 | $0.049204 | $0.009841 | 92.2s |

Opgaver: clamp, chunk, median, pagination og safe-json. Frontier-kodning var fast `openai/gpt-5.6-sol` gennem samme Koda-pipeline. Auto valgte kompatible modeller; begge beholdt samme reviewer-konfiguration. De oprindelige Auto-prisfelter stod som unknown; rapporten er genberegnet med afstemte Agentic v1-pris- og tokenreceipts.

Rapport: `/tmp/koda-auto-frontier-1791376839/comparison.json`.

## Koda vs Claude Code — fem opgaver

| Opgave | Claude check | Koda check | Claude pris | Koda pris | Besparelse |
|---|---|---|---:|---:|---:|
| clamp | PASS | PASS | $0.006775 | $0.000418 | 93.8% |
| median | PASS | PASS | $0.009628 | $0.000485 | 95.0% |
| chunk | PASS | PASS | $0.009536 | $0.000554 | 94.2% |
| group | PASS | PASS | $0.014029 | $0.000709 | 94.9% |
| query | PASS | PASS | $0.016293 | $0.001083 | 93.4% |

**Samlet: Claude $0.056262; Koda $0.003249; 94.2% lavere pris. Bestået: Claude 5/5, Koda 5/5.**

Besparelsen er en vægtet sammenligning af samlet pris, ikke et gennemsnit af procenttal. Priser inkluderer den oprindelige kørsel med ødelagte checks; gratis rechecks tilføjer ingen API-pris.

Claude rapporterede `claude-sonnet-5-5`. Koda brugte Auto-routing. Ingen frontier-paritet udledes af fem utility-opgaver.

Group og query havde syntaksfejl i de kopierede eksterne checkfiler. De blev gendannet til de oprindeligt specificerede assertions og kørt igen på begge eksisterende løsninger. Originale comparison.json-filer viser stadig FAIL for disse opgaver; de nye resultater står i `/tmp/koda-five-claude.jDEbJu/independent-recheck.json`. Krav eller forventede outputs blev ikke svækket.

## Enkeltopgave mod Claude

Positive-integer: Claude $0.010828; Koda $0.000400; **96.3% lavere pris**.

Det oprindelige check indeholdt `for(constof ...)` og fejlede syntaktisk hos begge. Brugeren genkørte det oprindeligt tilsigtede, korrekte check og rapporterede PASS hos begge. Ingen ekstra modelkald.

## Sammenligninger mod Codex-abonnement

| Kørsel | Codex check | Koda check | Koda pris | Codex pris | Codex tid | Koda tid |
|---|---|---|---:|---|---:|---:|
| koda-vs-codex-1791300400 | PASS | FAIL | $0.002806 | subscription / ukendt | 25.7s | 37.9s |
| koda-vs-codex-1791300771 | PASS | PASS | $0.002987 | subscription / ukendt | 35.6s | 63.0s |
| koda-auto-vs-codex-1791377498 | PASS | PASS | $0.001006 | subscription / ukendt | 47.0s | 76.4s |

Codex tokenforbrug er ikke en faktisk faktura. API-prisækvivalenter er ikke beregnet her.

## Ugyldige / afbrudte forsøg

- `/tmp/koda-auto-frontier-1791375826`: reference/capability-preflight blokerede kodningen; brugeren afbrød. Ikke et solve-rate-resultat.
- `/tmp/koda-vs-codex-1791220751`, `1791221037`, `1791221961`: tidligere afbrudte sammenligninger uden komplette parrede resultater. Ikke med i økonomiske konklusioner.

## Hvad resultaterne viser — og ikke viser

De gennemførte utility-tests viser en markant lavere API-pris med samme beståede acceptance checks som de angivne baselines. Det dokumenterer kun disse opgaver og disse kørsler. Det er ikke bevis for 94–96% besparelse på alle kundeprompts, generel frontier-kvalitet eller fuld adfærdsdækning. Koda var typisk langsommere; rapporten skjuler ikke den forskel.
