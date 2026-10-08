"""Render frozen V5 pilot/full results; never dispatch or change judge inputs."""
import json,argparse
from pathlib import Path
from collections import Counter
ROOT=Path(__file__).resolve().parent

def report(run,phase):
    run=Path(run);folder=run/phase;manifest=json.loads((run/'manifest.json').read_text());estimate=json.loads((run/'estimate.json').read_text());receipts=[json.loads(p.read_text()) for p in folder.glob('*.receipt.json')];cost=sum(r['costUsd'] for r in receipts)
    lines=['# Cold Start V5 — fixed LLM routing judge','',f"Judge: **{manifest['judge']}**, reasoning medium, seed 20261007, temperature omitted, strict JSON schema. Exact requested version, returned aliases/providers, usage and raw responses are stored per call.",'']
    if (folder/'operational-failure.json').exists():
        failure=json.loads((folder/'operational-failure.json').read_text());lines += ['**STOP: operational/protocol failure. No full evaluation dispatched.**','',f"Error: `{failure['error']}`. Completed valid decisions: {failure['completed']}. Known paid receipts: {len(receipts)}, ${cost:.6f}. Uncertain reservation: ${failure['budget']['reserved']:.6f}.",'','This is not negative coding-model quality evidence. No incomplete response is converted into a routing success. Inspect raw responses for the failing hop.']
    else:
        data=json.loads((folder/'results.json').read_text());gate=json.loads((run/'pilot/gate.json').read_text());ledger=json.loads((folder/'cost.json').read_text());lines += [f"Pilot gate: **{'CONTINUE' if gate['continue'] else 'STOP'}**. Stability: {gate['stable']}. Successful cheap selections at 3pp: {gate['correctCheap']}. Tasks: {data['Frontier']['tasks']}.",'','| Policy | Solve rate | Frontier retained | Total cost/solve | Saving vs frontier | Harmful downgrade |','|---|---:|---:|---:|---:|---:|']
        for k in ['Frontier','V3','V4','LLM 0pp','LLM 1pp','LLM 2pp','LLM 3pp','Oracle']:
            x=data[k];pct=lambda v:'n/a' if v is None else f'{100*v:.1f}%';money='n/a' if x['costPerSolved'] is None else f"${x['costPerSolved']:.4f}";lines.append(f"| {k} | {pct(x['solveRate'])} | {pct(x['frontierRetained'])} | {money} | {pct(x['costSaving'])} | {pct(x['harmfulDowngrade'])} |")
        lines += ['', f"Total actual judge cost: **${ledger['actual']:.6f}**. All calls, including the two stability repeats, are included in each LLM policy's economics. Coding costs are the unchanged historical task receipts, not new coding inference. Oracle is cheapest-successful hindsight, with no judge fee.",'','## Model selections','']
        for g in range(4):
            x=data[f'LLM {g}pp'];lines += [f"- {g}pp: `{x['models']}`; routed away from frontier: {100*x['routedAway']:.1f}%."]
        errors=json.loads((folder/'task-analysis.json').read_text());decisions=json.loads((folder/'decisions.json').read_text());packets={k:json.loads((run/'packets'/k).read_text()) for k in manifest['packetHashes']};reasons=[d['answer']['reason'] for d in decisions]
        lines += ['', '## Harmful and successful cheap decisions','']
        for g in range(4):
            info=errors[str(g)];lines += [f"### {g}pp",'',f"Harmful cheap downgrades: **{len(info['harmfulDowngrades'])}**. Successful cheap selections: **{len(info['successfulCheapSelections'])}**."]
            for k in ('harmfulDowngrades','successfulCheapSelections'):
                for item in info[k]:lines.append(f"- {k}: `{item['taskId']}` → {item['selected']}; frontier pass={item['frontierPassed']}, candidate pass={item['candidatePassed']}; {item['reason']}")
        calibration=json.loads((folder/'calibration.json').read_text());lines += ['', '## Gap calibration (pilot descriptive only)','', '| Model | Mean predicted gap pp | Actual signed gap pp | Gap MSE |','|---|---:|---:|---:|']
        for c in calibration:lines.append(f"| {c['model']} | {c['meanPredictedGapPp']:.2f} | {c['actualGapPp']:.2f} | {c['gapMSE']:.4f} |")
        lines += ['', 'Actual signed gap is frontier-success minus candidate-success. Confidence is not P(success); bin-level comparisons are saved in calibration.json. With ten tasks each single-event rate changes by ten percentage points, so this does not validate 2–3pp probability calibration.','', '## Diagnosis','']
        if data['LLM 3pp']['routedAway']==0:lines += ['The judge is **too conservative for the product objective**: it chose frontier for every pilot task, reproducing V4 selections while adding judge cost. It supplied differentiated model gaps but identified no validated cheap task stratum. This pilot does not prove inability to understand task difficulty; it shows that supplied task signals and TRAIN/public profiles did not lead this fixed judge to useful task-conditioned downgrades. No harmful cheap selection occurred because no cheap selection occurred.']
        elif not gate['stable']:lines += ['The fixed judge produced unstable dispatch decisions under identical repeated prompts. Full evaluation was stopped; no prompt or thresholds were tuned to repair the result.']
        elif data['LLM 3pp']['frontierRetained']<.97:lines += ['The judge made harmful cheap-model selections and did not retain near-frontier solve rate. Full evaluation was stopped rather than retuning gaps against outcomes.']
        elif not gate['continue']:lines += ['The pilot did not demonstrate lower total cost/solve plus sufficient successful cheap selections under the predeclared gate. Full evaluation was stopped.']
        else:lines += ['The pilot passed the fixed discrimination, stability, quality and economics gate. Full evaluation retains unchanged prompts/profiles/settings; pilot decisions are cached rather than billed again.']
        lines += ['', 'Judge reasons (unmodified):','']+[f"- {i+1}: {r}" for i,r in enumerate(reasons)]
    lines += ['', '## Costs, limitations and safety','',f"Pre-call estimate: pilot up to ${estimate['pilotWorstCaseUsd']:.4f}; all 100 plus repeats up to ${estimate['fullWorstCaseUsd']:.4f}. Both include maximum reasoning/completion reserve and input bounds. No coding models were rerun.",'', 'Public SWE tasks can exist in the judge\'s pretraining. No hidden task outcomes/patches were provided, but benchmark familiarity cannot be ruled out. The V4 holdout was previously observed. Profiles use TRAIN and frozen public catalog evidence only. These results are retrospective research, not measured Koda verified customer performance.','', 'Only research/cold-start-v5 contains new files. Production routing, VNext, authority, thresholds, verification, recovery, production history and V2/V3/V4 source/results are unchanged. Judge requests use the existing shared backend transport without a local provider key.','', 'Test results and SHA256 integrity audit are appended after completion.']
    path=ROOT/'RESULTS.md';path.write_text('\n'.join(lines)+'\n');return path
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--run',default=str(ROOT/'artifacts/run'));p.add_argument('--phase',default='pilot',choices=['pilot','full']);a=p.parse_args();print(report(a.run,a.phase))
