/** Isolated V6.2 mechanics. No production imports of this module, no dispatch authority. */
import { boundedCapabilityHandoff, type ExecutionState, type TaskCapabilityProfile } from '../../../src/router/capabilityRoutingV6.js';
export interface Score { model: string; quality: number; costUsd: number; compatible: boolean; hardExcluded?: string }
export function paretoSelect(scores: readonly Score[], gap: number): Score | undefined {
  if (!Number.isFinite(gap) || gap < 0 || gap > 1) throw Error('Invalid regret');
  const available = scores.filter(s => s.compatible && !s.hardExcluded && Number.isFinite(s.quality) && s.quality >= 0 && s.quality <= 1 && Number.isFinite(s.costUsd) && s.costUsd >= 0);
  const best = Math.max(...available.map(s => s.quality));
  return available.filter(s => s.quality >= best - gap).sort((a,b) => a.costUsd-b.costUsd || b.quality-a.quality || a.model.localeCompare(b.model))[0];
}
/** Serious risk must be attested; generic profile domains remain SOFT features. */
export interface HardRisk { seriousSecurity?: boolean; destructiveSchema?: boolean; transactionConcurrency?: boolean; invariantViolation?: boolean }
export function hardRiskExclusions(risk: HardRisk, permitted: ReadonlySet<string>, scores: readonly Score[]): Score[] {
  const high = Object.values(risk).some(Boolean);
  return scores.map(s => ({...s, hardExcluded: s.hardExcluded ?? (high && !permitted.has(s.model) ? 'deterministic safety restriction' : undefined)}));
}
export interface Session { model: string; switches: number; visited: string[]; worktree: string }
export interface Economics { remainingTurns: number; switchUsd: number; cacheLossUsd: number; handoverUsd: number; routerUsd: number; recoveryUsd: number; qualityValueUsd: number; budgetRemainingUsd: number }
export type Action = 'discovery'|'implementation'|'verification'|'completion'|'infrastructure';
export function classifyAction(state: ExecutionState): Action {
  if (state.verification === 'infrastructure_failure') return 'infrastructure';
  return state.step === 'mutation' ? 'implementation' : state.step === 'read' ? 'discovery' : state.step;
}
export function planAction(session: Session, state: ExecutionState, profile: TaskCapabilityProfile, freshScorer: (action: Action, state: ExecutionState, profile: TaskCapabilityProfile) => readonly Score[], gap: number, economics: Economics) {
  const action = classifyAction(state); const scores = freshScorer(action, state, profile);
  const current = scores.find(s => s.model === session.model && s.compatible && !s.hardExcluded && Number.isFinite(s.quality) && s.quality >= 0 && s.quality <= 1 && Number.isFinite(s.costUsd) && s.costUsd >= 0); const fresh = paretoSelect(scores, gap);
  const stay = (reason: string, evUsd: number | null = null) => ({ action, decision:'STAY' as const, model:session.model, reason, evUsd, session:{...session,visited:[...session.visited]} });
  if (session.switches < 0 || !Number.isInteger(session.switches) || session.switches > 2 || !session.worktree) throw Error('Invalid session');
  if (Object.values(economics).some(v => !Number.isFinite(v) || v < 0)) throw Error('Invalid switching economics');
  if (action === 'infrastructure') return stay('infrastructure is not quality evidence');
  if (action === 'completion' && state.verification === 'pass') return stay('verified completion');
  if (!current || !fresh) return stay('insufficient fresh evidence');
  if (fresh.model === session.model) return stay('session pin matches scorer');
  if (session.switches >= 2 || session.visited.includes(fresh.model)) return stay('switch cap or oscillation');
  const overhead = economics.switchUsd+economics.cacheLossUsd+economics.handoverUsd+economics.routerUsd+economics.recoveryUsd;
  const improvement = (current.costUsd-fresh.costUsd)*economics.remainingTurns + (fresh.quality-current.quality)*economics.qualityValueUsd;
  const evUsd = improvement-overhead;
  if (fresh.costUsd*economics.remainingTurns+overhead > economics.budgetRemainingUsd) return stay('budget cap',evUsd);
  if (evUsd <= 0) return stay('negative switch EV',evUsd);
  return {action,decision:'SWITCH' as const, model:fresh.model,reason:'positive switch EV',evUsd,session:{...session,model:fresh.model,switches:session.switches+1,visited:[...new Set([...session.visited,session.model,fresh.model])]}};
}
export { boundedCapabilityHandoff };
