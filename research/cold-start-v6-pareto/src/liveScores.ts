/** Inference only from the existing frozen V6.2 artifact. No fit or new router. */
import {readFileSync} from 'node:fs';
import {startFeatures} from '../../../src/router/startRouterV6.js';
import type {TaskCapabilityProfile} from '../../../src/router/capabilityRoutingV6.js';
interface Frozen {models:string[];vocabulary:Record<string,number>;idf:number[];coefficients:number[][];intercepts:number[]}
export class FrozenPilotScores {
 private artifact:Frozen;
 constructor(path:string){this.artifact=JSON.parse(readFileSync(path,'utf8'));const a=this.artifact;if(a.models.length!==12||a.coefficients.length!==12||a.intercepts.length!==12||Object.values(a.vocabulary).some(j=>!Number.isSafeInteger(j)||j<0||j>=a.idf.length)||a.idf.some(v=>!Number.isFinite(v))||a.coefficients.some(r=>r.some(v=>!Number.isFinite(v)))||a.intercepts.some(v=>!Number.isFinite(v)))throw Error('Invalid V6.2 frozen artifact');}
 predict(profile:TaskCapabilityProfile):Map<string,number>{
  const a=this.artifact;const words=(profile.task.text??'').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu)??[];const terms=[...words,...words.slice(0,-1).map((w,i)=>w+' '+words[i+1])];const counts=new Map<number,number>();for(const t of terms){const j=a.vocabulary[t];if(j!==undefined)counts.set(j,(counts.get(j)??0)+1);}
  const tf=new Map<number,number>();let norm=0;for(const[j,n]of counts){const v=(1+Math.log(n))*a.idf[j]!;tf.set(j,v);norm+=v*v;}norm=Math.sqrt(norm)||1;
  const features=startFeatures(profile);if(a.coefficients.some(r=>r.length!==a.idf.length+features.length))throw Error('Frozen predictor feature mismatch');
  return new Map(a.models.map((m,k)=>{const weights=a.coefficients[k]!;let value=a.intercepts[k]!;for(const[j,v]of tf)value+=weights[j]!*v/norm;for(let j=0;j<features.length;j++)value+=weights[a.idf.length+j]!*features[j]!;if(!Number.isFinite(value))throw Error('Invalid frozen prediction');return [m,Math.max(0,Math.min(1,value))];}));
 }
}
