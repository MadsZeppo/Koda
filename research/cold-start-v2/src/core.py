"""Research-only standard-library types and leakage boundaries; no Koda imports."""
from __future__ import annotations
import hashlib, json, math, copy
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Mapping
from pathlib import Path

MODEL_MAP = MappingProxyType({
    'claude-sonnet-4':'Claude-sonnet-4', 'gemini-2.5-flash':'Gemini-2.5-flash',
    'gpt-5':'GPT-5-medium', 'qwen3-235b':'Qwen3-235b-a22b-2507',
    'deepseek-v3.1':'Deepseek-v3.1-terminus', 'glm-4.6':'GLM-4.6'})
# Release directory gpt-5 is the documented reasoning_effort=medium entry, never gpt-5-chat.
SOURCE_MODEL_MAP=MappingProxyType({**{v.casefold():k for k,v in MODEL_MAP.items()},'gpt-5':'gpt-5'})
MODELS = tuple(MODEL_MAP)
DATASETS = ('livecodebench', 'swe-bench')
VERSION = 'cold-start-v2-research-1'

def encoded(value): return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
def digest(value): return hashlib.sha256(value if isinstance(value, bytes) else encoded(value).encode()).hexdigest()
def normalize(text): return ' '.join(text.split())
def check_models(models):
    if set(models)!=set(MODELS) or len(models)!=6: raise ValueError('Exactly the six immutable research models are required')
def number(value, name, optional=True):
    if value is None or value=='':
        if optional: return None
        raise ValueError(f'Missing {name}')
    if not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value) or value<0: raise ValueError(f'Invalid {name}: {value!r}')
    return float(value)

@dataclass(frozen=True)
class Task:
    task_id:str; dataset:str; source_split:str; record_index:str|int
    origin_query:str; query_hash:str; metadata:Mapping=field(default_factory=dict)
@dataclass(frozen=True)
class Outcome:
    task_id:str; model_id:str; score:float; success:bool; cost_usd:float|None
    prompt_tokens:float|None; completion_tokens:float|None; source_file:str; source_fingerprint:str
@dataclass(frozen=True)
class Matrix:
    task:Task; outcomes:Mapping[str,Outcome]
@dataclass(frozen=True)
class RoutingTask:
    # Dataset identity and arbitrary source metadata are NOT feature inputs.
    origin_query:str
@dataclass(frozen=True)
class TrainingEvidence:
    rows:tuple[Matrix,...]
    def __post_init__(self):
        for row in self.rows: check_models(row.outcomes)
@dataclass(frozen=True)
class ValidationEvidence:
    rows:tuple[Matrix,...]
@dataclass(frozen=True)
class EvaluationGroundTruth:
    rows:tuple[Matrix,...]

class SealedEvaluation:
    """Normal predictors only see tasks. Hidden outcomes release after persisted predictions."""
    def __init__(self, rows):
        self.__rows=tuple(rows)
        self.tasks=tuple(r.task for r in rows)
    def release(self, path:Path, predictions:list[dict]):
        expected=''.join(encoded(p)+'\n' for p in predictions)
        if path.read_text()!=expected: raise ValueError('Predictions must be finalized before ground-truth scoring')
        if len(predictions)!=len(self.tasks) or {p['taskId'] for p in predictions}!={t.task_id for t in self.tasks}: raise ValueError('Incomplete prediction artifact')
        return EvaluationGroundTruth(self.__rows)

def outcome_json(o):
    return {'taskId':o.task_id,'modelId':o.model_id,'score':o.score,'success':o.success,'costUsd':o.cost_usd,'promptTokens':o.prompt_tokens,'completionTokens':o.completion_tokens,'sourceFile':o.source_file,'sourceFingerprint':o.source_fingerprint}
def task_json(t):
    return {'taskId':t.task_id,'dataset':t.dataset,'sourceSplit':t.source_split,'recordIndex':t.record_index,'originQuery':t.origin_query,'originQueryHash':t.query_hash,'metadata':dict(t.metadata)}
def matrix_json(r): return {'task':task_json(r.task),'outcomes':{m:outcome_json(r.outcomes[m]) for m in MODELS}}
def from_json(r):
    t=r['task'];task=Task(t['taskId'],t['dataset'],t['sourceSplit'],t['recordIndex'],t['originQuery'],t['originQueryHash'],MappingProxyType(t['metadata']))
    outs={m:Outcome(o['taskId'],m,o['score'],o['success'],o['costUsd'],o['promptTokens'],o['completionTokens'],o['sourceFile'],o['sourceFingerprint']) for m,o in r['outcomes'].items()}
    check_models(outs)
    for model,o in outs.items():
        if o.task_id!=task.task_id or r['outcomes'][model]['modelId']!=model:raise ValueError('Canonical outcome identity mismatch')
        if number(o.score,'score',False)>1 or type(o.success) is not bool or o.success!=(o.score==1):raise ValueError('Invalid canonical success semantics')
        for key,value in [('cost',o.cost_usd),('prompt tokens',o.prompt_tokens),('completion tokens',o.completion_tokens)]:number(value,key)
    if task.dataset not in DATASETS or task.query_hash!=digest(normalize(task.origin_query)): raise ValueError('Invalid canonical task')
    return Matrix(task,MappingProxyType(outs))
