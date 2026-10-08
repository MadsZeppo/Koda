"""Reimplementation of prefix-state extraction; no imported router/pool/answers.
Tier-only SWE labels are weak supervision, NEVER labels for Koda model adequacy.
"""
import re,hashlib
FEATURES=['prefix_steps','read_actions','search_actions','mutation_actions','verification_actions','repeated_actions','observed_failures','scope_paths','diff_present','output_lines']
def prefix_state(row):
    if row.get('benchmark')!='swebench':raise ValueError('Coding states only')
    messages=row.get('messages',[]);commands=[];outputs=[]
    for m in messages:
        if m.get('role')=='assistant':
            for tool in m.get('tool_calls',[]):
                args=tool.get('function',{}).get('arguments','')
                if isinstance(args,str):
                    import json
                    try:args=json.loads(args)
                    except ValueError:args={}
                if isinstance(args,dict):commands.append(str(args.get('command',args.get('cmd',''))))
        elif m.get('role')=='tool':outputs.append(str(m.get('content','')))
    joined='\n'.join(commands);out='\n'.join(outputs)
    # No target tier, future total_steps, instance identity, gold patch or final score enters features.
    paths=set(re.findall(r'(?:[\w.-]+/)+[\w.-]+\.(?:py|tsx?|jsx?|go|rs|java|sql)',joined))
    return [len(commands),sum(bool(re.search(r'\b(?:cat|sed|head|tail)\b',c)) for c in commands),
        sum(bool(re.search(r'\b(?:rg|grep|find|ls)\b',c)) for c in commands),
        sum(bool(re.search(r'\b(?:apply_patch|tee)\b|write_text|open\(.+?[wa][\x27\x22]|sed -i|>\s*\S+',c)) for c in commands),
        sum(bool(re.search(r'\b(?:pytest|unittest|test|typecheck|build|tsc)\b',c)) for c in commands),
        len(commands)-len(set(commands)),len(re.findall(r'\b(?:FAILED|AssertionError|Traceback|error:)\b',out)),len(paths),
        int('diff --git' in out),out.count('\n')]
def group(row):return row['instance_id']
def tier(row):
    if row.get('target_tier') not in ('low','mid','mid_high','high'):raise ValueError('Unknown tier')
    return row['target_tier']
def partition(instance):return int(hashlib.sha256(instance.encode()).hexdigest()[:8],16)%10
