"""MIT RouteProfile-adapted task/model neighbourhoods; CPU sparse adaptation.
See licenses/RouteProfile-MIT.txt. No exact-model ID classification.
"""
import json,hashlib
import numpy as np
from scipy.special import expit,logit
from scipy.stats import beta
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.decomposition import TruncatedSVD
from sklearn.cluster import KMeans
from sklearn.linear_model import LogisticRegression
from normalize import digest,features
SEED=20261007
REGIMES=[0,4,8,16,32]
VARIANTS=['flat','similarity','structured_graph','trainable_graph','irt']
class TaskSpace:
 def __init__(self,rows):
  safe={r['task_key']:features(r) for r in rows};ordered=[safe[k] for k in sorted(safe)]
  self.training_keys=sorted(safe)
  self.vectorizer=TfidfVectorizer(max_features=3000,min_df=2,ngram_range=(1,2),sublinear_tf=True)
  raw=self.vectorizer.fit_transform([self.text(r) for r in ordered]);self.vectorizer.vocabulary_={k:int(v) for k,v in self.vectorizer.vocabulary_.items()};self.svd=TruncatedSVD(n_components=min(24,raw.shape[1]-1,raw.shape[0]-1),random_state=SEED)
  x=self.svd.fit_transform(raw);self.cluster=KMeans(n_clusters=min(8,len(x)),n_init=10,random_state=SEED).fit(x)
  self.digest=digest({'vocabulary':self.vectorizer.vocabulary_,'idf':self.vectorizer.idf_.tolist(),'components':self.svd.components_.tolist(),'centers':self.cluster.cluster_centers_.tolist(),'training_keys':self.training_keys})
 def text(self,r):return (r.get('task_text') or '')+' language_'+str(r.get('language') or 'unknown')+' framework_'+str(r.get('framework') or 'unknown')
 def encode(self,rows):return self.svd.transform(self.vectorizer.transform([self.text(features(r)) for r in rows]))
 def neighborhoods(self,x):
  distance=((x[:,None,:]-self.cluster.cluster_centers_[None,:,:])**2).sum(2);w=np.exp(-distance/(np.median(distance)+1e-9));return w/w.sum(1,keepdims=True)
 def export(self):return {'digest':self.digest,'training_keys':self.training_keys,'vocabulary':self.vectorizer.vocabulary_,'idf':self.vectorizer.idf_.tolist(),'components':self.svd.components_.tolist(),'centers':self.cluster.cluster_centers_.tolist()}
def fit_logistic(x,y):
 return LogisticRegression(C=1,solver='liblinear',random_state=SEED,max_iter=500).fit(x,y) if len(set(y))>1 else None
class Profile:
 def __init__(self,model,anchors,space,prior):
  if any(r['model']!=model for r in anchors):raise ValueError('Different exact model in anchors')
  if any(r['split']!='train' for r in anchors):raise ValueError('Only training anchors allowed')
  self.model=model;self.rows=anchors;self.n=len(anchors);self.prior=prior;self.space_digest=space.digest
  self.x=space.encode(anchors) if anchors else np.zeros((0,space.svd.n_components));self.y=np.array([r['labels']['resolved'] for r in anchors]);self.w=space.neighborhoods(self.x) if anchors else np.zeros((0,len(space.cluster.cluster_centers_)))
  self.support=self.w.sum(0);self.representation=(self.w.T@self.y+2*prior)/(self.support+2)
  self.flat=(self.y.sum()+2*prior)/(self.n+2)
  self.provenance=sorted({r['provenance']['source']+'@'+r['provenance']['revision'] for r in anchors})
 def graph_value(self,space,x):return space.neighborhoods(x)@self.representation
 def uncertainty(self):
  # Credible interval for anchor-population success; not calibrated Koda transfer.
  a=self.y.sum()+1;b=self.n-self.y.sum()+1
  return float(beta.ppf(.975,a,b)-beta.ppf(.025,a,b))
 def export(self):return {'modelId':self.model,'representation':self.representation.tolist(),'uncertainty':self.uncertainty(),'evidenceCount':self.n,'taskCoverage':np.count_nonzero(self.support>0).item(),'provenance':self.provenance,'spaceDigest':self.space_digest,'anchors':[r['task_id'] for r in self.rows]}
def anchor_order(rows,space,difficulty):
 # Query-only neighborhood/difficulty strata. Labels are neither read nor sorted.
 x=space.encode(rows);clusters=space.cluster.predict(x);p=difficulty.predict_proba(x)[:,1] if difficulty else np.full(len(rows),.5)
 bins=np.digitize(p,np.quantile(p,[1/3,2/3]));buckets={}
 for r,c,d in zip(rows,clusters,bins):buckets.setdefault((int(c),int(d)),[]).append(r)
 for rs in buckets.values():rs.sort(key=lambda r:digest([SEED,r['task_key']]))
 ordered=[]
 while any(buckets.values()):
  for key in sorted(buckets):
   if buckets[key]:ordered.append(buckets[key].pop(0))
 return ordered
class Decoder:
 def __init__(self,rows,space):
  self.space=space;self.prior=float(np.mean([r['labels']['resolved'] for r in rows]));self.base=fit_logistic(space.encode(rows),[r['labels']['resolved'] for r in rows])
  # Profile support and edge-decoder targets use disjoint task groups.
  profile_rows=[r for r in rows if int(digest(r['task_key'])[:8],16)%3==0]
  edges=[r for r in rows if int(digest(r['task_key'])[:8],16)%3!=0]
  self.profiles={m:Profile(m,[r for r in profile_rows if r['model']==m],space,self.prior) for m in sorted({r['model'] for r in rows})}
  x=space.encode(edges);g=np.array([self.profiles[r['model']].graph_value(space,x[i:i+1])[0] for i,r in enumerate(edges)])
  # Shared query-model edge predictor, replacing upstream GPU GAT/HAN with L2 CPU
  # decoder of propagated task-neighborhood/model messages. Not an exact reproduction.
  self.edge=fit_logistic(np.column_stack([x,g,x*g[:,None]]),[r['labels']['resolved'] for r in edges])
 def predict(self,variant,profile,rows):
  x=self.space.encode(rows);base=self.base.predict_proba(x)[:,1] if self.base else np.full(len(rows),self.prior)
  if variant=='flat':return np.full(len(rows),profile.flat)
  if variant=='similarity':
   if not profile.n:return np.full(len(rows),self.prior)
   sim=x@profile.x.T/(np.linalg.norm(x,axis=1)[:,None]*np.linalg.norm(profile.x,axis=1)[None,:]+1e-9);w=np.exp(4*sim)
   return (w@profile.y+2*self.prior)/(w.sum(1)+2)
  g=profile.graph_value(self.space,x)
  if variant=='structured_graph':return g
  if variant=='trainable_graph':return self.edge.predict_proba(np.column_stack([x,g,x*g[:,None]]))[:,1] if self.edge else g
  # IRT-style task difficulty with one new-model ability offset (MAP L2 prior).
  from scipy.optimize import minimize_scalar
  if not profile.n:return base
  ap=self.base.predict_proba(profile.x)[:,1] if self.base else np.full(profile.n,self.prior);z=logit(np.clip(ap,1e-6,1-1e-6))
  def loss(a):q=expit(z+a);return -np.sum(profile.y*np.log(q+1e-9)+(1-profile.y)*np.log(1-q+1e-9))+a*a/2
  ability=minimize_scalar(loss,bounds=(-6,6),method='bounded').x
  return expit(logit(np.clip(base,1e-6,1-1e-6))+ability)
