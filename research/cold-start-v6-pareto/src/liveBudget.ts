/** Pilot-only transport guard. All model calls, including review/recovery, share this ledger. */
import {createServer} from 'node:http';
import {once} from 'node:events';
import {providerPayloadBound,admitProviderPayload} from '../../../src/context/packetPolicy.js';
export interface PilotModel {id:string;tier:'cheap'|'strong'|'frontier';inputUsdPerMillion:number;outputUsdPerMillion:number;contextTokens:number;supportedParameters:string[]}
export interface Receipt {model:string;costUsd:number|null;inputTokens:number;outputTokens:number;phase:string;error?:string}
export class PilotLedger {
 spent=0;reserved=0;uncertain=false;receipts:Receipt[]=[];
 constructor(readonly capUsd:number){if(!Number.isFinite(capUsd)||capUsd<=0)throw Error('Positive cap required');}
 reserve(amount:number){if(this.uncertain||!Number.isFinite(amount)||amount<0||this.spent+this.reserved+amount>this.capUsd+1e-12)throw Error('PILOT_HARD_BUDGET_STOP');this.reserved+=amount;let done=false;return (receipt?:Receipt,dispatched=true)=>{if(done)throw Error('Reservation already settled');done=true;this.reserved-=amount;if(receipt)this.receipts.push(receipt);if(receipt?.costUsd!=null){this.spent+=receipt.costUsd;if(receipt.costUsd>amount+1e-9||this.spent>this.capUsd+1e-9)this.uncertain=true;}else if(dispatched)this.uncertain=true;};}
}
export async function startPilotTransport(upstream:string, credential:string, models:readonly PilotModel[],ledger:PilotLedger){
 const server=createServer(async(req,res)=>{
  let settle:ReturnType<PilotLedger['reserve']>|undefined;let dispatched=false;
  try {
   if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1_000_000)throw Error('Pilot payload too large');}
   const payload=JSON.parse(body);if(payload.stream)throw Error('Pilot requires nonstreaming receipts');
   const model=models.find(m=>m.id===payload.model);if(!model)throw Error('Unpriced model is not admitted');
   const output=payload.max_tokens??payload.max_completion_tokens;if(!Number.isInteger(output)||output<=0)throw Error('Explicit bounded output required');
   // The worker may compact before dispatch. Measure THIS final forwarded packet.
   payload.provider={...payload.provider,require_parameters:true,allow_fallbacks:false,max_price:{prompt:model.inputUsdPerMillion,completion:model.outputUsdPerMillion}};
   const bound=admitProviderPayload(payload,output,model.contextTokens);
   const billingInputCeiling=Math.min(model.contextTokens-output,Math.max(bound.inputTokens,Buffer.byteLength(JSON.stringify(payload))+4096));
   const reservation=(billingInputCeiling*model.inputUsdPerMillion+output*model.outputUsdPerMillion)/1e6;
   settle=ledger.reserve(reservation);dispatched=true;
   const response=await fetch(upstream.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
   const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{}
   const u=data?.usage;const reported=typeof u?.cost==='number'&&Number.isFinite(u.cost)&&u.cost>=0?u.cost:null;
   // Actual token receipts with enforced price ceilings are a conservative billed upper bound.
   const tokensKnown=Number.isSafeInteger(u?.prompt_tokens)&&u.prompt_tokens>=0&&Number.isSafeInteger(u?.completion_tokens)&&u.completion_tokens>=0;
   const tokenCeiling=tokensKnown?(u.prompt_tokens*model.inputUsdPerMillion+u.completion_tokens*model.outputUsdPerMillion)/1e6:null;
   const receipt={model:data?.model??model.id,costUsd:reported,inputTokens:tokensKnown?u.prompt_tokens:0,outputTokens:tokensKnown?u.completion_tokens:0,phase:String(payload.tools?.length?'coding':'pipeline'),...(response.ok?{}:{error:'HTTP '+response.status})};
   // Economics report actual API cost only; unknown actual cost always stops future paid calls.
   settle(receipt);settle=undefined;
   if(tokenCeiling!==null&&tokenCeiling>reservation+1e-9)ledger.uncertain=true;
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});res.end(text);
  }catch(error){if(settle)settle(undefined,dispatched);res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:String(error),type:'pilot_operational_failure'}}));}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('No local transport');
 return {url:`http://127.0.0.1:${address.port}/v1`,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
