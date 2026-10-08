import test from 'node:test';
import assert from 'node:assert/strict';
import { pilotConfigs, pilotTasks, runPilot } from '../src/dev/autoFrontierPilot.js';
import { codingScenarios, scenarioFixture } from '../src/dev/codingSuiteFixtures.js';
test('pilot uses existing identical fixtures and independent acceptance for both arms', () => {
  assert.equal(pilotTasks.length, 5);
  for (const id of pilotTasks) {
    const scenario = codingScenarios.find(s => s.id === id)!;
    assert.ok(scenario);
    const a = scenarioFixture(scenario), b = scenarioFixture(scenario);
    assert.deepEqual(a.files, b.files);
    assert.equal(a.task, b.task);
    assert.equal(a.acceptance, b.acceptance);
    assert.ok(a.acceptance.length > 0);
  }
});
test('frontier is pinned while Auto retains identical limits and reviewer settings', () => {
  const base = { stageMaxTokens: 15000, maxOutputTokens: 4096, routing: { authority: 'legacy' }, planner: { minimumQuality: .9 } };
  const configs = pilotConfigs(base, 'provider/frontier');
  assert.equal(configs.auto.routing.authority, 'openrouter-auto');
  assert.equal(configs.frontier.routing.authority, 'cold-start');
  assert.deepEqual(configs.frontier.routing.coldStart.models, ['provider/frontier']);
  assert.deepEqual(configs.auto.planner, configs.frontier.planner);
  assert.equal(configs.auto.stageMaxTokens, configs.frontier.stageMaxTokens);
  assert.equal(base.routing.authority, 'legacy');
});
test('no paid default budget or Auto frontier alias is accepted', async () => {
  assert.throws(() => pilotConfigs({}, 'openrouter/auto'));
  await assert.rejects(runPilot({ output: '/unused', config: '/unused', model: 'model', budgetUsd: 0 }), /budget/);
});

test('fresh backend snapshot acquires capabilities before freezing instead of retaining price-only fallbacks', async () => {
  const { config } = await import('../src/config.js');
  const { Catalog } = await import('../src/openrouter/catalog.js');
  const { CapabilityRegistry } = await import('../src/router/capabilityRegistry.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'koda-cold-backend-'));
  const oldMode = process.env.KODA_PROVIDER_MODE, oldFetch = globalThis.fetch;
  let calls = 0;
  process.env.KODA_PROVIDER_MODE = 'backend';
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      calls++;
      return new Response(JSON.stringify({ data: [{ id: 'test/frontier', context_length: 100000, top_provider: { max_completion_tokens: 8192 }, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools', 'tool_choice'] }] }));
    }
    return new Response(JSON.stringify({ data: [] }));
  };
  try {
    const cfg = await config(undefined, { routing: { stateDirectory: directory, authority: "cold-start", coldStart: { models: ["test/frontier"], referenceModel: "test/frontier" } }, modelPool: { provider: 'openrouter', models: [{ id: 'test/frontier', tier: 'frontier', qualityPrior: .9, fallback: { inputPrice: 1, outputPrice: 2 } }] } });
    const registry = new CapabilityRegistry(cfg, new Catalog(cfg.baseUrl, directory, 100000, cfg.modelPool!.models));
    const first = await registry.freezeRunSnapshot();
    await registry.freezeRunSnapshot();
    assert.equal(calls, 1);
    assert.deepEqual(first.find(m => m.model.id === 'test/frontier')!.metadata.supportedParameters, ['tools', 'tool_choice']);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldMode === undefined) delete process.env.KODA_PROVIDER_MODE; else process.env.KODA_PROVIDER_MODE = oldMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('three-task pilot selects the same existing tasks and caps allocations for either arm',async()=>{
 const {pilotSelection}=await import('../src/dev/autoFrontierPilot.js');
 const names=['expert-shortest-path','expert-knapsack','expert-min-window'];
 assert.deepEqual(pilotSelection('expert',names,3),{suite:'expert',tasks:names,parallel:3});
 assert.throws(()=>pilotSelection('expert',['unknown'],3));
 assert.throws(()=>pilotSelection('expert',[names[0]!,names[0]!],3));
 assert.throws(()=>pilotSelection('expert',names,0));
});

 test('per-task prices preserve unknown receipts instead of reporting partial totals as cost', async () => {
  const {taskCostTable} = await import('../src/dev/autoFrontierPilot.js');
  const table = taskCostTable([{arm:'auto',runs:[{id:'a',passed:true,costUsd:null,costComplete:false,knownReceiptCostUsd:0.01,wallClockMs:1200}]},{arm:'frontier',runs:[{id:'a',passed:false,costUsd:0.02,costComplete:true,knownReceiptCostUsd:0.02,wallClockMs:2300}]}]);
  assert.match(table, /a \| auto \| yes \| unknown \| \$0.010000 \| 1.2s/);
  assert.match(table, /a \| frontier \| no \| \$0.020000/);
 });
