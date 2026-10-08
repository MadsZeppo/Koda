"""Transparent pre-execution task features; no task IDs, outputs or outcome inputs."""
import re,math
from dataclasses import dataclass
from collections import Counter
from scipy import sparse
from sklearn.feature_extraction import DictVectorizer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import StandardScaler
from source import TaskInput
TECH={
 'frontend':r'\b(?:html|css|react|browser|ui|render|component|dom)\b',
 'backend':r'\b(?:server|request|response|middleware|endpoint|http)\b',
 'database':r'\b(?:database|sql|queryset|transaction|postgres|sqlite|orm)\b',
 'api':r'\b(?:api|endpoint|rest|graphql|client|request)\b',
 'authentication':r'\b(?:authentication|login|password|session|token|credential)\b',
 'authorization':r'\b(?:permission|authorization|access control|role|forbidden)\b',
 'concurrency':r'\b(?:thread|lock|race|concurren\w*|deadlock|parallel)\b',
 'async':r'\b(?:async|await|future|promise|coroutine|event loop)\b',
 'state':r'\b(?:state|transition|lifecycle|mutable|mutation)\b',
 'cache':r'\b(?:cache|cached|memoiz\w*|invalidation)\b',
 'network':r'\b(?:network|socket|connection|timeout|dns|retry)\b',
 'serialization':r'\b(?:json|yaml|serialize\w*|pickle|encoding|decode\w*)\b',
 'schema':r'\b(?:schema|validation|validator|field|column)\b',
 'migration':r'\b(?:migration|migrate|upgrade|backward compatib\w*)\b',
 'dependency':r'\b(?:dependency|dependencies|package|version|install|import)\b',
 'build':r'\b(?:build|compile|bundler|webpack|makefile|setup\.py)\b',
 'types':r'\b(?:type|typing|generic|annotation|dtype|cast)\b',
 'tests':r'\b(?:test|tests|pytest|unittest|assert|fixture|regression)\b',
 'configuration':r'\b(?:configuration|config|setting|environment|option|flag)\b',
 'security':r'\b(?:security|vulnerab\w*|injection|sanitize\w*|exploit|csrf|xss)\b',
 'performance':r'\b(?:performance|slow|memory|complexity|efficient|optimiz\w*)\b'}
KINDS={'bug_fix':r'\b(?:bug|incorrect|wrong|fails?|failure|crash|error|unexpected|should|instead|regression)\b','feature':r'\b(?:add|support|implement|new|allow|enable|introduce)\b','refactor':r'\b(?:refactor|restructure|simplify|cleanup|extract)\b','test':TECH['tests'],'performance':TECH['performance'],'dependency':TECH['dependency'],'configuration':TECH['configuration'],'build':TECH['build'],'typing':TECH['types'],'documentation':r'\b(?:documentation|docs|readme|docstring|example)\b'}
PATH=r'(?:[\w.-]+/)+[\w.-]+|\b[\w.-]+\.(?:py|tsx?|jsx?|java|go|rs|cpp|c|h|yaml|json|toml|css)\b'

def structured(task:TaskInput,repo_identity=False):
    if type(task) is not TaskInput:raise TypeError('Features accept TaskInput, never outcome matrix')
    text=task.text;lower=text.lower();words=re.findall(r'\w+',text);paths=set(re.findall(PATH,text));features={}
    for name,value in {'chars':len(text),'words':len(words),'lines':text.count('\n')+1,'code_blocks':text.count('```')//2,'explicit_files':len(paths),'identifiers':len(re.findall(r'\b\w+(?:_\w+|\.\w+)\b',text)),'constraints':len(re.findall(r'\b(?:must|never|without|preserve|only|ensure|except)\b',lower)),'behaviors':len(re.findall(r'\b(?:should|return|when|if|expect\w*|support)\b',lower)),'components':len(set(re.findall(r'\b(?:class|function|module|component)\s+([\w.]+)',lower)))}.items():features['shape:'+name]=math.log1p(value)
    features['error']=float(bool(re.search(r'\b\w*(?:error|exception)\b|fails? with',lower)))
    features['stacktrace']=float(bool(re.search(r'traceback|File ".+", line \d+|at \w+.*:\d+:\d+',text,re.I)))
    features['command']=float(bool(re.search(r'(?:^|\n)\s*(?:\$|>>>|python |npm |pip |pytest |git )',text)))
    features['expected_output']=float(bool(re.search(r'expected|actual|>>>|should (?:return|produce|be)',lower)))
    for name,pattern in TECH.items():features['technical:'+name]=min(5,len(re.findall(pattern,lower)))/5
    kinds={name:len(re.findall(pattern,lower)) for name,pattern in KINDS.items()}
    for name,count in kinds.items():features['kind:'+name]=min(5,count)/5
    features['kind:unknown']=float(not any(kinds.values()))
    # Scope proxies are explainable signals, not a confident task classification.
    scope='cross-cutting' if len(paths)>5 or bool(re.search(r'\b(?:across|all modules|system-wide)\b',lower)) else 'multi-component' if len(paths)>1 else 'localized' if len(paths)==1 else 'unknown'
    features['scope:'+scope]=1.
    context=task.context
    for lang,pattern in {'python':r'\b[\w.-]+\.py\b|\bdef \w+\(|\bimport [\w.]+','javascript':r'\b[\w.-]+\.[jt]sx?\b|\bconst \w+ =|\bfunction \w+\(','java':r'\b[\w.-]+\.java\b|\bpublic class\b','rust':r'\b[\w.-]+\.rs\b|\bfn \w+\(','go':r'\b[\w.-]+\.go\b|\bfunc \w+\(','cpp':r'\b[\w.-]+\.(?:cpp|hpp)\b|#include'}.items():features['language:'+lang]=float(bool(re.search(pattern,context)))
    # Framework terms are taken from the task itself, not a manual repository mapping.
    for framework in ('django','flask','react','numpy','pandas','scipy','pytest','sympy','astropy','sphinx','scikit'):
        features['ecosystem:'+framework]=float(bool(re.search(r'\b'+framework+r'\b',lower)))
    if repo_identity and task.metadata.get('repo'):features['repo:'+task.metadata['repo']]=1.
    return features

class TaskFeatureExtractor:
    def __init__(self,mode='combined',repo_identity=False):
        if mode not in ('structured','text','combined'):raise ValueError('Unknown feature mode')
        self.mode=mode;self.repo_identity=repo_identity;self.profile_cache={};self.dict=DictVectorizer(sparse=True);self.scale=StandardScaler(with_mean=False)
        self.text=TfidfVectorizer(lowercase=True,token_pattern=r'(?u)\b\w+\b|::|->|==|!=|[{}()\[\].:+=*/-]',ngram_range=(1,2),max_features=12000,min_df=2,sublinear_tf=True)
    def profiles(self,tasks):
        results=[]
        for task in tasks:
            if type(task) is not TaskInput:raise TypeError('Routing inputs only')
            key=(task.text,task.context,task.metadata.get('repo') if self.repo_identity else None)
            if key not in self.profile_cache:self.profile_cache[key]=structured(task,self.repo_identity)
            results.append(self.profile_cache[key])
        return results
    def fit(self,tasks):
        if not tasks or any(type(t) is not TaskInput for t in tasks):raise TypeError('Nonempty routing inputs required')
        if self.mode!='text':self.scale.fit(self.dict.fit_transform(self.profiles(tasks)))
        if self.mode!='structured':
            texts=[t.text for t in tasks]
            try:self.text.fit(texts);self.empty_text=False
            except ValueError:self.empty_text=True
        return self
    def transform(self,tasks):
        if any(type(t) is not TaskInput for t in tasks):raise TypeError('Routing inputs required')
        parts=[]
        if self.mode!='text':parts.append(self.scale.transform(self.dict.transform(self.profiles(tasks))))
        if self.mode!='structured':parts.append(sparse.csr_matrix((len(tasks),1)) if self.empty_text else self.text.transform([t.text for t in tasks]))
        return sparse.hstack(parts,format='csr') if len(parts)>1 else sparse.csr_matrix(parts[0])
    def summary(self):return {'mode':self.mode,'repoIdentity':self.repo_identity,'structuredSchema':list(self.dict.feature_names_) if self.mode!='text' else [],'textVocabulary':{k:int(v) for k,v in self.text.vocabulary_.items()} if self.mode!='structured' and not self.empty_text else {},'textIdf':self.text.idf_.tolist() if self.mode!='structured' and not self.empty_text else [],'structuredScale':self.scale.scale_.tolist() if self.mode!='text' else []}
