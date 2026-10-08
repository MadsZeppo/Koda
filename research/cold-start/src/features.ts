import { stableCompare, type PreexecutionTask } from './types.js';
export type Vector = ReadonlyMap<string,number>;
export interface TaskFeatureExtractor { transform(task: PreexecutionTask): Vector }
export interface TaskSimilarity { compare(a: Vector,b:Vector):number }
export class Tfidf implements TaskFeatureExtractor {
  private readonly idf=new Map<string,number>();
  constructor(tasks: readonly PreexecutionTask[], private readonly features:'text'|'dimension'|'text-dimension') {
    const df=new Map<string,number>();for(const t of tasks) for(const term of new Set(this.terms(t))) df.set(term,(df.get(term) ?? 0)+1);
    for(const [term,n] of df) this.idf.set(term,Math.log((1+tasks.length)/(1+n))+1);
  }
  private terms(t:PreexecutionTask) {
    const tokens:string[]=this.features==='dimension'?[]:(t.text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if(this.features!=='text' && t.dimension) tokens.push(`dimension:${t.dimension}`);
    return tokens;
  }
  transform(t:PreexecutionTask):Vector {
    const counts=new Map<string,number>();for(const term of this.terms(t)) if(this.idf.has(term)) counts.set(term,(counts.get(term) ?? 0)+1);
    return new Map([...counts].sort(([a],[b])=>stableCompare(a,b)).map(([term,n])=>[term,(1+Math.log(n))*this.idf.get(term)!]));
  }
}
export function similarity(metric:'cosine'|'jaccard'):TaskSimilarity {
  if(metric==='jaccard') return {compare(a,b){const union=new Set([...a.keys(),...b.keys()]);return union.size?[...a.keys()].filter(k=>b.has(k)).length/union.size:0;}};
  if(metric!=='cosine') throw Error('Unsupported similarity metric');
  return {compare(a,b){let dot=0,na=0,nb=0;for(const [k,v] of a) {dot+=v*(b.get(k) ?? 0);na+=v*v;}for(const v of b.values()) nb+=v*v;return na && nb ? Math.min(1,dot/Math.sqrt(na*nb)):0;}};
}
