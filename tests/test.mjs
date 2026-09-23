import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {Service,PLANNER_PROMPT,reviewerPrompt,readPaths,touches} from '../src/service.mjs';import {runProcess,childEnv,providerEnv,classify,claudeArgs} from '../src/agents.mjs';import {LEASE_STALE_MS} from '../src/store.mjs';import {relevantFiles,buildTaskContext,contextConfig} from '../src/context.mjs';import {normalisePath,goldFromEvents,scoreCase,plannerCases,evaluate,summarise} from '../src/ranker-eval.mjs';import {createWorktree,dirtyPaths,currentBranch,isAncestor} from '../src/git.mjs';import {Runner} from '../src/runner.mjs';import {describeEvent,formatEvent,bodyKind,diffLines,diffSides,unifiedDiff} from '../src/format.mjs';
function repo(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-'));execFileSync('git',['init','-q'],{cwd:d});fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));fs.writeFileSync(path.join(d,'README.md'),'x');execFileSync('git',['add','.'],{cwd:d});execFileSync('git',['-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','init'],{cwd:d});return d}
test('approval is mandatory',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);await assert.rejects(()=>s.execute(t.id),/approval/i)});
test('mock full workflow completes',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);const done=await s.execute(t.id);assert.equal(done.state,'COMPLETE');assert.ok(s.store.listRuns(t.id).length>=3)});
test('a FAIL verdict sends the task to repair',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);s.updateProvider('mock',{enabled:false});s.addProvider({id:'review-mock',name:'Review Mock',kind:'mock',enabled:true,config:{reviewText:'The implementation fails to meet item 3 of the approved plan.',reviewVerdict:'FAIL'}});s.store.addModel({id:'review-mock-m',providerId:'review-mock',name:'review-mock',capabilities:['planning','coding','review','repair'],speed:10,cost:0,quality:10,contextLength:100000});const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);const done=await s.execute(t.id);assert.equal(done.state,'REPAIRING');assert.equal(done.review,'The implementation fails to meet item 3 of the approved plan.')});

test('a PASS verdict is not overturned by the prose around it',async()=>{
  // The incident, as one string. Two reviewers passed task 663391d8 and it went to
  // repair twice, because the verdict was read as a word in the reply: the body says
  // "no test failures" and names the FAILED state, so \bfail matched, and the escape
  // hatch required PASS to start a line, which "## Verdict: PASS" and
  // "**Verdict: PASS**" both fail to do. The verdict field says PASS, so the task is
  // complete and the prose is stored exactly as written.
  const prose = '## Verdict: PASS\n\nI independently ran the full test suite: 139/139 passing. No discrepancies found between the diff and the approved plan; no test failures. The FAILED state is untested.';
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  s.updateProvider('mock',{enabled:false});
  s.addProvider({id:'review-mock',name:'Review Mock',kind:'mock',enabled:true,config:{reviewText:prose}});
  s.store.addModel({id:'review-mock-m',providerId:'review-mock',name:'review-mock',capabilities:['planning','coding','review','repair'],speed:10,cost:0,quality:10,contextLength:100000});
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);
  const done=await s.execute(t.id);
  assert.equal(done.state,'COMPLETE');
  assert.equal(done.review,prose,'stored verbatim, not read for a verdict');
});

test('a verdict outside the schema leaves the task reviewable rather than repaired',async()=>{
  // MAYBE is what a provider that ignores --json-schema produces, and it is the
  // reason the verdict is checked against the enum rather than trusted. It may not
  // be read as PASS, and it may not be read as FAIL either: nothing has described a
  // fault, so REPAIRING would send an agent to fix something no one found. The task
  // stays in REVIEWING, where one more Review click is the whole recovery.
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  s.updateProvider('mock',{enabled:false});
  s.addProvider({id:'review-mock',name:'Review Mock',kind:'mock',enabled:true,config:{reviewText:'I looked at it.',reviewVerdict:'MAYBE'}});
  s.store.addModel({id:'review-mock-m',providerId:'review-mock',name:'review-mock',capabilities:['planning','coding','review','repair'],speed:10,cost:0,quality:10,contextLength:100000});
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);
  const planner=s.store.listRuns(t.id).find((r)=>r.role==='planner');
  assert.equal(s.structuredOutput(planner.id),null,'a run with no structured output has no verdict');
  await assert.rejects(()=>s.execute(t.id),/no structured verdict/i);
  assert.equal(s.task(t.id).state,'REVIEWING');
});

test('only the reviewer is asked for a structured verdict',()=>{
  const reviewer=claudeArgs({role:'reviewer',prompt:'x'});
  const i=reviewer.indexOf('--json-schema');
  assert.ok(i>=0,'the reviewer must be told the shape of its verdict');
  assert.deepEqual(JSON.parse(reviewer[i+1]).properties.verdict.enum,['PASS','FAIL']);
  for(const role of ['planner','implementer','repair'])
    assert.equal(claudeArgs({role,prompt:'x'}).includes('--json-schema'),false,`${role} still answers in prose`);
});
test('worktree is isolated',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const a=s.createTask(p.id,'a');const b=s.createTask(p.id,'b');s.prepare(a.id);s.prepare(b.id);await s.plan(a.id);await s.plan(b.id);s.approve(a.id);s.approve(b.id);await s.execute(a.id);await s.execute(b.id);const ta=s.task(a.id),tb=s.task(b.id);assert.notEqual(ta.worktree,tb.worktree);assert.equal(fs.existsSync(ta.worktree),true);assert.equal(fs.existsSync(tb.worktree),true)});
test('provider fallback',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);s.addProvider({id:'bad',name:'Bad',kind:'mock',enabled:true,config:{failRoles:['planner']}});s.addProvider({id:'good',name:'Good',kind:'mock',enabled:true,config:{}});for(const id of ['bad','good'])s.store.addModel({id:id+'-m',providerId:id,name:id,capabilities:['planning','coding','review','repair'],speed:10,cost:0,quality:id==='bad'?20:10,contextLength:100000});const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);const runs=s.store.listRuns(t.id);assert.equal(runs.filter(r=>r.status==='failed').length,1);assert.equal(runs.filter(r=>r.status==='succeeded').length,1)});


test('a failed chain reports the failure and why nothing was left to try',async()=>{
  // The production shape. One provider dies on an auth failure, the only other one is
  // already at its concurrency limit, and the message that reached the user named the
  // auth failure alone: a key that had just been corrected looked like a key that had
  // never been set, and the provider that could have taken over was never mentioned.
  //
  // The provider is deepseek because its missing key throws before any process is
  // spawned (agents.mjs), which is the same 37ms failure the user hit, deterministically.
  const root=repo();
  const s=new Service(root,{allowMock:false});
  s.addProvider({id:'ds',name:'DeepSeek',kind:'deepseek',enabled:true,config:{routable:true,apiKeyEnv:'AICODE_TEST_KEY_THAT_IS_NEVER_SET'}});
  s.addProvider({id:'cc',name:'Anthropic',kind:'claude-code',enabled:true,config:{routable:true}});
  s.addModel({id:'ds-m',providerId:'ds',name:'deepseek',capabilities:['planning'],speed:10,quality:12,cost:0,contextLength:100000});
  s.addModel({id:'cc-m',providerId:'cc',name:'claude',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});
  // The seam eligible() already calls through, so this is the real concurrency check
  // and not a stand-in for one. DeepSeek scores higher, so it is the attempt that fails.
  s.runner={atCapacity:(p)=>p.id==='cc',runningByProvider:()=>1,limitFor:()=>1};
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  await assert.rejects(()=>s.plan(t.id),(e)=>{
    assert.equal(e.code,'AUTH_FAILURE','the failure that emptied the chain keeps its code: plan() reads it to decide whether the task itself is at fault');
    assert.match(e.message,/Missing AICODE_TEST_KEY_THAT_IS_NEVER_SET/,'the real failure is still the headline');
    assert.match(e.message,/DeepSeek was already tried in this chain/,'the provider that failed is named as the attempt it was');
    assert.match(e.message,/Anthropic is at its concurrency limit/,'and the one that could not take over is named, with the reason');
    // Every install seeds a mock provider, so a clause about it would trail every dead
    // end a user ever reads while never naming anything they could act on.
    assert.doesNotMatch(e.message,/mock/i,'the seeded mock provider is not a routing option, so it is not a reason');
    return true;
  });
  assert.equal(s.task(t.id).state,'PLANNING','a routing dead end is not a property of the task');
});

test('a routing dead end names what was blocking each provider',()=>{
  // An empty list is the one routing outcome a user reads, and the message carried no
  // clue which of these two configurations they were in.
  const root=repo();
  const s=new Service(root,{allowMock:false});
  s.addProvider({id:'a',name:'Alpha',kind:'claude-code',enabled:true,config:{routable:true}});
  s.addModel({id:'a-m',providerId:'a',name:'a',capabilities:['coding'],speed:10,quality:10,cost:0,contextLength:100000});
  s.addProvider({id:'b',name:'Beta',kind:'claude-code',enabled:false,config:{routable:true}});
  let err;
  try{s.select('planner')}catch(e){err=e}
  assert.equal(err.code,'NO_MODEL');
  assert.equal(err.message,'No available model capable of planner','the shape every caller matches on is unchanged');
  const why=err.rejections.map(r=>`${r.name} ${r.detail}`).join('; ');
  assert.match(why,/Alpha has no enabled model capable of planner/);
  assert.match(why,/Beta is disabled/);
  assert.equal(err.rejections.length,2,'the seeded mock provider contributes no clause: it is reachable only through the last resort, never by routing');
});

test('production routing excludes mock',()=>{const root=repo();const s=new Service(root,{allowMock:false});const p=s.initProject('p',root);s.addProvider({id:'mock2',name:'Mock2',kind:'mock',enabled:true,config:{routable:true}});s.addModel({id:'mock2m',providerId:'mock2',name:'Mock2',capabilities:['planning'],speed:10,quality:10,cost:0});assert.throws(()=>s.select('planner'),/No available model/)});
test('preferred model is honoured',()=>{const root=repo();const s=new Service(root);const p=s.initProject('p',root);s.addProvider({id:'a',name:'A',kind:'claude-code',enabled:true,config:{routable:true}});s.addModel({id:'slow',providerId:'a',name:'slow',capabilities:['planning'],speed:1,quality:10,cost:1});s.addModel({id:'fast',providerId:'a',name:'fast',capabilities:['planning'],speed:10,quality:8,cost:1});s.saveRouting({...s.getRouting(),planner:{...s.getRouting().planner,preferred:['a:slow']}});assert.equal(s.select('planner').m.id,'slow')});
test('provider model controls persist',()=>{const root=repo();const s=new Service(root);s.addProvider({id:'a',name:'A',kind:'claude-code',enabled:true,config:{routable:true}});s.addModel({id:'m',providerId:'a',name:'m',capabilities:['planning'],enabled:true});assert.equal(s.updateProvider('a',{enabled:false}).enabled,false);assert.equal(s.updateModel('m',{enabled:false}).enabled,false)});

test('model registry keeps dashboard IDs separate from provider invocation IDs',()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  s.addProvider({id:'deepseek-claude-code',name:'DeepSeek',kind:'deepseek',enabled:true,config:{routable:true,apiKeyEnv:'DEEPSEEK_API_KEY'}});
  s.addModel({id:'deepseek:deepseek-flash',providerId:'deepseek-claude-code',name:'deepseek-flash',displayName:'DeepSeek V4.1 Flash',providerModelId:'deepseek-flash',invocationModelId:'deepseek-flash',capabilities:['planning'],quality:8,speed:10});
  const m=s.store.getModel('deepseek:deepseek-flash');
  assert.equal(m.providerModelId,'deepseek-flash');
  assert.equal(m.invocationModelId,'deepseek-flash');
  assert.equal(m.displayName,'DeepSeek V4.1 Flash');
});

test('provider pricing tiers persist in the model registry',()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  s.addProvider({id:'deepseek-claude-code',name:'DeepSeek',kind:'deepseek',enabled:true,config:{routable:true}});
  s.addModel({id:'deepseek:deepseek-flash',providerId:'deepseek-claude-code',name:'deepseek-flash',
    providerModelId:'deepseek-flash',invocationModelId:'deepseek-flash',displayName:'DeepSeek V4.1 Flash',
    capabilities:['planning'],inputCostPerMTok:.15,outputCostPerMTok:.6,cacheReadCostPerMTok:.003,
    peakInputCostPerMTok:.3,peakOutputCostPerMTok:1.2,peakCacheReadCostPerMTok:.006});
  const m=s.store.getModel('deepseek:deepseek-flash');
  assert.equal(m.peakInputCostPerMTok,.3);
  assert.equal(m.peakOutputCostPerMTok,1.2);
  assert.equal(m.peakCacheReadCostPerMTok,.006);
});

test('usage aggregates distinct providers per day',()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');
  const day=n=>new Date(Date.now()-n*86400000).toISOString();
  // Two providers on the older day, one of them again on the newer day, and a
  // fourth run that is a repeat of a provider already counted that day.
  const seed=[
    ['r1','prov-a',day(2)],['r2','prov-b',day(2)],
    ['r3','prov-a',day(1)],['r4','prov-a',day(1)],
  ];
  for(const [id,prov,startedAt] of seed)
    s.store.addRun({id,taskId:t.id,role:'implementer',providerId:prov,modelId:'m',status:'succeeded',startedAt});
  const u=s.usage('all');
  const byDay=Object.fromEntries(u.by_provider_day.map(d=>[d.day,d]));
  const d2=byDay[day(2).slice(0,10)],d1=byDay[day(1).slice(0,10)];
  assert.equal(d2.providers,2,'two distinct providers on the older day');
  assert.equal(d2.runs,2);
  assert.equal(d1.providers,1,'repeats on the same day count once');
  assert.equal(d1.runs,2,'but their runs all count');
  assert.deepEqual(u.by_provider_day.map(d=>d.day).slice().sort(),[...new Set([day(2).slice(0,10),day(1).slice(0,10)])].sort(),'series is ordered by day');
});

test('provider env does not leak ambient Anthropic routing into the child',()=>{
  const saved={...process.env};
  try{
    // What a user running Claude Code against a third-party endpoint has set.
    process.env.ANTHROPIC_API_KEY='ambient-key';
    process.env.ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic';
    process.env.ANTHROPIC_MODEL='deepseek-v4-flash';
    process.env.DEEPSEEK_API_KEY='deepseek-key';
    process.env.PATH=saved.PATH;

    // A subscription claude-code provider must see none of it, or it silently
    // bills the third-party API instead of the claude.ai login.
    const cc=childEnv(providerEnv({id:'anthropic-claude-code',kind:'claude-code',config:{}},{name:'claude-sonnet-5'}));
    assert.equal(cc.ANTHROPIC_API_KEY,undefined);
    assert.equal(cc.ANTHROPIC_BASE_URL,undefined);
    assert.equal(cc.ANTHROPIC_MODEL,undefined);
    assert.equal(cc.PATH,saved.PATH,'unrelated vars survive the scrub');

    // A deepseek provider supplies its own credentials, and they must win.
    const ds=childEnv(providerEnv({id:'deepseek-claude-code',kind:'deepseek',config:{apiKeyEnv:'DEEPSEEK_API_KEY'}},{name:'deepseek-v4-pro',invocationModelId:'deepseek-v4-pro'}));
    assert.equal(ds.ANTHROPIC_AUTH_TOKEN,'deepseek-key');
    assert.equal(ds.ANTHROPIC_BASE_URL,'https://api.deepseek.com/anthropic');
    assert.equal(ds.ANTHROPIC_MODEL,'deepseek-v4-pro','the registry model wins over the ambient one');
    assert.equal(ds.ANTHROPIC_API_KEY,undefined,'the provider uses a token, not an api key');
  }finally{
    for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
    Object.assign(process.env,saved);
  }
});

test('activity paging walks the journal without gaps or overlap',()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');
  s.store.addRun({id:'run-1',taskId:t.id,role:'implementer',providerId:'mock',modelId:'mock-strong',status:'running',startedAt:new Date().toISOString()});
  const COUNT=1200;
  for(let i=0;i<COUNT;i++)s.store.addEvent({runId:'run-1',type:'message',data:{i}});
  assert.equal(s.store.countTaskEvents(t.id),COUNT,'the count covers every event on the task');

  const tail=s.store.tailTaskEvents(t.id,500);
  assert.equal(tail.length,500,'the tail is capped at the window size');
  assert.equal(tail[499].data.i,COUNT-1,'the tail ends at the newest event');
  assert.ok(tail.every((e,idx)=>idx===0||e.id>tail[idx-1].id),'the tail is in ascending id order');

  const page=s.store.pageTaskEvents(t.id,tail[0].id,500);
  assert.equal(page.length,500);
  assert.equal(page[499].id,tail[0].id-1,'the page ends exactly where the tail begins');
  const rest=s.store.pageTaskEvents(t.id,page[0].id,500);
  assert.equal(rest.length,200,'the final page is short');
  assert.equal(rest[0].data.i,0,'paging reaches the oldest event');
  assert.equal(s.store.pageTaskEvents(t.id,rest[0].id,500).length,0,'paging past the start returns nothing');
});

test('thinking-token pings are dropped but the session id survives',async()=>{
  // The CLI emits one of these per few seconds for the whole run; they were 97%
  // of a 22k-event journal and carried no usage accounting.
  const script=[
    `console.log(JSON.stringify({type:'system',subtype:'thinking_tokens',session_id:'s1',estimated_tokens:3000}));`,
    `console.log(JSON.stringify({type:'assistant',session_id:'s1',message:{content:[{type:'text',text:'hi'}]}}));`,
  ].join('');
  const seen=[];
  for await(const ev of runProcess(process.execPath,['-e',script],{cwd:os.tmpdir(),env:process.env,role:'implementer'}))seen.push(ev);
  assert.ok(seen.some(e=>e.type==='message'),'the real event still reaches the journal');
  assert.equal(seen.some(e=>JSON.stringify(e).includes('thinking_tokens')),false,'the ping is dropped');
  assert.equal(seen.find(e=>e.type==='completed').data.sessionId,'s1','the session id is still captured for resume');
});

test('an api error reported on stdout is classified rather than flattened',async()=>{
  // The CLI reports API failures as a stdout result with exit 1 and an empty
  // stderr, so classifying on stderr alone recorded every 429 as AGENT_FAILURE.
  const script=`console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,api_error_status:429,result:'Rate limited'}));process.exit(1);`;
  let err=null;
  try{for await(const _ of runProcess(process.execPath,['-e',script],{cwd:os.tmpdir(),env:process.env,role:'implementer'})){}}catch(e){err=e}
  assert.ok(err,'the failed process surfaces an error');
  assert.equal(err.code,'RATE_LIMIT','classified from the stdout result, not the empty stderr');
  assert.match(err.message,/Rate limited/);
});

test('runProcess kills the child process when the signal aborts',async()=>{
  const ctrl=new AbortController();
  const gen=runProcess(process.execPath,['-e','setTimeout(()=>{},60000)'],{cwd:os.tmpdir(),env:process.env,role:'probe',signal:ctrl.signal});
  const started=Date.now();
  const drained=(async()=>{try{for await(const _ of gen){}}catch(e){return e}return null})();
  await new Promise(r=>setTimeout(r,400));
  const err=new Error('Cancelled by user');err.code='CANCELLED';ctrl.abort(err);
  const caught=await drained;
  assert.ok(caught,'abort surfaced as an error');
  assert.equal(caught.code,'CANCELLED');
  assert.ok(Date.now()-started<10000,`child killed in ${Date.now()-started}ms`);
});

test('role timeout aborts the agent and falls back to the next provider',async()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  s.updateProvider('mock',{enabled:false});
  const p=s.initProject('p',root);
  s.addProvider({id:'a-slow',name:'A-Slow',kind:'mock',enabled:true,config:{routable:true,delayMs:30000}});
  s.addProvider({id:'z-fast',name:'Z-Fast',kind:'mock',enabled:true,config:{routable:true}});
  s.addModel({id:'a-m',providerId:'a-slow',name:'a',capabilities:['planning'],speed:10,quality:12,cost:0,contextLength:100000});
  s.addModel({id:'z-m',providerId:'z-fast',name:'z',capabilities:['planning'],speed:10,quality:5,cost:0,contextLength:100000});
  const r=s.getRouting();s.saveRouting({...r,planner:{...r.planner,timeout:1}});
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  const started=Date.now();
  await s.plan(t.id);
  assert.ok(Date.now()-started<15000,`timeout fired instead of waiting 30s (${Date.now()-started}ms)`);
  const runs=s.store.listRuns(t.id);
  const failed=runs.find(x=>x.status==='failed');
  assert.ok(failed&&/TIMEOUT/.test(failed.error),'run recorded TIMEOUT');
  assert.equal(runs.filter(x=>x.status==='succeeded').length,1,'fell back to the next provider');
});

test('cancel aborts the running agent and leaves the task re-executable',async()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  s.updateProvider('mock',{enabled:false});
  const p=s.initProject('p',root);
  s.addProvider({id:'planner-ok',name:'Planner',kind:'mock',enabled:true,config:{routable:true}});
  s.addProvider({id:'worker-slow',name:'Worker',kind:'mock',enabled:true,config:{routable:true,delayMs:30000}});
  s.addModel({id:'planner-m',providerId:'planner-ok',name:'planner',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});
  s.addModel({id:'worker-m',providerId:'worker-slow',name:'worker',capabilities:['coding','review','repair'],speed:10,quality:10,cost:0,contextLength:100000});
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);
  const exec=s.execute(t.id).then(()=>null,e=>e);
  await new Promise(r=>setTimeout(r,400));
  assert.equal(s.task(t.id).state,'IMPLEMENTING');
  s.cancelTask(t.id);
  const err=await exec;
  assert.equal(err.code,'CANCELLED');
  assert.equal(s.store.listRuns(t.id).filter(r=>r.status==='cancelled').length,1);
  assert.equal(s.task(t.id).state,'APPROVED','reverts so the user can re-execute');
  assert.equal(s.store.getProviderHealthRow('worker-slow'),null,'cancel does not penalise the provider');
  assert.equal(s.providerHealthList().find(h=>h.providerId==='worker-slow').state,'HEALTHY');
});

test('failed runs keep their session id and only transient failures are resumable',async()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  s.updateProvider('mock',{enabled:false});
  const p=s.initProject('p',root);
  s.addProvider({id:'a-bad',name:'A-Bad',kind:'mock',enabled:true,config:{routable:true,failRoles:['implementer'],failCode:'RATE_LIMIT',sessionId:'sess-rate'}});
  s.addProvider({id:'b-ok',name:'B-Ok',kind:'mock',enabled:true,config:{routable:true}});
  s.addModel({id:'a-m',providerId:'a-bad',name:'a',capabilities:['planning','coding','review','repair'],speed:10,quality:12,cost:0,contextLength:100000});
  s.addModel({id:'b-m',providerId:'b-ok',name:'b',capabilities:['planning','coding','review','repair'],speed:10,quality:5,cost:0,contextLength:100000});
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);
  await s.execute(t.id);
  const runs=s.store.listRuns(t.id);
  const failed=runs.find(r=>r.status==='failed');
  assert.equal(failed.session_id,'sess-rate','failed run persists the session id the adapter reported');
  const resumed=s.store.listEvents(runs.find(r=>r.provider_id==='b-ok').id).find(e=>e.type==='completed');
  assert.equal(resumed.data.resumed,'sess-rate','the fallback attempt resumed that session');
  const t2=s.createTask(p.id,'y');
  s.store.addRun({id:'seed1',taskId:t2.id,role:'implementer',providerId:'a-bad',modelId:'a-m',status:'failed',startedAt:new Date().toISOString()});
  s.store.updateRun('seed1',{session_id:'sess-x',error:'RATE_LIMIT slow down'});
  assert.equal(s.resumeCandidate(s.task(t2.id),'implementer'),'sess-x');
  s.store.updateRun('seed1',{error:'AGENT_FAILURE boom'});
  assert.equal(s.resumeCandidate(s.task(t2.id),'implementer'),null,'agent failures start fresh');
  assert.equal(s.resumeCandidate(s.task(t2.id),'planner'),null,'planners never resume');
});

// -- run leases -------------------------------------------------------------
// A Store's constructor reaps stale runs. The CLI constructs a Service (and so a
// Store) at module load on every invocation, so an unconditional reap destroys the
// status of any agent the dashboard has in flight. Reaping is therefore gated on
// the lease: only runs nothing is heartbeating are dead.

function seedRun(s,t,id){s.store.addRun({id,taskId:t.id,role:'implementer',providerId:'a',modelId:'m',status:'running',startedAt:new Date().toISOString()});return id}

test('the run a task is live on comes from the lease, not from the status column',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true});
  const t=s.createTask(s.initProject('p',root).id,'x');
  seedRun(s,t,'live');
  s.store.heartbeat('live',t.id);
  const live=s.liveRun(t.id);
  assert.equal(live.runId,'live');
  assert.deepEqual(Object.keys(live).sort(),['fallbackFrom','modelId','providerId','role','runId','startedAt'],'a narrow shape: the runs list already carries the cost and the tokens');
  // Backdated past the staleness window, which is what a process that died mid-run
  // leaves behind: the row still says running and nothing holds the lease.
  s.store.db.prepare('UPDATE run_leases SET heartbeat_at=? WHERE run_id=?')
    .run(new Date(Date.now()-LEASE_STALE_MS-1000).toISOString(),'live');
  assert.equal(s.store.listRuns(t.id)[0].status,'running','the status column still claims it');
  assert.equal(s.liveRun(t.id),null,'and the lease is what decides');
  assert.equal(s.store.taskHasLiveRun(t.id),false,'one definition, so the two cannot disagree');
});

test('a run held by a fresh lease survives another process opening the store',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true});
  const t=s.createTask(s.initProject('p',root).id,'x');
  seedRun(s,t,'live');
  s.store.heartbeat('live',t.id);
  // This second construction is exactly what `ai-code task list` does while a run is live.
  const other=new Service(root,{allowMock:true});
  assert.equal(other.store.listRuns(t.id)[0].status,'running');
});

test('a running row nothing holds a lease for is reaped as interrupted',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true});
  const t=s.createTask(s.initProject('p',root).id,'x');
  seedRun(s,t,'orphan');
  const other=new Service(root,{allowMock:true});
  const r=other.store.listRuns(t.id)[0];
  assert.equal(r.status,'interrupted');
  assert.match(r.error,/interrupted/i);
});

test('a run whose heartbeat went quiet past the lease window is reaped',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true});
  const t=s.createTask(s.initProject('p',root).id,'x');
  seedRun(s,t,'stale');
  s.store.heartbeat('stale',t.id);
  s.store.db.prepare('UPDATE run_leases SET heartbeat_at=? WHERE run_id=?')
    .run(new Date(Date.now()-LEASE_STALE_MS-1000).toISOString(),'stale');
  const other=new Service(root,{allowMock:true});
  assert.equal(other.store.listRuns(t.id)[0].status,'interrupted','a lease past the staleness window no longer protects the run');
  assert.equal(other.store.db.prepare('SELECT count(*) c FROM run_leases WHERE run_id=?').get('stale').c,0,'the dead lease is cleared');
});

test('a cancel from another process stops the run and reverts the task',async()=>{
  const root=repo();
  // tickMs is short so the test measures the mechanism, not the 2s redraw interval.
  const s=new Service(root,{allowMock:true,silent:true,tickMs:100});
  s.updateProvider('mock',{enabled:false});
  const p=s.initProject('p',root);
  s.addProvider({id:'planner-ok',name:'Planner',kind:'mock',enabled:true,config:{routable:true}});
  s.addProvider({id:'worker-slow',name:'Worker',kind:'mock',enabled:true,config:{routable:true,delayMs:30000}});
  s.addModel({id:'planner-m',providerId:'planner-ok',name:'planner',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});
  s.addModel({id:'worker-m',providerId:'worker-slow',name:'worker',capabilities:['coding','review','repair'],speed:10,quality:10,cost:0,contextLength:100000});
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);

  const started=Date.now();
  const exec=s.execute(t.id).then(()=>null,e=>e);
  await new Promise(r=>setTimeout(r,300));

  // The owning process holds a lease, and the CLI in another process would find it.
  const other=new Service(root,{allowMock:true,silent:true});
  assert.equal(other.store.liveRunIds().length,1,'the running agent holds exactly one lease');
  other.cancelTask(t.id);
  assert.equal(other.store.cancelRequested(other.store.liveRunIds()[0]),true,'the cancel is durable, not in-process');

  const err=await exec;
  assert.equal(err.code,'CANCELLED');
  assert.equal(s.task(t.id).state,'APPROVED','the owner reverts the task it was driving');
  assert.ok(Date.now()-started<8000,'stopped within the tick window, not the 30s mock delay');
  assert.equal(s.store.liveRunIds().length,0,'the lease is released when the run ends');
});

// -- provider health ---------------------------------------------------------

// Two routable providers, the one named `bad` scoring higher. Both are real kinds
// (not mock) because mock providers are excluded from routing entirely.
function twoProviders(s,badConfig={}){
  s.addProvider({id:'good',name:'Good',kind:'claude-code',enabled:true,config:{routable:true}});
  s.addProvider({id:'bad',name:'Bad',kind:'claude-code',enabled:true,config:{routable:true,...badConfig}});
  s.addModel({id:'good-m',providerId:'good',name:'good',capabilities:['planning','coding','review','repair'],speed:10,quality:10,cost:0,contextLength:100000});
  s.addModel({id:'bad-m',providerId:'bad',name:'bad',capabilities:['planning','coding','review','repair'],speed:10,quality:12,cost:0,contextLength:100000});
  return s;
}

// Mirrors runRole's failure sequence exactly: open the run, close it as failed,
// then record the code against the provider. The breaker counts run rows, so the
// order matters and the error text has to be written before it is counted.
function failRun(s,providerId,code){
  const id=s.store.id();
  s.store.addRun({id,taskId:null,role:'implementer',providerId,modelId:'m',status:'running',startedAt:new Date().toISOString()});
  s.store.updateRun(id,{status:'failed',error:`${code} boom`,ended_at:new Date().toISOString()});
  s.recordFailure(providerId,code);
}

test('the breaker stops routing to a provider once its failures reach openAfter',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  assert.equal(s.select('planner').p.id,'bad','the higher-scoring provider wins while healthy');
  for(let i=0;i<s.healthThresholds().openAfter;i++) failRun(s,'bad','AGENT_FAILURE');
  assert.equal(s.store.getProviderHealthRow('bad').state,'OPEN');
  assert.equal(s.select('planner').p.id,'good','an open circuit is skipped');
});

test('a single failure degrades a provider below one it previously outranked',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  failRun(s,'bad','AGENT_FAILURE');
  assert.equal(s.store.getProviderHealthRow('bad').state,'DEGRADED');
  assert.equal(s.select('planner').p.id,'good','the penalty costs it the ranking');
  assert.equal(s.providerHealthList().find(h=>h.providerId==='bad').state,'DEGRADED');
});

test('a degraded provider heals after healAfter consecutive successes',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  failRun(s,'bad','AGENT_FAILURE');
  const heal=s.healthThresholds().healAfter;
  for(let i=0;i<heal-1;i++) s.recordSuccess('bad');
  assert.equal(s.store.getProviderHealthRow('bad').state,'DEGRADED','one short of the threshold stays degraded');
  s.recordSuccess('bad');
  assert.equal(s.store.getProviderHealthRow('bad').state,'HEALTHY');
  assert.equal(s.select('planner').p.id,'bad','back in front once healthy');
});

test('a failure that is not the provider\'s fault leaves its health alone',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  // Three over-length prompts say nothing about the provider, so they must not
  // open a circuit however many of them arrive.
  for(let i=0;i<5;i++) failRun(s,'bad','CONTEXT_TOO_LARGE');
  for(let i=0;i<5;i++) failRun(s,'bad','MODEL_UNAVAILABLE');
  assert.equal(s.store.getProviderHealthRow('bad'),null,'no row is written at all');
  assert.equal(s.select('planner').p.id,'bad');
});

test('auth failure opens the circuit on the first attempt',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  failRun(s,'bad','AUTH_FAILURE');
  const h=s.store.getProviderHealthRow('bad');
  assert.equal(h.state,'OPEN');
  assert.ok(Date.parse(h.cooldown_until)-Date.now()>30*60*1000,'an hour, not the default cooldown');
  assert.equal(s.select('planner').p.id,'good');
});

test('a rate limit holds a provider back without opening the circuit',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  failRun(s,'bad','RATE_LIMIT');
  assert.equal(s.store.getProviderHealthRow('bad').state,'DEGRADED','never OPEN, however often it is rate limited');
});

test('a lapsed cooldown is resolved on read, with no process running',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  for(let i=0;i<s.healthThresholds().openAfter;i++) failRun(s,'bad','AGENT_FAILURE');
  // Backdate the cooldown rather than waiting two minutes for it.
  s.store.db.prepare('UPDATE provider_health SET cooldown_until=? WHERE provider_id=?')
    .run(new Date(Date.now()-1000).toISOString(),'bad');
  const h=s.providerHealthList().find(x=>x.providerId==='bad');
  assert.equal(h.state,'DEGRADED','open becomes degraded once its cooldown lapses');
  assert.equal(h.eligible,true);
  assert.ok(h.penalty>0);
});

test('the last resort still routes when every provider is open',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  for(const id of ['bad','good']) for(let i=0;i<s.healthThresholds().openAfter;i++) failRun(s,id,'AGENT_FAILURE');
  assert.equal(s.eligible('planner').length,0,'health blocks them all');
  assert.deepEqual(s.providerHealthList().filter(h=>h.providerId!=='mock').map(h=>h.state),['OPEN','OPEN']);
  const chosen=s.select('planner');
  assert.equal(chosen.p.id,'bad','the best-scoring open provider is retried rather than failing outright');
  assert.equal(chosen.healthForced,true);
});

test('a provider test never counts toward the breaker',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  // The Test connection button is the user inspecting the breaker; it must not be
  // able to trip it.
  for(let i=0;i<10;i++){
    const id=s.store.id();
    s.store.addRun({id,taskId:null,role:'provider-test',providerId:'bad',modelId:'bad-m',status:'running',startedAt:new Date().toISOString()});
    s.store.updateRun(id,{status:'failed',error:'AGENT_FAILURE boom',ended_at:new Date().toISOString()});
  }
  assert.equal(s.store.countRecentFailures('bad',new Date(Date.now()-3600000).toISOString()),0);
  assert.equal(s.store.getProviderHealthRow('bad'),null);
});

test('a passing connection test clears the circuit it disproves',async()=>{
  // The second half of the incident. The key had been corrected and DeepSeek's circuit
  // still stood OPEN for its full hour, and nothing could shorten it: every run in the
  // meantime was refused by the health check before it reached the provider, so the one
  // piece of evidence that could have moved it was a passing test - and the Test button
  // wrote nothing. A human saying "I fixed this" is a different claim from a run that
  // happened to succeed, which is why afterSuccess() declines to lift an OPEN row.
  const root=repo();
  const s=new Service(root,{allowMock:true});
  s.addProvider({id:'p',name:'Provider',kind:'mock',enabled:true,config:{routable:true}});
  s.addModel({id:'p-m',providerId:'p',name:'p-m',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});
  failRun(s,'p','AUTH_FAILURE');
  assert.equal(s.store.getProviderHealthRow('p').state,'OPEN');
  // Asked of the health list rather than of eligible(), because a mock provider is
  // never routable whatever its health - this is the gate, not the routing table.
  assert.equal(s.providerHealthList().find(x=>x.providerId==='p').eligible,false,'an open circuit takes the provider out of routing');

  // The provider is a mock, so the test really runs and really passes.
  const r=await s.testProvider('p','p-m');
  assert.equal(r.ok,true);
  assert.equal(r.cleared,'OPEN','the result names what it lifted, so the card can say so');

  const after=s.store.getProviderHealthRow('p');
  assert.equal(after.state,'HEALTHY');
  assert.equal(after.cooldown_until,null,'the cooldown is what routing reads, so it has to go');
  assert.equal(after.opened_at,null);
  assert.equal(after.last_error,'AUTH_FAILURE','what opened it stays on the record; it is just not what routing reads');
  const h=s.providerHealthList().find(x=>x.providerId==='p');
  assert.equal(h.eligible,true);
  assert.equal(h.penalty,0);
  // Still on the record, and deliberately: a provider that is genuinely still broken
  // re-opens its circuit on the next real run rather than hiding behind a passing test.
  // The code is named because the default window holds only the count-policy codes, and
  // AUTH_FAILURE opens a circuit on its own without needing a count.
  assert.equal(s.store.countRecentFailures('p',new Date(Date.now()-3600000).toISOString(),['AUTH_FAILURE']),1);
  assert.equal(s.providerHealthList().find(x=>x.providerId==='p').eligible,true,'and the gate lets it through again');
});

test('a connection test that fails leaves the circuit exactly where it was',async()=>{
  // The other half of the asymmetry. A failing test is not evidence about the provider:
  // the key may be wrong, but so may the machine's network, and only a real run
  // separates those. So the button moves the breaker in one direction only.
  const root=repo();
  const s=new Service(root,{allowMock:false});
  s.addProvider({id:'ds',name:'DeepSeek',kind:'deepseek',enabled:true,config:{routable:true,apiKeyEnv:'AICODE_TEST_KEY_THAT_IS_NEVER_SET'}});
  s.addModel({id:'ds-m',providerId:'ds',name:'ds-m',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});
  failRun(s,'ds','AUTH_FAILURE');
  const opened=s.store.getProviderHealthRow('ds');
  assert.equal(opened.state,'OPEN');

  const r=await s.testProvider('ds','ds-m');
  assert.equal(r.ok,false);
  assert.equal(r.code,'AUTH_FAILURE','the test reports the real fault');
  assert.equal(r.cleared,undefined,'and clears nothing, so the view has nothing to announce');
  assert.deepEqual(s.store.getProviderHealthRow('ds'),opened,'the row is what it was, cooldown and all');
  // The failing test run is not counted, even with the code named - which is the only
  // shape of this assertion that means anything, since the default window excludes it
  // by policy rather than by design.
  assert.equal(s.store.countRecentFailures('ds',new Date(Date.now()-3600000).toISOString(),['AUTH_FAILURE']),1,'only the real run is in the window');
});

test('health thresholds from routing.json override the defaults',()=>{
  const root=repo();
  const s=twoProviders(new Service(root,{allowMock:true}));
  s.saveRouting({...s.getRouting(),health:{openAfter:1}});
  const t=new Service(root,{allowMock:true});
  failRun(t,'bad','AGENT_FAILURE');
  assert.equal(t.store.getProviderHealthRow('bad').state,'OPEN','one failure is enough under a lowered threshold');
});

// -- model capabilities ------------------------------------------------------

test('a basic-reasoning model is never selected to plan',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true});
  s.addProvider({id:'a',name:'A',kind:'claude-code',enabled:true,config:{routable:true}});
  s.addModel({id:'sharp',providerId:'a',name:'sharp',capabilities:['planning','review'],reasoning:'frontier',speed:10,quality:10,cost:0,contextLength:100000});
  s.addModel({id:'dull',providerId:'a',name:'dull',capabilities:['planning','review'],reasoning:'basic',speed:10,quality:20,cost:0,contextLength:100000});
  assert.equal(s.select('planner').m.id,'sharp','planning needs strong reasoning, whatever the quality score says');
  assert.equal(s.select('reviewer').m.id,'sharp','review needs moderate');
});

test('a model that cannot use tools is never selected to implement or repair',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true});
  s.addProvider({id:'a',name:'A',kind:'claude-code',enabled:true,config:{routable:true}});
  s.addModel({id:'chatty',providerId:'a',name:'chatty',capabilities:['planning','coding','repair'],reasoning:'frontier',toolUse:false,speed:10,quality:10,cost:0,contextLength:100000});
  s.addModel({id:'worker',providerId:'a',name:'worker',capabilities:['coding','repair'],reasoning:'moderate',toolUse:true,speed:10,quality:5,cost:0,contextLength:100000});
  assert.equal(s.select('implementer').m.id,'worker');
  assert.equal(s.select('repair').m.id,'worker');
  assert.equal(s.select('planner',[]).m.id,'chatty','a tool-less model is still fine where tools are forbidden anyway');
});

test('a row with no reasoning or tool flags keeps routing as it always did',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true});
  s.addProvider({id:'a',name:'A',kind:'claude-code',enabled:true,config:{routable:true}});
  // No reasoning, no toolUse: exactly the shape of a row written before those
  // columns existed. Unknown must mean permissive, never "refuse everything".
  s.addModel({id:'legacy',providerId:'a',name:'legacy',capabilities:['planning','coding','review','repair'],speed:10,quality:10,cost:0,contextLength:100000});
  for(const role of ['planner','implementer','reviewer','repair']) assert.equal(s.select(role).m.id,'legacy',role);
});

test('an oversized prompt skips the small model and picks one that can hold it',async()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true});
  s.updateProvider('mock',{enabled:false});
  // One provider, two models. The better-scoring one sorts first and has a context
  // window the assembled prompt cannot fit into, so the run has to fall through to
  // the other model on the same provider - which is what proves the skip is
  // per-model rather than taking the whole provider out.
  s.addProvider({id:'a-small',name:'Small',kind:'mock',enabled:true,config:{routable:true}});
  s.addModel({id:'a-small-m',providerId:'a-small',name:'a-small-model',capabilities:['planning'],reasoning:'frontier',speed:10,quality:20,cost:0,contextLength:100});
  s.addModel({id:'b-roomy-m',providerId:'a-small',name:'b-roomy-model',capabilities:['planning'],reasoning:'frontier',speed:10,quality:5,cost:0,contextLength:1000000});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'plan something');s.prepare(t.id);await s.plan(t.id);
  const runs=s.store.listRuns(t.id);
  const skipped=runs.find(r=>r.model_id==='a-small-m');
  assert.ok(skipped,'the too-small model was tried');
  assert.equal(skipped.status,'failed');
  assert.match(skipped.error,/CONTEXT_TOO_LARGE/);
  assert.equal(runs.find(r=>r.model_id==='b-roomy-m').status,'succeeded','the model that fits did the work on the same provider');
  const health=s.providerHealthList().find(h=>h.providerId==='a-small');
  assert.equal(health.state,'HEALTHY',"an oversized prompt is not the provider's fault");
  assert.equal(health.failures,0,'and it is not in the breaker window either');
});

// -- context engine ----------------------------------------------------------

// A fixture repo with known files and known dependencies, so the ranking and the
// manifest readers can be checked against a hand-written expectation.
function depsRepo(){
  const d=repo();
  fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({
    scripts:{test:'node -e "process.exit(0)"'},
    dependencies:{express:'^4.19.0'},
    devDependencies:{vitest:'^2.0.0'},
  },null,2));
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.mkdirSync(path.join(d,'tests'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','router.mjs'),'export function route(){}\n');
  fs.writeFileSync(path.join(d,'src','unrelated.mjs'),'export const x=1;\n');
  fs.writeFileSync(path.join(d,'tests','router.test.mjs'),'import {route} from "../src/router.mjs";\n');
  fs.writeFileSync(path.join(d,'requirements.txt'),'flask>=2.0\n# comment\nrequests\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','fixture'],{cwd:d});
  return d;
}

test('dependencies.json records every manifest, with the dev flag',()=>{
  const root=depsRepo();
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  s.contextInit(p.id);
  const deps=JSON.parse(fs.readFileSync(path.join(root,'.ai-code','context','dependencies.json'),'utf8'));
  const byName=Object.fromEntries(deps.map(d=>[d.name,d]));
  assert.equal(byName.express.ecosystem,'node');
  assert.equal(byName.express.dev,false,'a runtime dependency is not dev');
  assert.equal(byName.vitest.dev,true,'a devDependency is');
  assert.equal(byName.flask.version,'>=2.0');
  assert.equal(byName.requests.version,null,'a bare requirement has no version');
  assert.equal(deps.filter(d=>d.name==='flask').length,1,'no duplicates');
});

test('relevantFiles ranks the file the task named first and brings its test along',()=>{
  const root=depsRepo();
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  const picked=relevantFiles(p,{title:'fix the router',description:'the router drops routes',plan:null},{cwd:root});
  assert.equal(picked.paths[0],'src/router.mjs','the named file is first');
  assert.ok(picked.paths.includes('tests/router.test.mjs'),'its test comes with it');
  // Recency alone earns a file a place in the list, which is deliberate: a file
  // git touched recently is a plausible place for the change. What the ranking
  // must guarantee is the order, not that unmentioned files are absent.
  assert.ok(picked.paths.indexOf('src/router.mjs')<picked.paths.indexOf('src/unrelated.mjs'),'and outranks a file only recency scored');
});

test('the assembled context respects the budget and reports what it cost',()=>{
  const root=depsRepo();
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  const task={id:'t',title:'fix the router',description:'router',plan:null};
  // Measured rather than hardcoded: a fixture repo is too small to have a natural
  // budget, and a literal one would silently stop exercising the trim path the day
  // a fixture file grows. Half of what the context costs guarantees the trim runs.
  const roomy=buildTaskContext(p,task,{role:'planner',config:contextConfig({budget:1e9,files:10})});
  assert.equal(roomy.manifest.trimmed.length,0,'nothing is dropped when the budget is ample');
  const budget=Math.max(200,Math.floor(roomy.manifest.tokens/2));
  const built=buildTaskContext(p,task,{role:'planner',config:contextConfig({budget,files:10})});
  assert.ok(built.manifest.tokens<=budget,`${built.manifest.tokens} tokens fits the ${budget} budget`);
  assert.ok(built.manifest.trimmed.length>0,'files were dropped to fit');
  assert.equal(built.manifest.budget,budget);
  assert.ok(built.manifest.files.length<10,'the file cap is respected');
});

test('an acronym run splits off the word that follows it',()=>{
  const root=repo();
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src','http.mjs'),'export const h=1;\n');
  fs.writeFileSync(path.join(root,'src','server.mjs'),'export const s=1;\n');
  fs.writeFileSync(path.join(root,'src','unrelated.mjs'),'export const u=1;\n');
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  const picked=relevantFiles(p,{title:'fix HTTPServer',description:'',plan:null},{cwd:root});
  // Without the acronym rule the identifier is one token, `httpserver`, which
  // matches neither file: the task names the thing and the ranking cannot see it.
  assert.ok(picked.paths.includes('src/http.mjs'),'`http` was recovered from the acronym run');
  assert.ok(picked.paths.includes('src/server.mjs'),'and `server` from the word after it');
  // `server.mjs` ranks first, by three points, because `ENTRY_POINT` matches it.
  // Both files did recover their term; that is what the split is being tested for.
  const score=Object.fromEntries(picked.scores.map(f=>[f.path,f.score]));
  assert.equal(score['src/http.mjs'],10,'the acronym run scored as a basename hit');
  assert.equal(score['src/server.mjs'],13,'and the word after it scored, plus the entry-point bonus');
});

test('ties break on code point, not on the ICU locale',()=>{
  const root=repo();
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src','Zebra.mjs'),'export const z=1;\n');
  fs.writeFileSync(path.join(root,'src','apple.mjs'),'export const a=1;\n');
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  const picked=relevantFiles(p,{title:'zebra apple',description:'',plan:null},{cwd:root});
  // Both files match their own word and nothing distinguishes them, which is the
  // normal case here: on the measured repo 59 files tied on one score. A locale
  // sort puts `apple` first; a code-point sort puts `Zebra` first, because `Z` is
  // 0x5A and `a` is 0x61. The whole tie group is checked, so the assertion holds
  // however many files the fixture grows to.
  const top=picked.scores[0].score;
  const tied=picked.scores.filter(f=>f.score===top).map(f=>f.path);
  assert.ok(tied.length>1,`the fixture actually produces a tie (${tied.length} files at ${top})`);
  assert.deepEqual(tied,[...tied].sort(),'the tie group is in code-point order, uppercase first');
  assert.equal(picked.paths[0],'src/Zebra.mjs');
});

test('a lockfile and a minified bundle stay in the tree but never take a slot',()=>{
  const root=repo();
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({name:'x',lockfileVersion:3,packages:{}}));
  fs.writeFileSync(path.join(root,'src','package-export.mjs'),'export const x=1;\n');
  fs.writeFileSync(path.join(root,'bundle.min.js'),'!function(){var a=1}();\n');
  execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','noise'],{cwd:root});
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  // Every one of these names is a term in the task, so all four score on the
  // stem: without the gate the lockfile and the bundle rank alongside the real
  // source and one of them takes a slot.
  const task={id:'t',title:'package bundle export',description:'',plan:null};
  const picked=relevantFiles(p,task,{cwd:root});
  assert.ok(!picked.paths.includes('package-lock.json'),'the lockfile never takes a slot');
  assert.ok(!picked.paths.includes('bundle.min.js'),'nor a minified bundle');
  assert.ok(picked.paths.includes('src/package-export.mjs'),'while the real source still does');
  const built=buildTaskContext(p,task,{role:'planner'});
  assert.ok(built.tree.includes('package-lock.json'),'but the tree still lists it, so the agent can find it');
});

test('vendored and editor directories are dropped at the walk',()=>{
  const root=repo();
  fs.mkdirSync(path.join(root,'vendor','lib'),{recursive:true});
  fs.writeFileSync(path.join(root,'vendor','lib','thing.mjs'),'export const v=1;\n');
  fs.mkdirSync(path.join(root,'.idea'));
  fs.writeFileSync(path.join(root,'.idea','project.xml'),'<x/>\n');
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  const built=buildTaskContext(p,{id:'t',title:'the thing',plan:null},{role:'planner'});
  assert.ok(!built.tree.some(f=>f.startsWith('vendor/')),'a vendored tree is somebody else\'s code and out-scores real source');
  assert.ok(!built.tree.some(f=>f.startsWith('.idea/')),'and editor state is not part of the repository');
});

test('an oversized single file is reduced to its path rather than sent over budget',()=>{
  const root=repo();
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src','gigantic.mjs'),'export const a=1;\n'.repeat(20000));
  fs.writeFileSync(path.join(root,'src','other.mjs'),'export const o=1;\n');
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  const built=buildTaskContext(p,{id:'t',title:'fix gigantic',plan:null},{role:'planner'});
  // The file cap bounds one file at 3000 tokens, so a budget below that used to be
  // unreachable: the ladder stops popping at the last file and sends the overflow
  // anyway. It is now reduced to a path, which is what `readForPrompt` already
  // does for a binary or an unreadable file.
  const budget=Math.max(60,Math.floor(built.manifest.tokens/4));
  const tight=buildTaskContext(p,{id:'t',title:'fix gigantic',plan:null},{role:'planner',config:contextConfig({budget})});
  assert.ok(tight.manifest.tokens<=budget,`${tight.manifest.tokens} tokens fits the ${budget} budget`);
  const big=tight.files.find(f=>f.path==='src/gigantic.mjs');
  assert.ok(big,'the file the task named is still named');
  assert.equal(big.text,null,'with no body, rather than a body that blows the budget');
  assert.ok(tight.manifest.trimmed.some(t=>/path only/.test(t)),'and the manifest says it was reduced');
});

test('an unreadable directory degrades the ranking instead of failing the run',(t)=>{
  if(process.getuid?.()===0)return t.skip('root ignores directory permissions');
  // The key is additive, so an ordinary repository still assembles a manifest with
  // no trace of it. Checked on its own repo, before anything is locked.
  const open=repo();
  const so=new Service(open,{allowMock:true});
  const po=so.initProject('p',open);
  assert.equal(buildTaskContext(po,{id:'t',title:'x',plan:null},{role:'planner'}).manifest.unreadable,undefined,'a clean walk records nothing at all');
  const root=repo();
  const locked=path.join(root,'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked,'secret.mjs'),'export const s=1;\n');
  fs.chmodSync(locked,0o000);
  try{
    const s=new Service(root,{allowMock:true});
    const p=s.initProject('p',root);
    const built=buildTaskContext(p,{id:'t',title:'touch secret',plan:null},{role:'planner'});
    // The distinction that matters: a ranking that saw less than the repository
    // must not look like a small repository.
    assert.deepEqual(built.manifest.unreadable,['locked'],'the walk records what it could not read');
    assert.ok(!built.tree.some(f=>f.startsWith('locked/')),'and lists nothing under it');
  } finally { fs.chmodSync(locked,0o755); }
});

test('a tool path is normalised across the three shapes the database holds',()=>{
  const root='/repo';
  assert.equal(normalisePath('src/a.mjs',root),'src/a.mjs','project-relative');
  assert.equal(normalisePath('/repo/src/a.mjs',root),'src/a.mjs','absolute in the project');
  assert.equal(
    normalisePath('/x/.ai-code-worktrees-ai-code/0123abcd-0000-4000-8000-000000000000/src/a.mjs',root),
    'src/a.mjs','absolute in a per-task worktree, which names the same file as the first two'
  );
  // Neither of these is a file in the project: a Grep records the root, and a
  // path outside the tree is not something the ranking could ever be scored on.
  assert.equal(normalisePath('/repo',root),null,'the repository root is not a file');
  assert.equal(normalisePath('/elsewhere/a.mjs',root),null,'nor is a path outside it');
});

test('gold is what the planner read, not what it searched',()=>{
  const events=[{data:{message:{content:[
    {type:'tool_use',name:'Read',input:{file_path:'/repo/src/a.mjs'}},
    {type:'tool_use',name:'NotebookRead',input:{notebook_path:'/repo/n.ipynb'}},
    {type:'tool_use',name:'Grep',input:{path:'/repo/tests'}},
    {type:'tool_use',name:'Glob',input:{path:'/repo'}},
    {type:'tool_use',name:'Bash',input:{command:'ls'}},
    {type:'text',text:'a reply is not a tool call'},
  ]}}}];
  assert.deepEqual([...goldFromEvents(events,'/repo')],['src/a.mjs','n.ipynb']);
  // Events that are not the shape this reads are skipped, not fatal: a stream
  // carries frames of several kinds and only some of them are tool calls.
  assert.deepEqual([...goldFromEvents([{data:null},{data:{message:{content:'x'}}},{}],'/repo')],[]);
});

test('a score case counts what the ranking found and flags a capped window',()=>{
  const s=scoreCase(['a','b','c','d','e'],['a','c','zz'],5);
  assert.equal(s.hits,2,'two of the three answers are in the window');
  assert.equal(s.gold,3);
  assert.equal(s.recall,2/3);
  assert.equal(s.mrr,1,'the first answer is at the top');
  // Binary gain: DCG = 1/log2(2) + 1/log2(4), ideal = the three hits packed in.
  const ideal=1/Math.log2(2)+1/Math.log2(3)+1/Math.log2(4);
  assert.ok(Math.abs(s.ndcg-(1+0.5)/ideal)<1e-12);
  assert.equal(s.capped,false);

  // A gold set larger than the window cannot score above k/|gold|, whatever the
  // ranking does: both answers are in the window and the recall is still a half.
  // The flag is what keeps that out of the mean.
  const capped=scoreCase(['a','b','c'],['a','b','c','d'],2);
  assert.equal(capped.capped,true);
  assert.equal(capped.hits,2);
  assert.equal(capped.recall,0.5);
});

test('an empty gold set is no measurement rather than a perfect score',()=>{
  const s=scoreCase(['a'],[],15);
  assert.equal(s.recall,null,'a run that read nothing is not a run that ranked perfectly');
  assert.equal(s.ndcg,0);
  assert.equal(s.mrr,0);
});

test('the summary separates the two recalls and keeps capped runs out of both',()=>{
  const mk=(gold,hits,capped,gone=[])=>({gold,hits,capped,recall:hits/gold,mrr:0,ndcg:0,case:{gone}});
  const s=summarise([mk(2,2,false),mk(4,1,false),mk(20,10,true,['a/deleted.mjs'])]);
  // Macro is the mean of per-run recalls, so the run with two answers moves it as
  // much as the run with four. Micro pools the answers and describes the corpus.
  assert.equal(s.recallMacro,(1+0.25)/2);
  assert.equal(s.recallMicro,3/6);
  assert.equal(s.recallRuns,2);
  assert.equal(s.capped,1);
  // What the ranking never offered, which is the part of recall it owns: a file
  // that was offered and then read is partly a fact about the prompt.
  assert.equal(s.unoffered,3);
  assert.equal(s.gone,1,'an answer naming a file the repository no longer has is counted, not scored');
});

test('the harness mines a gold set from a run and scores the ranker against it',()=>{
  const root=depsRepo();
  const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'fix the router');
  // The run and its reads are written directly. What the harness reads is the
  // events table, so how a run came to write them is not part of the question.
  s.store.addRun({id:'r1',taskId:t.id,role:'planner',providerId:'x',modelId:'m',status:'succeeded',startedAt:new Date().toISOString()});
  s.store.addEvent({runId:'r1',type:'stream',data:{message:{content:[{type:'tool_use',name:'Read',input:{file_path:'src/router.mjs'}}]}}});
  const cases=plannerCases(s.store,{id:p.id,path:root});
  assert.equal(cases.length,1,'one planner run is one case');
  assert.equal(cases[0].taskId,t.id);
  assert.deepEqual(cases[0].gold,['src/router.mjs']);
  const {summary,rows}=evaluate({id:p.id,path:root},cases);
  assert.equal(summary.runs,1);
  assert.equal(rows[0].hits,1,'the ranker offers the file the planner read');
  assert.equal(rows[0].recall,1);
  assert.equal(summary.recallMicro,1);
});

test('the implementer is given its own worktree, not the main checkout',async()=>{
  const root=depsRepo();
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'touch the router');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);
  const worktree=createWorktree(root,'phase-a-probe');
  const built=buildTaskContext(p,{...s.task(t.id),plan:'do it'},{role:'implementer',cwd:worktree.dir});
  assert.equal(built.project.path,worktree.dir,'the context points at the worktree the agent runs in');
  assert.notEqual(built.project.path,root);
  assert.ok(built.files.some(f=>f.path==='src/router.mjs'),'and reads the worktree copies');
  // The generated docs live in the main checkout: .ai-code is excluded from git,
  // so a fresh worktree does not have them.
  fs.mkdirSync(path.join(root,'.ai-code','context'),{recursive:true});
  fs.writeFileSync(path.join(root,'.ai-code','context','conventions.md'),'Always write tests.');
  const again=buildTaskContext(p,{...s.task(t.id),plan:'do it'},{role:'implementer',cwd:worktree.dir});
  assert.equal(again.conventions,'Always write tests.','the docs still come from the main checkout');
});

test('context usage is recorded on the run row and totalled in usage()',async()=>{
  const root=depsRepo();
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'touch the router');s.prepare(t.id);await s.plan(t.id);
  const run=s.store.listRuns(t.id).find(r=>r.role==='planner');
  assert.ok(run.context_tokens>0,'the run records what the prompt cost');
  assert.ok(run.context_budget>0,'and the budget it was measured against');
  assert.equal(JSON.parse(s.task(t.id).context).budget,s.contextConfig().budget,'prepare() stores the manifest');
  const u=s.usage('all');
  assert.ok(u.totals.context_tokens>=run.context_tokens,'usage totals the context tokens');
  assert.ok(u.by_role.find(r=>r.role==='planner').context_tokens>0,'and breaks them down by role');
});

// -- parallel execution ------------------------------------------------------

// A project with `count` mock workers, each willing to take one agent at a time.
// Two of them are what makes a global cap of two reachable at all, and the
// per-provider cap is what routes the second concurrent job to the second worker.
async function queueable(s,root,ids=['w1','w2'],delayMs=250){
  const p=s.initProject('p',root);
  for(const id of ids){
    s.addProvider({id,name:id,kind:'mock',enabled:true,config:{routable:true,delayMs,maxConcurrency:1}});
    s.addModel({id:`${id}-m`,providerId:id,name:id,capabilities:['planning','coding','review','repair'],speed:10,quality:10,cost:0,contextLength:100000});
  }
  const tasks=[];
  for(let i=0;i<3;i++){const t=s.createTask(p.id,`task ${i}`);s.prepare(t.id);await s.plan(t.id);s.approve(t.id);tasks.push(t.id);}
  return tasks;
}

const until=async(fn,ms=20000)=>{
  const end=Date.now()+ms;
  while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,20));}
  throw new Error('timed out waiting for the queue to drain');
};

test('the queue runs no more jobs at once than its providers allow',async()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true,tickMs:60});
  const tasks=await queueable(s,root);
  const runner=new Runner(s,{maxConcurrency:2,log:()=>{}});
  s.runner=runner;
  assert.equal(runner.limit(),2,'three providers at one each are capped by the queue at two');

  const jobs=tasks.map(id=>runner.enqueue(id));
  let peak=0;
  const watch=setInterval(()=>{peak=Math.max(peak,runner.running.size)},5);
  await until(()=>runner.running.size===0&&runner.queued.length===0);
  clearInterval(watch);

  assert.equal(peak,2,'the cap holds: three jobs, never three at once');
  for(const j of jobs)assert.equal(runner.store.getJob(j.id).state,'succeeded');
});

test('a provider at its own limit is not a candidate for the next run',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:false});
  const p=s.initProject('p',root);
  // Real routing, and no agent is ever spawned: `eligible` is a pure query, so the
  // gate can be checked without a provider that can actually run anything.
  for(const id of ['a','b']){
    s.addProvider({id,name:id,kind:'claude-code',enabled:true,config:{routable:true,maxConcurrency:1}});
    s.addModel({id:id+'-m',providerId:id,name:id,capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:200000});
  }
  const runner=new Runner(s,{maxConcurrency:2,log:()=>{}});
  s.runner=runner;
  assert.equal(s.eligible('planner').length,2,'both providers are free');

  // An agent mid-run on `a`, claimed the way runRole claims one: a run row and a
  // live lease. Its own slot is what should take it out of the running.
  const t=s.createTask(p.id,'x');
  s.store.addRun({id:'live-run',taskId:t.id,role:'planner',providerId:'a',modelId:'a-m',status:'running',startedAt:new Date().toISOString()});
  s.store.heartbeat('live-run',t.id);
  assert.equal(runner.atCapacity(s.store.getProvider('a')),true);
  const rows=s.eligible('planner');
  assert.equal(rows.length,1,'the busy provider drops out of the ranking');
  assert.equal(rows[0].p.id,'b');
  assert.equal(s.eligible('planner',[],{ignoreHealth:true})[0].p.id,'b','the last-resort path respects the limit too');
  assert.equal(s.eligible('planner',[],{ignoreHealth:true}).length,1,'and does not quietly readmit the busy one');
});

test('a task with a job already queued cannot be queued twice',async()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true,tickMs:60});
  const tasks=await queueable(s,root);
  const runner=new Runner(s,{maxConcurrency:1,log:()=>{}});
  s.runner=runner;
  runner.enqueue(tasks[0]);
  assert.throws(()=>runner.enqueue(tasks[0]),/already has a job/,'the partial unique index is the guard');
  await until(()=>runner.running.size===0&&runner.queued.length===0);
  // Once it finishes, the same task is queueable again: history does not block.
  const t1=s.createTask(s.store.listProjects()[0].id,'later');s.prepare(t1.id);await s.plan(t1.id);s.approve(t1.id);
  assert.ok(runner.enqueue(t1.id).id);
});

test('a job left running by a dead server is recovered as interrupted',()=>{
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true});
  s.store.addJob({id:'stale-job',taskId:'t1',kind:'execute',state:'running',createdAt:new Date().toISOString()});
  const runner=new Runner(s,{log:()=>{}});
  assert.equal(runner.store.getJob('stale-job').state,'interrupted','the queue is in-process, so a fresh one owns nothing');
  assert.equal(runner.store.activeJobs().length,0);
});

test('peak pricing follows the model\'s rates, not its provider id',()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  // A renamed provider id is the whole point: the old check keyed off the literal
  // string 'deepseek-claude-code', so this provider used to lose its peak tier.
  s.addProvider({id:'gateway-renamed',name:'DeepSeek via Claude Code',kind:'deepseek',enabled:true,config:{routable:true}});
  s.addModel({id:'tiered',providerId:'gateway-renamed',name:'tiered',capabilities:['planning'],billingMode:'api',
    inputCostPerMTok:1,outputCostPerMTok:1,peakInputCostPerMTok:2,peakOutputCostPerMTok:2});
  // No peak rates means no peak tier, however it is billed.
  s.addModel({id:'flat',providerId:'gateway-renamed',name:'flat',capabilities:['planning'],billingMode:'api',
    inputCostPerMTok:1,outputCostPerMTok:1});
  const usage={inputTokens:1000000,outputTokens:0};
  // 2026-09-23 is a Wednesday; 07:00 UTC is inside the 06:00-10:00 peak window.
  const peak=s.price(s.store.getModel('tiered'),usage,'2026-09-23T07:00:00Z');
  const off=s.price(s.store.getModel('tiered'),usage,'2026-09-23T12:00:00Z');
  assert.equal(peak.basis,'published-api-rate-peak');
  assert.equal(peak.cost,2);
  assert.equal(off.basis,'published-api-rate-off-peak');
  assert.equal(off.cost,1);
  assert.equal(s.price(s.store.getModel('flat'),usage,'2026-09-23T07:00:00Z').basis,'published-api-rate');
});

test('a run another process holds counts against the provider limit',()=>{
  const root=repo();
  const a=new Service(root,{allowMock:true});
  const p=a.initProject('p',root);
  a.addProvider({id:'gateway',name:'Gateway',kind:'claude-code',enabled:true,config:{routable:true,maxConcurrency:1}});
  a.addModel({id:'gateway:m',providerId:'gateway',name:'m',capabilities:['planning'],speed:10,quality:10,cost:0});
  const t=a.createTask(p.id,'x');
  // Claimed exactly as runRole claims one: a run row plus a live lease.
  a.store.addRun({id:'r1',taskId:t.id,role:'planner',providerId:'gateway',modelId:'gateway:m',status:'running',startedAt:new Date().toISOString()});
  a.store.heartbeat('r1',t.id);

  // A second process on the same database. It has no in-memory record of that
  // run, and must still decline to route to a provider that is already taken.
  const b=new Service(root,{allowMock:true});
  const runner=new Runner(b,{log:()=>{}});
  b.runner=runner;
  assert.equal(runner.runningByProvider('gateway'),1);
  assert.equal(runner.atCapacity(b.store.getProvider('gateway')),true);
  assert.equal(b.eligible('planner').length,0);

  // Releasing the lease is what frees the slot, for everyone.
  a.store.releaseLease('r1');
  assert.equal(runner.runningByProvider('gateway'),0);
  assert.equal(b.eligible('planner').length,1);
});

test('a run that exceeds its tool-call budget is stopped',async()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  // The seeded test provider answers every role immediately, so it would be the
  // last-resort mock and the config below would never apply.
  s.updateProvider('mock',{enabled:false});
  s.addProvider({id:'spiral',name:'Spiral',kind:'mock',enabled:true,config:{routable:true,toolCalls:50,usage:{input_tokens:100000,output_tokens:5000}}});
  s.addModel({id:'spiral-m',providerId:'spiral',name:'spiral',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:2000000,inputCostPerMTok:2,outputCostPerMTok:10,billingMode:'api'});
  const r=s.getRouting();
  s.saveRouting({...r,planner:{...r.planner,maxToolCalls:3}});
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  await assert.rejects(()=>s.plan(t.id),(e)=>e.code==='TOOL_CALL_LIMIT'&&/over its budget of 3/.test(e.message));

  const run=s.store.listRuns(t.id).pop();
  assert.equal(run.status,'failed');
  assert.match(run.error,/TOOL_CALL_LIMIT/);
  // Being stopped is not a refund. The provider had already reported this turn's
  // usage when the budget tripped, and those tokens were spent - three deepseek
  // planner runs stopped exactly here and every one of them recorded cost 0, which
  // reads as free work on the only runs whose cost is worth knowing.
  assert.equal(run.tokens,105000);
  assert.equal(run.cost,0.25,'100K input at $2/MTok and 5K output at $10/MTok');
  assert.equal(run.cost_basis,'published-api-rate','priced on the same basis a completed run would be');
  // The provider worked exactly as asked, so the breaker must not hear about it.
  assert.equal(s.providerHealthList().find((h)=>h.providerId==='spiral').state,'HEALTHY');
  assert.equal(s.store.listRuns(t.id).length,1,'a budget failure is not retried on another provider');
  assert.equal(s.task(t.id).state,'FAILED','the task needs re-scoping, not a silent retry');
});

test('a run that exceeds its cost ceiling is stopped',async()=>{
  const root=repo();const s=new Service(root,{allowMock:true});
  const p=s.initProject('p',root);
  s.updateProvider('mock',{enabled:false});
  // 800K input tokens at $10/MTok is $8, well past the $1 ceiling below.
  s.addProvider({id:'pricey',name:'Pricey',kind:'mock',enabled:true,config:{routable:true,usage:{input_tokens:800000,output_tokens:0}}});
  s.addModel({id:'pricey-m',providerId:'pricey',name:'pricey',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:2000000,inputCostPerMTok:10,billingMode:'api'});
  const r=s.getRouting();
  s.saveRouting({...r,planner:{...r.planner,maxRunCost:1}});
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  await assert.rejects(()=>s.plan(t.id),(e)=>e.code==='COST_LIMIT'&&/over its ceiling of \$1/.test(e.message));
  assert.equal(s.store.listRuns(t.id).length,1,'a budget failure is not retried on another provider');
  // The run was stopped, not refunded. It burned 800K tokens at $10/MTok to reach
  // the ceiling, and a row that records that burn as zero reads as free work - on
  // the one run whose cost is the entire reason it exists. The ceiling is checked
  // as the stream arrives, so the tokens that tripped it are already counted.
  const stopped=s.store.listRuns(t.id)[0];
  assert.equal(stopped.cost,8,'the spend that tripped the ceiling is the spend recorded');
  assert.equal(stopped.tokens,800000);
  assert.equal(stopped.input_tokens,800000);
  assert.equal(stopped.cost_basis,'published-api-rate','priced on the same basis a completed run would be');
});

// The state a crash between the planner run succeeding and plan() writing that
// result onto the task leaves behind: the task still PLANNING, the plan only in
// the events, and a succeeded run row for the recovery to find. `ageMs` is how
// long ago the run finished - a success seconds old belongs to a live process.
function abandonedPlan(s,taskId,text,{ageMs=LEASE_STALE_MS*4}={}){
  // A real planning cycle writes the task when planning starts and ends its run
  // after, so the task row is stamped behind the run. Recovery reads that ordering
  // to tell a plan the process failed to deliver from one the user rejected.
  const startedAt=new Date(Date.now()-ageMs-60000).toISOString();
  const r=s.store.addRun({id:s.store.id(),taskId,role:'planner',providerId:'mock',modelId:'mock-strong',status:'running',startedAt});
  if(text)s.store.addEvent({runId:r.id,type:'message',data:{type:'assistant',message:{content:[{type:'text',text}]}}});
  s.store.updateRun(r.id,{status:'succeeded',ended_at:new Date(Date.now()-ageMs).toISOString()});
  // updateTask stamps now, so the ordering is restored directly rather than
  // through the API that would overwrite it.
  s.store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(startedAt,taskId);
  return r.id;
}

test('the planner is told it may report the task as already done',()=>{
  // The spiral this guards: "Produce ONLY a concrete implementation plan" has no
  // valid answer when the code already satisfies the task, so the agent spends its
  // budget hunting for work that is not there. An instruction the agent can follow
  // is the fix, so the instruction is what is asserted.
  assert.match(PLANNER_PROMPT,/already fully implemented/i);
  assert.match(PLANNER_PROMPT,/Do not invent work/);
});

test('the planner is told the file-writing tool does not exist',()=>{
  // Not the same instruction as "do not modify source files": the planner was
  // trying to save its plan to a plans file, which it read as outside that rule.
  // Every planning run paid for a Write that could only fail, plus a search for a
  // tool to replace it, and both are visible in the activity log of the runs.
  assert.match(PLANNER_PROMPT,/No tool that writes a file exists/i);
  assert.match(PLANNER_PROMPT,/plan is the text of your reply/i);
});

test('the reviewer is told the same thing, and still gets the diff',()=>{
  // The reviewer runs the same permission mode and the same denied tools, so the
  // plan-file instruction reaches it too. The diff has to survive into the prompt
  // either way, since it is the whole input to the verdict.
  const p=reviewerPrompt('diff --git a/x b/x\n+1');
  assert.match(p,/No tool that writes a file exists/i);
  assert.match(p,/PASS or FAIL/);
  assert.ok(p.includes('diff --git a/x b/x'));
});

test('a planner and a reviewer cannot write, and only an implementer skips permissions',()=>{
  // Read the denylist itself rather than the whole argv. The appended system
  // prompt names Write and Edit in prose, so searching the argv would find them
  // whether or not the denylist still had them.
  const denied=(role)=>{
    const a=claudeArgs({role,model:'m',prompt:'p'});
    const i=a.indexOf('--disallowedTools');
    if(i===-1)return [];
    const out=[];
    for(let j=i+1;j<a.length&&!a[j].startsWith('--');j++)out.push(a[j]);
    return out;
  };
  assert.deepEqual(denied('planner'),['Edit','Write','Bash']);
  // The reviewer keeps Bash: plan mode is what limits it to read-only commands,
  // so dropping it there would hand a reviewer an unrestricted shell.
  assert.deepEqual(denied('reviewer'),['Edit','Write']);
  assert.ok(!claudeArgs({role:'reviewer',model:'m',prompt:'p'}).includes('--dangerously-skip-permissions'));
  // `--` last, so a prompt that opens with a dash is not read as a flag.
  const planner=claudeArgs({role:'planner',model:'m',prompt:'p'});
  assert.equal(planner[planner.length-2],'--');
  assert.equal(planner[planner.length-1],'p');
  assert.ok(claudeArgs({role:'implementer',model:'m',prompt:'p'}).includes('--dangerously-skip-permissions'));
});

test('plan mode is countermanded in the system prompt, not the task prompt',()=>{
  // Plan mode's own reminder tells the model to write a plans file using a tool
  // that is denied. A task-prompt clause saying so does not stop the attempt; an
  // appended system prompt does. So the flag has to be on both read-only roles,
  // and its value has to survive as one argv entry rather than being read as a
  // flag itself.
  for(const role of ['planner','reviewer']){
    const args=claudeArgs({role,model:'m',prompt:'p'});
    const i=args.indexOf('--append-system-prompt');
    assert.ok(i>-1,`${role} must countermand plan mode`);
    const notice=args[i+1];
    assert.match(notice,/No tool that writes a file exists/i);
    assert.match(notice,/do not search for one/i);
    // The notice mentions Write and Edit, so a naive includes() would find them
    // whether or not they were actually denied - the denylist is what is checked.
    const d=args.indexOf('--disallowedTools');
    assert.ok(d>-1);
    assert.equal(args[d-2],'--permission-mode');
    assert.equal(args[d-1],'plan');
  }
  // An implementer has no plan mode to countermand, and prompting it not to write
  // would contradict the only role that is supposed to write.
  assert.equal(claudeArgs({role:'implementer',model:'m',prompt:'p'}).indexOf('--append-system-prompt'),-1);
});

test('uncommitted work already in the tree is not a planning violation',async()=>{
  // The planner was told not to touch the repo and did not. The check read "some
  // file is dirty" as "the planner dirtied it", so planning any task in a
  // repository with work in progress marked the task FAILED and discarded the plan
  // - which is what happened to a real task whose planner correctly answered that
  // no implementation work was needed.
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  fs.writeFileSync(path.join(root,'README.md'),'an edit that predates the task');
  fs.writeFileSync(path.join(root,'NOTES.md'),'an untracked file that predates the task');
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  const done=await s.plan(t.id);
  assert.equal(done.state,'AWAITING_APPROVAL');
  assert.ok(s.task(t.id).plan,'the plan survived');
});

test('a planner that does touch the repo is still a violation',async()=>{
  // The other direction, so this fix cannot be "make the check never fire". plan()
  // captures the tree synchronously before its first await, so a write made here
  // lands inside the measured window. The file is named in the error because
  // "planner changed repository state" alone sends the reader to the run log.
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  const planning=s.plan(t.id);
  fs.writeFileSync(path.join(root,'sneaky.mjs'),'// the planner wrote this');
  await assert.rejects(()=>planning,/PLANNING_VIOLATION: planner changed repository state \(.*sneaky\.mjs/);
  assert.equal(s.task(t.id).state,'FAILED');
});

test('a plan left behind by a dead process is recovered on the next open',()=>{
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  abandonedPlan(s,t.id,'1. Add the endpoint.\n2. Test it.');
  assert.equal(s.task(t.id).state,'PLANNING','the task never heard that the run finished');
  // A second process opening the same root is the recovery point.
  const reopened=new Service(root,{allowMock:true,silent:true});
  const after=reopened.task(t.id);
  assert.equal(after.state,'AWAITING_APPROVAL');
  assert.match(after.plan,/Add the endpoint/);
});

test('a plan a live process is still writing is left alone',()=>{
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  // Seconds old: plan() is between the run succeeding and writing the task, and
  // recovering here would move the task out from under the process writing it.
  abandonedPlan(s,t.id,'a plan',{ageMs:0});
  const reopened=new Service(root,{allowMock:true,silent:true});
  assert.equal(reopened.task(t.id).state,'PLANNING');
});

test('recovery takes the newest plan, not an older attempt',()=>{
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  abandonedPlan(s,t.id,'STALE PLAN from an earlier attempt',{ageMs:LEASE_STALE_MS*8});
  abandonedPlan(s,t.id,'CURRENT PLAN',{ageMs:LEASE_STALE_MS*4});
  const reopened=new Service(root,{allowMock:true,silent:true});
  const after=reopened.task(t.id);
  assert.equal(after.state,'AWAITING_APPROVAL');
  assert.match(after.plan,/CURRENT PLAN/);
  assert.doesNotMatch(after.plan,/STALE PLAN/);
});

test('a plan the user rejected is not recovered',()=>{
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  abandonedPlan(s,t.id,'the plan the user said no to');
  // Recovery is how the plan reached the user to be refused in the first place.
  const reopened=new Service(root,{allowMock:true,silent:true});
  assert.equal(reopened.task(t.id).state,'AWAITING_APPROVAL');
  reopened.reject(t.id);
  assert.equal(reopened.task(t.id).plan,null,'reject clears the plan');
  // Which leaves the task in exactly the shape an abandoned plan has: PLANNING, no
  // plan, a succeeded planner run behind it. Recovering here puts the refused plan
  // back in front of the user on every restart, so it must not.
  const third=new Service(root,{allowMock:true,silent:true});
  assert.equal(third.task(t.id).state,'PLANNING');
  assert.equal(third.task(t.id).plan,null,'the rejected plan stays gone');
  assert.equal(third.store.orphanedPlans().length,0);
});

test('replanning runs a new planner instead of resurrecting the discarded plan',()=>{
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  abandonedPlan(s,t.id,'the plan the planning check discarded');
  // What the planning check wrote before it threw, and what Replan is offered on.
  s.store.updateTask(t.id,{state:'FAILED'});
  s.replan(t.id);
  const reopened=new Service(root,{allowMock:true,silent:true});
  assert.equal(reopened.task(t.id).state,'PLANNING');
  assert.equal(reopened.task(t.id).plan,null,'the spent run is not re-delivered');
  assert.equal(reopened.store.orphanedPlans().length,0);
});

test('a run that succeeds does not keep the error the reaper wrote',()=>{
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');
  const r=s.store.addRun({id:s.store.id(),taskId:t.id,role:'planner',providerId:'mock',modelId:'mock-strong',status:'running',startedAt:new Date().toISOString()});
  // What reapStaleRuns writes when a run outlives its lease. The run then finishes
  // anyway, which is exactly what the Sonnet fallback did: succeeded, and carrying
  // the reaper's error through the merge.
  s.store.updateRun(r.id,{status:'interrupted',error:'Process interrupted'});
  const done=s.store.updateRun(r.id,{status:'succeeded',ended_at:new Date().toISOString()});
  assert.equal(done.error,null);
  assert.equal(s.store.listRuns(t.id).find(x=>x.id===r.id).error,null);
});

test('a plan is the run\'s closing message, not its whole log',()=>{
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  const r=s.store.addRun({id:s.store.id(),taskId:t.id,role:'planner',providerId:'mock',modelId:'mock-strong',status:'running',startedAt:new Date().toISOString()});
  const say=text=>s.store.addEvent({runId:r.id,type:'message',data:{type:'assistant',message:{content:[{type:'text',text}]}}});
  // The shape that produced a 35K "plan": running commentary and Explore subagent
  // reports echoed into the same stream as the answer, with the answer itself
  // arriving twice - once as the final assistant message, once in the result frame.
  say('Two Explore agents are running in the background — one on the frontend view.');
  say('# Findings\n\n## Task Detail View — everything the subagent read, in full.');
  const plan='## Context\n\n## Approach\n\n## Files and changes\n\n## Verification';
  say(plan);
  s.store.addEvent({runId:r.id,type:'result',data:{subtype:'success',is_error:false,result:plan}});
  const got=s.planFromRun(r.id);
  assert.equal(got,plan);
  assert.doesNotMatch(got,/Two Explore agents/,'the commentary is not the plan');
  assert.doesNotMatch(got,/## Task Detail View/,'a subagent report is not the plan');
  assert.equal(got.match(/## Approach/g).length,1,'the plan is not written down twice');
});

test('a run with no result frame still yields its closing message',()=>{
  // The path every mock-backed test takes, and the path a run killed mid-stream
  // leaves behind: no result frame, so the last thing it said is all there is.
  const root=repo();const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);
  const r=s.store.addRun({id:s.store.id(),taskId:t.id,role:'planner',providerId:'mock',modelId:'mock-strong',status:'running',startedAt:new Date().toISOString()});
  const say=text=>s.store.addEvent({runId:r.id,type:'message',data:{type:'assistant',message:{content:[{type:'text',text}]}}});
  say('Let me look at a few more files first.');
  say('1. Add the endpoint.\n2. Test it.');
  assert.equal(s.planFromRun(r.id),'1. Add the endpoint.\n2. Test it.');
});

test('an exhausted balance is a usage limit, not a generic agent failure',()=>{
  // What DeepSeek returns when the account runs out. The classifier sees it on two
  // paths - the status code alone, and the whole message - so both are covered.
  assert.equal(classify('402'),'USAGE_LIMIT');
  assert.equal(classify('API Error: 402 Insufficient Balance'),'USAGE_LIMIT');
  assert.equal(classify('Your credit balance is too low to access the Anthropic API'),'USAGE_LIMIT');
  // A billing failure is not the provider being down, and must not be read as one.
  assert.notEqual(classify('API Error: 402 Insufficient Balance'),'PROVIDER_DOWN');
  // The neighbours of 402 keep landing where they did.
  assert.equal(classify('429 Too Many Requests'),'RATE_LIMIT');
  assert.equal(classify('401 Unauthorized'),'AUTH_FAILURE');
  assert.equal(classify('403 Forbidden'),'AUTH_FAILURE');
  assert.equal(classify('502 Bad Gateway'),'PROVIDER_DOWN');
  assert.equal(classify('504'),'PROVIDER_DOWN');
  // A status code has to be the whole number, not a substring of a bigger one.
  assert.equal(classify('context window exceeded at 1402 tokens'),'CONTEXT_TOO_LARGE');
});

// ---- the activity feed's text ---------------------------------------------------
// Every payload below is a real one, captured from a run's event log. The rows that
// used to render as their own type name - "message", "system" - are the ones these
// cover, because a feed of those is a feed nobody can use.

test('a tool call names the tool and what it was pointed at',()=>{
  const call=(name,input)=>({type:'message',data:{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',name,input}]}}});
  assert.deepEqual(describeEvent(call('Read',{file_path:'src/server.mjs'})),{kind:'tool',text:'Read — src/server.mjs'});
  assert.equal(describeEvent(call('Bash',{command:'ls -la src/',description:'list'})).text,'Bash — ls -la src/');
  assert.equal(describeEvent(call('Grep',{pattern:'createTask|prepare',path:'src',output_mode:'content'})).text,'Grep — createTask|prepare');
  assert.equal(describeEvent(call('Agent',{description:'Explore Mission Control UI',prompt:'long prompt'})).text,'Agent — Explore Mission Control UI');
  // A tool with no interesting argument still reports which tool ran.
  assert.equal(describeEvent(call('ListAgents',{})).text,'ListAgents');
  // The first three keys of a real Grep input are flags; the pattern still wins.
  assert.equal(describeEvent(call('Grep',{'-n':true,head_limit:150,output_mode:'content',pattern:'LEASE_STALE_MS'})).text,'Grep — LEASE_STALE_MS');
});

test('a tool result shows its opening line and how much more there is',()=>{
  const result=(text,extra={})=>({type:'message',data:{type:'user',message:{content:[{type:'tool_result',content:[{type:'text',text}],...extra}]}}});
  assert.deepEqual(describeEvent(result('No files found')),{kind:'out',text:'No files found'});
  assert.equal(describeEvent(result('154\t  prepare(id) {\n155\t    ...\n156\t  }')).text,'154\t  prepare(id) { (+2 more lines)');
  assert.equal(describeEvent(result('')).text,'no output');
  // A failed call is the reason the agent changed course, so it is not output.
  const failure=describeEvent(result('<tool_use_error>Error: No such tool available: Bash.</tool_use_error>',{is_error:true}));
  assert.equal(failure.kind,'error');
  assert.equal(failure.text,'Error: No such tool available: Bash.','the wrapper is claude\'s, not the message');
});

test('a reviewer result frame shows its review, not the envelope around it',()=>{
  // --json-schema puts the closing JSON in `result`, so a feed that rendered that
  // field would show `{"verdict":"PASS","review":"…` where the verdict line was.
  const data={type:'result',subtype:'success',is_error:false,num_turns:9,duration_ms:45000,result:'{"verdict":"PASS","review":"Matches the plan."}',structured_output:{verdict:'PASS',review:'Matches the plan.\n\nIt also covers the edge case.'}};
  const d=describeEvent({type:'result',data});
  assert.equal(d.kind,'done');
  assert.equal(d.text,'success · 9 turns · 45s — Matches the plan.');
  // A planner keeps its own reading: no structured output, so `result` is the answer.
  assert.equal(describeEvent({type:'result',data:{type:'result',subtype:'success',result:'# Plan\n\n1. Do the thing.'}}).text,'success — # Plan');
});

test('an assistant message shows its sentence rather than its reasoning',()=>{
  const data={type:'assistant',message:{content:[{type:'thinking',thinking:'Let me look at the store first.'},{type:'text',text:'The store is fine.\nSecond paragraph.'}]}};
  assert.deepEqual(describeEvent({type:'message',data}),{kind:'said',text:'The store is fine.'});
  // Redacted reasoning carries a signature and no words. There is no row to show.
  assert.equal(describeEvent({type:'message',data:{type:'assistant',message:{content:[{type:'thinking',thinking:'',signature:'ErIDCrIBCBIYAipA'}]}}}),null);
  assert.equal(describeEvent({type:'message',data:{type:'assistant',message:{content:[{type:'thinking',thinking:'Weighing two approaches.'}]}}}).kind,'think');
});

test('subagent bookkeeping names the subagent and what it was doing',()=>{
  const progress={type:'message',data:{type:'system',subtype:'task_progress',subagent_type:'Explore',description:'Running List web directory and count lines of index.html',usage:{total_tokens:10570,tool_uses:1,duration_ms:3863},last_tool_name:'Bash'}};
  assert.deepEqual(describeEvent(progress),{kind:'agent',text:'Explore · Running List web directory and count lines of index.html · 10.6K tok, 1 tool, 4s'});
  assert.equal(describeEvent({type:'system',data:{type:'system',subtype:'task_started',subagent_type:'Explore',description:'Explore Mission Control UI'}}).text,'Explore started · Explore Mission Control UI');
  assert.equal(describeEvent({type:'message',data:{type:'system',subtype:'task_notification',status:'completed',summary:'I have everything needed. Here is the complete report.\n\n# Report'}}).text,'agent completed · I have everything needed. Here is the complete report.');
  assert.equal(describeEvent({type:'system',data:{type:'system',subtype:'background_tasks_changed',tasks:[{description:'Explore Mission Control UI'}]}}).text,'agents running · Explore Mission Control UI');
  assert.equal(describeEvent({type:'system',data:{type:'system',subtype:'background_tasks_changed',tasks:[]}}).text,'no agents running');
  // A patch with no status is bookkeeping about bookkeeping.
  assert.equal(describeEvent({type:'system',data:{type:'system',subtype:'task_updated',patch:{}}}),null);
});

test('a session start and a finished run carry their numbers',()=>{
  assert.equal(describeEvent({type:'system',data:{type:'system',subtype:'init',cwd:'/repo',tools:['Read','Grep','Bash']}}).text,'session started · 3 tools · /repo');
  assert.equal(describeEvent({type:'started',data:{role:'planner',model:'deepseek-v4-pro'}}).text,'planner started on deepseek-v4-pro');
  assert.equal(describeEvent({type:'completed',data:{sessionId:'4bce6f6c9a1e'}}).text,'run finished · session 4bce6f6c');
});

test('a failed run leads with the failure, not with the harness subtype',()=>{
  // The 402 planning run. claude reports subtype `success` because the harness itself
  // worked; the run still failed, and that is the word the row has to open with.
  const spent={type:'result',data:{subtype:'success',is_error:true,num_turns:2,duration_ms:20000,total_cost_usd:2.21,result:'API Error: 402 Insufficient Balance'}};
  assert.deepEqual(describeEvent(spent),{kind:'error',text:'failed · 2 turns · 20s · $2.21 — API Error: 402 Insufficient Balance'});
  const ok={type:'result',data:{subtype:'success',num_turns:1,duration_ms:3000,total_cost_usd:0.02,result:'OK'}};
  assert.deepEqual(describeEvent(ok),{kind:'done',text:'success · 1 turn · 3s · $0.02 — OK'});
});

test('a quota notice is only loud when it is refusing',()=>{
  const notice=(info)=>({type:'rate_limit_event',data:{type:'rate_limit_event',rate_limit_info:info}});
  const healthy=describeEvent(notice({status:'allowed',unifiedWindows:{five_hour:{utilization:0.18,resetsAt:1790026200}}}));
  assert.deepEqual(healthy,{kind:'note',text:'quota · 18% of 5h used'});
  const refused=describeEvent(notice({status:'rejected',overageDisabledReason:'out_of_credits',unifiedWindows:{five_hour:{utilization:0.98,resetsAt:1790026200}}}));
  assert.equal(refused.kind,'limit');
  assert.match(refused.text,/^rate limit · rejected · out of credits · resets /);
});

test('nothing renders as its own event type',()=>{
  // The regression this guards: a row whose text is the stored `type` tells a reader
  // nothing, and a feed of them is what the activity tab used to be.
  const payloads=[
    {type:'message',data:{type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'a.mjs'}}]}}},
    {type:'message',data:{type:'user',message:{content:[{type:'tool_result',content:[{type:'text',text:'ok'}]}]}}},
    {type:'message',data:{type:'system',subtype:'task_progress',subagent_type:'Explore',description:'x',usage:{total_tokens:10}}},
    {type:'message',data:{type:'system',subtype:'task_notification',status:'completed',summary:'done'}},
    {type:'system',data:{type:'system',subtype:'init',cwd:'/r',tools:[]}},
    {type:'system',data:{type:'system',subtype:'informational',content:'a notice'}},
    {type:'rate_limit_event',data:{type:'rate_limit_event',rate_limit_info:{status:'allowed',unifiedWindows:{five_hour:{utilization:0.5}}}}},
    {type:'result',data:{subtype:'success',num_turns:1,result:'done'}},
    {type:'started',data:{role:'planner'}},
    {type:'completed',data:{sessionId:'abcdef1234'}},
    {type:'message',data:'planner completed.'},
  ];
  for(const p of payloads){
    const d=describeEvent(p);
    assert.ok(d,`${p.type} produced no row`);
    assert.notEqual(d.text,p.type,'a row must say more than its own type');
    assert.ok(d.text.trim().length>0);
  }
  // And the string form the TUI renders into a Text node is never null.
  assert.equal(formatEvent({type:'message',data:{type:'system',subtype:'task_updated',patch:{}}}),'');
  assert.equal(typeof formatEvent({type:'started',data:{role:'planner'}}),'string');
});

test('a plan is markdown and a reviewer\'s diff is not',()=>{
  assert.equal(bodyKind('## What was requested vs. what exists\n\n- one\n- two\n\n```js\nconst x=1;\n```\n'),'markdown');
  assert.equal(bodyKind('The reviewer found no issues.'),'markdown');
  assert.equal(bodyKind(''),'empty');
  assert.equal(bodyKind(null),'empty');
  assert.equal(bodyKind('   \n\n  '),'empty');
  // Each marker has to stand on its own: a reviewer can paste a fragment that opens
  // on a hunk header rather than on `diff --git`.
  for(const head of ['diff --git a/x.mjs b/x.mjs','--- a/x.mjs','+++ b/x.mjs','@@ -1,4 +1,6 @@']){
    assert.equal(bodyKind(`${head}\n context line\n`),'diff',`${head} should read as a diff`);
  }
});

test('a horizontal rule in a plan does not read as a diff',()=>{
  // The hazard the marker list has to survive. A plan sets out its sections with
  // `---`, which is the same three characters a unified diff header opens with, and
  // a rule written with a trailing space is byte-identical to `--- ` on its own. The
  // path after the marker is the only thing separating them, so it is required.
  assert.equal(bodyKind('## Plan\n\n---\n\n- one\n'),'markdown');
  assert.equal(bodyKind('## Plan\n\n--- \n\n- one\n'),'markdown');
  assert.equal(bodyKind('---\ntitle: a plan\n---\n\n# Steps\n'),'markdown');
});

// -- the execution gate -----------------------------------------------------
// The planner reads the live tree and the implementer works in a worktree built
// from HEAD, so a plan written against uncommitted changes describes code the
// implementer never sees. Execution refuses while those files are still dirty.

// A repo with one more committed file, so a test can dirty something the planner
// read without disturbing the fixture the rest of the suite shares.
function repoWith(file){
  const root=repo();
  fs.writeFileSync(path.join(root,file),'export const version=1;\n');
  execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','add'],{cwd:root});
  return root;
}

test('dirtyPaths returns bare paths, not porcelain lines',()=>{
  // changedFiles gives ` M README.md`, which cannot be compared as a set. The -z
  // form is what makes this a set operation, and it is also why a name with a
  // space in it survives: the line form quotes it, and quoting a path breaks the
  // comparison against every other path in the same shape.
  const root=repo();
  fs.appendFileSync(path.join(root,'README.md'),'an edit\n');
  fs.writeFileSync(path.join(root,'a file with spaces.mjs'),'x\n');
  assert.deepEqual(dirtyPaths(root).sort(),['README.md','a file with spaces.mjs']);
  // The harness's own store is written on every run. Left in, it is
  // indistinguishable from the planner having edited a file.
  fs.mkdirSync(path.join(root,'.ai-code'),{recursive:true});
  fs.writeFileSync(path.join(root,'.ai-code','ai-code.db'),'x');
  assert.deepEqual(dirtyPaths(root).sort(),['README.md','a file with spaces.mjs']);
});

test('the read set is the files the planner opened, in the repository\'s own terms',()=>{
  const root='/repo';
  const events=[
    // Read reports an absolute path, and Grep reports both forms inside a single
    // run. Nothing here matches a repo-relative dirty set unless both are
    // normalised, which is how the tool-derived half of the read set went inert
    // against every real run while passing against relative test fixtures.
    {data:{message:{content:[{type:'tool_use',name:'Read',input:{file_path:'/repo/src/a.mjs'}}]}}},
    {data:{message:{content:[{type:'tool_use',name:'Grep',input:{path:'src'}}]}}},
    {data:{message:{content:[{type:'tool_use',name:'Grep',input:{path:'/repo/tests'}}]}}},
    {data:{message:{content:[{type:'tool_use',name:'Bash',input:{command:'ls'}}]}}},
    {data:{message:{content:[{type:'tool_use',name:'Task',input:{prompt:'look around'}}]}}},
    // Outside the repository: the dirty set can never contain this.
    {data:{message:{content:[{type:'tool_use',name:'Read',input:{file_path:'/elsewhere/x.mjs'}}]}}},
    {data:{message:{content:[{type:'text',text:'a plan'}]}}},
    {data:'a plain log line'},
  ];
  const seen=readPaths(events,['README.md'],root);
  assert.deepEqual([...seen].sort(),['README.md','src','src/a.mjs','tests']);
  // A Grep records a directory as often as a file, and the plan rests on
  // everything beneath it.
  assert.ok(touches(seen,'src/deep/b.mjs'));
  assert.ok(touches(seen,'tests/c.mjs'));
  assert.ok(!touches(seen,'web/d.mjs'));
  // And the reverse, because git collapses an untracked directory to a single
  // entry: the dirty side is then the directory while the read side is the file
  // inside it.
  assert.ok(touches(seen,'src/'));
});

test("dirtyPaths keeps a renamed file's destination, not its source",()=>{
  // The hazard in the -z form: it lists the destination first and the source
  // second, with the status prefix only on the destination, and in the opposite
  // order to the line form's `old -> new`. Read in the wrong order this reports
  // the path that no longer exists, three characters short.
  const root=repoWith('old.mjs');
  execFileSync('git',['mv','old.mjs','new.mjs'],{cwd:root});
  assert.deepEqual(dirtyPaths(root),['new.mjs']);
});

test('execution is refused when a file the plan was written against is still dirty',async()=>{
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  s.updateProvider('mock',{config:{readPaths:['app.mjs']}});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  fs.writeFileSync(path.join(root,'app.mjs'),'export const version=2;\n');
  await s.plan(t.id);
  s.approve(t.id);
  const err=await s.implement(t.id).then(()=>null,e=>e);
  assert.equal(err.code,'PLAN_BASE_DIRTY');
  assert.match(err.message,/app\.mjs/,'the message names the file to commit');
  assert.equal(s.task(t.id).state,'APPROVED','still approved, so committing and retrying is the remedy');
  assert.equal(s.task(t.id).worktree,null,'no worktree was built for a run that never happened');
});

test('a dirty file the plan never depended on does not block execution',async()=>{
  // The other direction. This repository is nearly always mid-change, so a gate
  // that fired on any dirty file would fire on every task and mean nothing.
  const root=repoWith('notes.txt');
  const s=new Service(root,{allowMock:true,silent:true});
  s.updateProvider('mock',{config:{readPaths:['app.mjs']}});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  // The read set is the whole of what this plan depends on, so the context
  // manifest is emptied rather than left to whatever the ranker happened to pick.
  s.store.updateTask(t.id,{context:JSON.stringify({files:[]})});
  fs.appendFileSync(path.join(root,'notes.txt'),'unrelated work in progress\n');
  assert.ok(dirtyPaths(root).includes('notes.txt'),'the fixture is actually dirty');
  await s.plan(t.id);
  s.approve(t.id);
  const done=await s.implement(t.id);
  assert.equal(done.state,'TESTING');
});

test('a file inlined into the planner prompt counts as read',async()=>{
  // A file whose contents were in the prompt was read by the planner as surely as
  // one it opened, and this run makes no tool calls at all, so the manifest is the
  // only thing that can put it in the read set.
  const root=repoWith('notes.txt');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  s.store.updateTask(t.id,{context:JSON.stringify({files:[{path:'notes.txt',tokens:1}]})});
  fs.appendFileSync(path.join(root,'notes.txt'),'work in progress\n');
  await s.plan(t.id);
  s.approve(t.id);
  await assert.rejects(()=>s.implement(t.id),/PLAN_BASE_DIRTY/);
});

test('force executes a plan whose baseline is still dirty',async()=>{
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  s.updateProvider('mock',{config:{readPaths:['app.mjs']}});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  fs.writeFileSync(path.join(root,'app.mjs'),'export const version=2;\n');
  await s.plan(t.id);
  s.approve(t.id);
  const done=await s.implement(t.id,{force:true});
  assert.equal(done.state,'TESTING');
});

test('execute is gated on the same terms, and force reaches it through execute',async()=>{
  // execute() is the verb the CLI, the dashboard button and the TUI all call, and
  // it reaches the gate through implement(). Forwarding opts is silent if it
  // regresses: the gate would fire with no way to override it.
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  s.updateProvider('mock',{config:{readPaths:['app.mjs']}});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  fs.writeFileSync(path.join(root,'app.mjs'),'export const version=2;\n');
  await s.plan(t.id);
  s.approve(t.id);
  await assert.rejects(()=>s.execute(t.id),/PLAN_BASE_DIRTY/);
  const done=await s.execute(t.id,{force:true});
  assert.equal(done.state,'COMPLETE');
});

test('an implementer that rewrites a baselined file is recorded, not silently dropped',async()=>{
  // The exact version of the check the gate can only approximate: the gate reasons
  // about what the planner saw, this asks what the implementer actually wrote. It
  // is the only record of the collision - the diff and the review are both computed
  // inside the worktree, where the uncommitted version never existed.
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  s.updateProvider('mock',{config:{readPaths:['app.mjs'],writes:['app.mjs']}});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  fs.writeFileSync(path.join(root,'app.mjs'),'export const version=2;\n');
  await s.plan(t.id);
  s.approve(t.id);
  const done=await s.implement(t.id,{force:true});
  assert.equal(done.state,'TESTING');
  assert.deepEqual(JSON.parse(s.task(t.id).plan_base).conflicts,['app.mjs']);
});

test('a file that changed after the plan was written also blocks execution',async()=>{
  // Same hazard, different timing. The worktree is built from HEAD either way, so
  // a file that was clean when the planner read it and dirty now is off the same
  // tree underneath the implementer. Gating on what was dirty at plan time instead
  // of what the plan read would miss this entirely.
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  s.updateProvider('mock',{config:{readPaths:['app.mjs']}});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);
  await s.plan(t.id);
  // Clean when it was planned; the edit lands between approval and execution.
  s.approve(t.id);
  fs.writeFileSync(path.join(root,'app.mjs'),'export const version=2;\n');
  const err=await s.implement(t.id).then(()=>null,e=>e);
  assert.equal(err.code,'PLAN_BASE_DIRTY');
  assert.match(err.message,/changed after the plan was written/,'the message says which of the two situations this is');
});

// -- porting a task's work onto a branch ----------------------------------
//
// A completed task's work is stranded: createWorktree cuts `ai-code/<id>` at HEAD
// and nothing in the product ever commits there, so the change exists only as an
// uncommitted worktree and there is nothing to merge, revert or safely delete.
// These cover materializing it, reading it, and landing it - and the one way the
// change could break the workflow that produced it.

// git in a fixture, trimmed, for the assertions that are about refs rather than
// about anything the Service returns.
function sh(cwd,args){return execFileSync('git',args,{cwd,encoding:'utf8'}).trim()}
function commitAs(cwd,msg){execFileSync('git',['-c','user.email=test@example.com','-c','user.name=Test','commit','-qm',msg],{cwd})}

// A task whose implementer has written into its worktree, which is the state a port
// is asked about: state TESTING, the worktree dirty, the branch still at its base.
async function worked(root){
  const s=new Service(root,{allowMock:true,silent:true});
  s.updateProvider('mock',{config:{writes:['app.mjs']}});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'change the button colour');
  s.prepare(t.id);await s.plan(t.id);s.approve(t.id);
  await s.implement(t.id);
  return {s,t:s.task(t.id)};
}

test('the diff a reviewer is handed survives a port',async()=>{
  // The regression this feature would otherwise introduce. `git diff` compares the
  // worktree against the index, so committing the work makes it empty - and review()
  // hands that to the reviewer, where an empty diff has nothing to fail and is
  // recorded as PASS, moving the task to COMPLETE on no evidence. read at a ref it
  // reads the same before and after, which is what makes a port safe to interleave
  // with the workflow.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const before=s.diff(t.id).diff;
  assert.match(before,/diff --git a\/app\.mjs/,'the worktree has a change to show');
  // Only the trailing separator and the porcelain tail may differ, and the tail only
  // because app.mjs is no longer dirty. Trimming both sides is what makes this a
  // comparison of the diff rather than of a status line.
  const body=(d)=>d.replace(/\n+$/,'');
  const tail=(d)=>body(d).split('\n').filter((l)=>!/^ ?[MADRCU?!]{1,2} /.test(l)).join('\n');
  s.materialize(t.id);
  const after=s.diff(t.id).diff;
  assert.equal(tail(after),tail(before),'the diff body is unchanged by committing the work');
  assert.match(after,/diff --git a\/app\.mjs/,'and it is emphatically not empty, which is the whole regression');
});

test('a task branch that does not descend from the target is not treated as a fast-forward',async()=>{
  // The rewound-branch bug, in its real shape. A worktree reused after a second plan
  // records the newer HEAD as its base while its branch stays on the older commit,
  // so base_commit equals the target tip by coincidence of naming and the branch does
  // not contain it. Moving the target's ref on that answer drops the commits the
  // target has and the branch does not. merge-base --is-ancestor is the question,
  // and `git merge --ff-only` would have refused for free - `git branch -f` does not.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const taskBranch=sh(root,['rev-parse',t.branch]);
  // The shape of a reuse: the branch is where the work is, the recorded base is a
  // newer commit the branch has never seen. The advance touches a file the task does
  // not, so a conflict cannot stop the port before the ref logic is reached.
  fs.writeFileSync(path.join(root,'README.md'),'moved on\n');
  sh(root,['add','.']);commitAs(root,'moved on');
  const moved=sh(root,['rev-parse','HEAD']);
  s.store.updateTask(t.id,{base_commit:moved});
  sh(root,['branch','moved-target',moved]);

  const view=s.diff(t.id,{to:'moved-target'});
  assert.equal(view.fastForward,false,'the branch is not ahead of the target');
  assert.equal(view.alreadyPorted,false);
  // The other side of the same sentence: checked out nowhere, so the port does land, and
  // the step promising it is describing the command it prints rather than a hope.
  assert.match(view.next.find((n)=>n.command&&n.command.includes('task port')).text,/land it on moved-target/);
  assert.equal(view.next.some((n)=>n.command&&n.command.startsWith('git merge')),false,'and there is no merge left to run');

  const r=await s.port(t.id,{to:'moved-target'});
  assert.equal(r.command,null,'a target that is checked out nowhere is moved directly, not left with a command');
  const parents=sh(root,['rev-list','--parents','-n','1',r.landed]).split(' ');
  assert.equal(parents.length,3,'a merge commit with two parents, not the branch ref written over the target');
  const tip=sh(root,['rev-parse','moved-target']);
  assert.ok(isAncestor(root,moved,tip),'the commit the target already had is still reachable: it was merged, not rewound');
  assert.ok(isAncestor(root,taskBranch,tip),'and the task work landed on it');
  assert.match(sh(root,['show',`${tip}:app.mjs`]),/written by the mock implementer/,'the work is in the merged tree');
  assert.equal(sh(root,['show',`${tip}:README.md`]),'moved on','and so is what the target had, which a rewound branch would have dropped');
});

test('materialize on a worktree with nothing in it reports empty rather than failing',async()=>{
  // A planner is told in as many words to answer "already fully implemented" instead
  // of inventing work, so an empty worktree is a supported outcome and not an error.
  // `git commit` on an empty index exits non-zero and git() does not catch, so the
  // empty case is decided before the commit rather than discovered by it.
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const created=s.createTask(p.id,'nothing to do');
  s.prepare(created.id);await s.plan(created.id);s.approve(created.id);
  await s.implement(created.id);
  // Re-read: the worktree and branch this is about are written by implement, so the
  // row from createTask has neither.
  const t=s.task(created.id);
  const put=s.materialize(t.id);
  assert.equal(put.empty,true);
  assert.deepEqual(put.files,[]);
  assert.equal(sh(root,['rev-parse',t.branch]),t.base_commit,'the branch did not move');
});

test('materialize is idempotent, and a second call does not fail on an empty index',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const first=s.materialize(t.id);
  assert.equal(first.empty,false);
  assert.deepEqual(first.files,['app.mjs']);
  const again=s.materialize(t.id);
  assert.equal(again.empty,true,'already published, and told apart from never written by the branch having moved');
  assert.equal(again.commit,first.commit);
});

test('a port with dryRun writes nothing at all',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const base=currentBranch(root);
  sh(root,['branch','staging',base]);
  const staging=sh(root,['rev-parse','staging']);
  const branch=sh(root,['rev-parse',t.branch]);

  const r=await s.port(t.id,{to:'staging',dryRun:true});
  assert.equal(r.dryRun,true);
  assert.equal(r.pending,true,'the work is uncommitted, and the prediction says so');
  assert.equal(r.committed,false);
  assert.equal(sh(root,['rev-parse','staging']),staging,'the target did not move');
  assert.equal(sh(root,['rev-parse',t.branch]),branch,'the task branch did not move');
  assert.ok(dirtyPaths(t.worktree).length,'the worktree was not committed');
});

test('a port that would conflict stops and names the files',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  // The same file, changed on the destination since the fork, in a worktree of its
  // own so the branch can move without disturbing the checked-out one.
  const other=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-other-'));
  sh(root,['worktree','add','-b','clash',other]);
  fs.writeFileSync(path.join(other,'app.mjs'),'export const version=99;\n');
  sh(other,['add','.']);commitAs(other,'competes for the same file');
  const clash=sh(root,['rev-parse','clash']);
  sh(root,['worktree','remove','--force',other]);

  const err=await s.port(t.id,{to:'clash'}).then(()=>null,e=>e);
  assert.equal(err.code,'CONFLICT');
  assert.deepEqual(err.conflicts,['app.mjs']);
  assert.equal(sh(root,['rev-parse','clash']),clash,'the destination was not moved');
  assert.match(err.message,/committed on/,'the task branch did move, and the remedy depends on it having done so');
});

test('a port lands on a branch checked out nowhere',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  sh(root,['branch','staging',currentBranch(root)]);

  const r=await s.port(t.id,{to:'staging'});
  assert.equal(r.landed,r.commit);
  assert.equal(sh(root,['rev-parse','staging']),r.commit,'the branch was moved to the work');
  assert.match(sh(root,['show','staging:app.mjs']),/written by the mock implementer/);
});

test('a port leaves a checked-out branch alone and prints the command',async()=>{
  // Moving a ref that is checked out changes the tree of whoever is working in it,
  // and git refuses to do it anyway. So the honest answer is the command, and the
  // assertion here is that the ref has not moved.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const target=currentBranch(root);
  assert.equal(s.diff(t.id,{to:target}).checkedOut,true);

  const r=await s.port(t.id,{to:target});
  assert.equal(r.landed,null);
  assert.equal(sh(root,['rev-parse',target]),t.base_commit,'the checked-out branch is untouched');
  assert.equal(r.command,`git merge --ff-only ${t.branch}`,'a fast-forward needs --ff-only and nothing else');
});

test('a merge that is not a fast-forward on a checked-out branch prints a plain merge',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const target=currentBranch(root);
  // The destination advances on a file the task never touched, so the merge is real.
  fs.writeFileSync(path.join(root,'README.md'),'a newer commit\n');
  sh(root,['add','.']);commitAs(root,'the target moved on');

  const r=await s.port(t.id,{to:target});
  assert.equal(r.command,`git merge ${t.branch}`);
  assert.equal(r.landed,null);
  assert.equal(sh(root,['rev-parse',target]),sh(root,['rev-parse','HEAD']),'still the checked-out branch, still untouched');
});

test('clean removes the worktree and the branch keeps the work',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  sh(root,['branch','staging',currentBranch(root)]);
  const r=await s.port(t.id,{to:'staging',clean:true});
  assert.equal(fs.existsSync(t.worktree),false,'the worktree is gone');
  assert.equal(sh(root,['rev-parse',t.branch]),r.commit,'and the commit outlived the directory it was made in');
  assert.match(sh(root,['show','staging:app.mjs']),/written by the mock implementer/);
});

test('a port whose worktree is already gone reports the command rather than refusing',async()=>{
  // The dead end this closes. --clean removes the directory once the work is on the
  // branch, and the branch outlives it - so a task ported onto a checked-out branch has
  // no worktree left, and asking again failed with "no worktree to port" while the work
  // sat on a branch with a merge still outstanding. The command is the whole of what a
  // person needs, and it has to survive the cleanup that follows it.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const target=currentBranch(root);
  const first=await s.port(t.id,{to:target,clean:true});
  assert.equal(first.landed,null,`${target} is checked out, so its ref is left alone`);
  assert.equal(first.command,`git merge --ff-only ${t.branch}`);
  assert.equal(fs.existsSync(t.worktree),false,'the directory is gone');

  const again=await s.port(t.id,{to:target});
  assert.equal(again.command,first.command,'the same command, not an error about a missing worktree');
  assert.equal(again.landed,null);
  assert.ok(again.next.some((n)=>n.command===first.command),'and it is on the report rather than buried in it');
  assert.equal(sh(root,['rev-parse',target]),sh(root,['rev-parse','HEAD']),`${target} did not move either time`);
});

test('the read-only assessment names the steps a port would leave to you',async()=>{
  // What the tab shows before anything is clicked, and the reason the steps are derived
  // from the assessment rather than assembled by whichever surface ran the port. The
  // command is the part that is easy to lose, and it is knowable without porting.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const target=currentBranch(root);
  const d=s.diff(t.id,{to:target});
  assert.equal(d.worktree,true);
  assert.equal(d.pending,true,'the work is still in the worktree');
  // Two steps while the work is unpublished: publish it, then merge it.
  const published=d.next.find((n)=>n.command&&n.command.includes('task port'));
  assert.ok(published,'porting is the step that makes the merge possible');
  assert.equal(published.command,`ai-code task port ${t.id} --to ${target}`);
  // The text has to match what the command does. A checked-out destination means the port
  // stops at the commit and the merge is the next step's job, so this one must not claim
  // the landing it will not perform - the two steps read as a sequence, and a first step
  // that promises what the second one delivers is a contradiction in the same list.
  assert.ok(!/land it on/.test(published.text),`"${published.text}" promises a landing ${target} being checked out rules out`);
  assert.ok(d.next.some((n)=>n.command===`git merge --ff-only ${t.branch}`),'and the merge is named before anything runs');
  // Reading it wrote nothing: the worktree is there and the branch is still at its base.
  assert.equal(fs.existsSync(t.worktree),true);
  assert.equal(sh(root,['rev-parse',t.branch]),sh(root,['rev-parse',target]));
});

test('porting work the destination already has moves nothing',async()=>{
  // The second port has nothing to land, and landing it anyway puts a merge commit on
  // the target whose tree is the target's own: two parents, no change, and a history
  // that says the work arrived twice.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  sh(root,['branch','staging',currentBranch(root)]);
  const first=await s.port(t.id,{to:'staging'});
  assert.equal(first.landed,first.commit,'checked out nowhere, so the ref moved to the work itself');
  const tip=sh(root,['rev-parse','staging']);

  const again=await s.port(t.id,{to:'staging'});
  assert.equal(again.alreadyPorted,true);
  assert.equal(again.landed,null);
  assert.deepEqual(again.next,[],'nothing left to run');
  assert.equal(sh(root,['rev-parse','staging']),tip,'the target did not move');
  assert.equal(sh(root,['rev-list','--merges','--count','staging']),'0','and no merge commit was added');
});

test('a diff read after the worktree is removed still shows the work',async()=>{
  // --clean takes the directory and leaves the commit, so the pane a person opens
  // afterwards has to read the change off the commit. An empty pane reads as the work
  // having been lost, which is the opposite of what happened.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  sh(root,['branch','staging',currentBranch(root)]);
  await s.port(t.id,{to:'staging',clean:true});
  const d=s.diff(t.id,{to:'staging'});
  assert.equal(d.worktree,false,'the directory is gone');
  assert.equal(d.committed,true,'and the commit is not');
  assert.equal(d.pending,false);
  assert.match(d.diff,/written by the mock implementer/,'the change is still on screen');
  assert.deepEqual(d.files,['app.mjs'],'and the file it touches is still named');
});

test('a port is refused while the task has a run in flight',async()=>{
  // A port is not a job, so the partial unique index on jobs does not cover it, and
  // this process's run registry cannot see a run the dashboard owns. Committing the
  // worktree under a live implementer publishes half a tree and moves the branch
  // beneath the agent still writing it.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  s.store.addRun({id:'live',taskId:t.id,role:'implementer',providerId:'mock',modelId:'mock',status:'running',startedAt:new Date().toISOString()});
  s.store.heartbeat('live',t.id);
  await assert.rejects(()=>s.port(t.id,{to:'staging'}),/in flight/);
});

test('a port is refused while the task has a job queued',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  // Queued but not started: the row alone is the signal, which is the half of the
  // guard that no lease can see, because a job that has not begun has no run.
  s.store.addJob({id:'job-1',taskId:t.id,kind:'execute',state:'queued',createdAt:new Date().toISOString()});
  await assert.rejects(()=>s.port(t.id,{to:'staging'}),/in flight/);
});

test('a plan is refused while a planner run is in flight',async()=>{
  // A task sits in PLANNING for the whole planning run - it moves only once the plan
  // has been written - so the state check above admits a second planner. Liveness has
  // to come from the lease, which is also the only thing that sees a run belonging to
  // the dashboard process rather than to this one.
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true});
  const t=s.createTask(s.initProject('p',root).id,'x');
  s.prepare(t.id);
  s.store.addRun({id:'live',taskId:t.id,role:'planner',providerId:'mock',modelId:'mock',status:'running',startedAt:new Date().toISOString()});
  s.store.heartbeat('live',t.id);
  await assert.rejects(()=>s.plan(t.id),/in flight/);
});

test('a refine is refused while a planner run is in flight',async()=>{
  // The incident this came from. A refine never leaves AWAITING_APPROVAL, not even
  // while its planner is running, so a second refine submitted mid-run was accepted:
  // it routed somewhere else, died for its own reasons, and reported those reasons as
  // the failure of the user's feedback.
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true});
  const t=s.createTask(s.initProject('p',root).id,'x');
  s.prepare(t.id);await s.plan(t.id);
  assert.equal(s.task(t.id).state,'AWAITING_APPROVAL');
  s.store.addRun({id:'live',taskId:t.id,role:'planner',providerId:'mock',modelId:'mock',status:'running',startedAt:new Date().toISOString()});
  s.store.heartbeat('live',t.id);
  await assert.rejects(()=>s.refine(t.id,'make it smaller'),/in flight/);
});

test('a second review is refused while a review is running',async()=>{
  // The queue does not cover this one: jobs_one_active guards only the queued path,
  // and a dashboard Review button starts no job at all. Two reviewers over one
  // worktree would race to write the verdict and to move the task out of REVIEWING.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  await s.runTests(t.id);
  assert.equal(s.task(t.id).state,'REVIEWING');
  s.store.addRun({id:'live',taskId:t.id,role:'reviewer',providerId:'mock',modelId:'mock',status:'running',startedAt:new Date().toISOString()});
  s.store.heartbeat('live',t.id);
  await assert.rejects(()=>s.review(t.id),/in flight/);
});

test('a plan is refused while the task has a job queued',async()=>{
  // The half no lease can see: a job that has not started has no run yet.
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true});
  const t=s.createTask(s.initProject('p',root).id,'x');
  s.prepare(t.id);
  s.store.addJob({id:'job-1',taskId:t.id,kind:'execute',state:'queued',createdAt:new Date().toISOString()});
  await assert.rejects(()=>s.plan(t.id),/in flight/);
});

test('a lease that has gone stale does not refuse a plan',async()=>{
  // The guard is lease-based and not a latch. A lease is evidence of life only while
  // it is fresh; read as "a run row exists", the run left behind by a process that
  // died mid-plan would refuse every retry and strand the task in PLANNING.
  const root=repo();
  const s=new Service(root,{allowMock:true,silent:true});
  const t=s.createTask(s.initProject('p',root).id,'x');
  s.prepare(t.id);
  s.store.addRun({id:'dead',taskId:t.id,role:'planner',providerId:'mock',modelId:'mock',status:'running',startedAt:new Date().toISOString()});
  s.store.heartbeat('dead',t.id);
  s.store.db.prepare('UPDATE run_leases SET heartbeat_at=? WHERE run_id=?')
    .run(new Date(Date.now()-LEASE_STALE_MS-1000).toISOString(),'dead');
  await s.plan(t.id);
  assert.equal(s.task(t.id).state,'AWAITING_APPROVAL');
});

test('editing a plan keeps the revision it replaced',async()=>{
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);
  const v1=s.task(t.id).plan;
  s.updatePlan(t.id,'v2 first line\nv2 second line');
  const after=s.task(t.id);
  assert.equal(after.plan_prev,v1,'the revision it replaced, not the one before that');
  assert.ok(Date.parse(after.plan_at)>0,'and when this one landed');
  const r=s.revision(after);
  assert.equal(r.at,after.plan_at);
  assert.equal(r.hasPrev,true);
  assert.equal(r.changed,true,'which is the condition the views key off, not hasPrev');
  assert.match(r.diff,/-Proposed plan/);
  assert.match(r.diff,/\+v2 first line/);
});

test('the plan columns survive the positional write they go through',async()=>{
  // updateTask builds a positional SET list from a hand-ordered argument list of the
  // same length. There is no type to catch a slip: plan, plan_prev, context and review
  // are all TEXT, so a mid-list insertion writes a plan into context with no error and
  // no symptom until a screen renders nonsense. This is the assertion that would fail.
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);
  const v1=s.task(t.id).plan;
  s.store.updateTask(t.id,{context:'CONTEXT_MARKER',review:'REVIEW_MARKER'});
  s.updatePlan(t.id,'PLAN_MARKER');
  const after=s.task(t.id);
  assert.equal(after.plan,'PLAN_MARKER');
  assert.equal(after.plan_prev,v1);
  assert.equal(after.context,'CONTEXT_MARKER','context still holds context');
  assert.equal(after.review,'REVIEW_MARKER','and review still holds a review');
});

test('a refine records the plan it replaced, and the diff is against that one',async()=>{
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);
  const v1=s.task(t.id).plan;
  // Set after the first plan, so the two revisions really differ. The mock planner's
  // text is fixed otherwise, and a refine that returns its own input is deliberately
  // not recorded as a revision at all.
  s.updateProvider('mock',{config:{routable:false,planText:'Revised: do the smaller thing.'}});
  await s.refine(t.id,'make it smaller');
  const after=s.task(t.id);
  assert.equal(after.plan,'Revised: do the smaller thing.');
  assert.equal(after.plan_prev,v1);
  const r=s.revision(after);
  assert.equal(r.changed,true);
  assert.match(r.diff,/-Proposed plan/);
  assert.match(r.diff,/\+Revised: do the smaller thing\./);
});

test('a refine that changes nothing is not recorded as a revision',async()=>{
  // The plan_at column is what the dashboard's "revised" marker compares, so a run
  // that returned its own input would announce a new plan that is the old one - and
  // the diff it offers would then be empty, contradicting the announcement.
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);
  const at=s.task(t.id).plan_at;
  await s.refine(t.id,'say something encouraging');
  const after=s.task(t.id);
  assert.equal(after.plan_at,at,'the same revision, so the same timestamp');
  assert.equal(s.revision(after).changed,false);
});

test('a rejected plan takes its provenance with it',async()=>{
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);
  s.updatePlan(t.id,'a second version');
  s.reject(t.id);
  const rejected=s.task(t.id);
  assert.equal(rejected.plan,null);
  assert.equal(rejected.plan_prev,null,'or the next plan is diffed against one the user refused');
  assert.equal(rejected.plan_at,null);
  assert.equal(s.revision(rejected).changed,false);
  await s.plan(t.id);
  assert.equal(s.task(t.id).plan_prev,null,'and the plan after the rejection has no predecessor');
});

test('the revision columns are added to a database that predates them',()=>{
  // ensureColumn is the migration path for every install that already had a database
  // when these two columns were introduced, and nothing else here exercises it: every
  // other test builds a store from scratch, where CREATE TABLE has made them already.
  // A column that gets dropped from the map is invisible in the whole rest of the suite.
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  s.store.db.exec('ALTER TABLE tasks DROP COLUMN plan_prev');
  s.store.db.exec('ALTER TABLE tasks DROP COLUMN plan_at');
  const reopened=new Service(root,{allowMock:true,silent:true});
  const cols=reopened.store.db.prepare('PRAGMA table_info(tasks)').all().map((c)=>c.name);
  assert.ok(cols.includes('plan_prev'));
  assert.ok(cols.includes('plan_at'));
});

test('the plan records the branch it was written against',async()=>{
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);
  assert.equal(JSON.parse(s.task(t.id).plan_base).target_branch,currentBranch(root));
});

test('a plan written on a detached HEAD records no target rather than the word HEAD',async()=>{
  // symbolic-ref fails when HEAD is detached, where --abbrev-ref would answer with
  // the literal string "HEAD" and hand the port a branch by that name.
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  sh(root,['checkout','--detach','-q']);
  const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);
  assert.equal(JSON.parse(s.task(t.id).plan_base).target_branch,null);
  // And the port still resolves, from the live answer, rather than throwing.
  assert.equal(s.portTarget(s.task(t.id),{to:'staging'}),'staging','--to still wins');
  assert.throws(()=>s.portTarget(s.task(t.id)),/detached/,'and with no way to name one it says why');
});

// -- the verdict a surface leads with -------------------------------------
//
// A port screen has to say which of a handful of states the work is in before any of the
// detail, and the states are not interchangeable - "there is nothing to port" and "it has
// already landed" are both quiet and mean opposite things. Derived in `assess` rather than
// in the tab so the CLI answers the same question the same way.

test('the verdict is uncommitted while the work is only in the worktree',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const v=s.diff(t.id);
  assert.equal(v.state.key,'pending');
  assert.equal(v.committed,false,'nothing has been published yet');
  assert.ok(v.next.some((x)=>x.command),'and there is something to run, which the state is not saying instead of');
});

test('the verdict is blocked when the destination is dirty in a file the change touches',async()=>{
  // Not a conflict, and the difference is the point: git compares the two sides in the
  // object store, where the destination's uncommitted work does not appear. It refuses
  // the merge anyway, and telling someone that before they read the diff is the reason
  // this is assessed at all.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  s.materialize(t.id);
  fs.writeFileSync(path.join(root,'app.mjs'),'uncommitted at the destination\n');
  const v=s.diff(t.id);
  assert.equal(v.state.key,'blocked');
  assert.deepEqual(v.blockedBy,['app.mjs']);
  assert.equal(v.clean,true,'the merge itself is clean, which is why this is its own state');
});

test('a live worktree with nothing uncommitted reads the change off the commit',async()=>{
  // The worktree's existence is not the test for where the change is. Using it as one
  // showed an empty pane for a worktree whose work had already been committed, and an
  // empty diff is read as the work being gone - which is the reading this screen exists
  // to prevent.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  s.materialize(t.id);
  const v=s.diff(t.id);
  assert.equal(v.worktree,true,'the directory is still there');
  assert.equal(v.pending,false,'and it has nothing left uncommitted');
  assert.equal(v.from,'commit');
  assert.match(v.diff,/diff --git a\/app\.mjs/,'so the change is shown rather than an empty pane');
});

test('a task with no work and no commit has no port to offer',async()=>{
  const root=repoWith('app.mjs');
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'inspect the module and change nothing');
  s.prepare(t.id);await s.plan(t.id);s.approve(t.id);await s.implement(t.id);
  const v=s.diff(t.id);
  assert.equal(v.state.key,'empty');
  assert.equal(v.committed,false);
  assert.deepEqual(v.next,[]);
  assert.equal(v.from,'none');
});

test('landing names the merge commit and the work as two different commits',async()=>{
  // The case a person lands in by running the command a port printed, and the one worth
  // being able to look up afterwards: the work is a commit of its own and the merge is
  // another, so "it is in main" is a claim with two hashes behind it rather than one.
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  const target=currentBranch(root);
  // The destination advances first, so this cannot be a fast-forward and a merge commit
  // is what carries the work in.
  fs.writeFileSync(path.join(root,'README.md'),'a newer commit\n');
  sh(root,['add','.']);commitAs(root,'the target moved on');

  const r=await s.port(t.id,{to:target});
  const ready=s.diff(t.id,{to:target});
  assert.equal(ready.state.key,'ready','committed, clean, and waiting on the merge to be run');
  assert.equal(ready.landedAs,null,'which is why there is no landed commit to name yet');

  sh(root,['merge',t.branch]);
  const v=s.diff(t.id,{to:target});
  assert.equal(v.state.key,'landed');
  // The verdict is prose written from the assessment, so it is asserted on: a state
  // whose sentence interpolates a field the assessment never carried reads "undefined
  // already contains this work", which no assertion on the key alone would catch.
  assert.match(v.state.headline,/main already contains this work/);
  assert.ok(!JSON.stringify(v.state).includes('undefined'),'no field the verdict names is missing');
  assert.equal(v.taskCommit.sha,r.commit,"the task's commit is the work");
  assert.equal(v.taskCommit.short,v.taskCommit.sha.slice(0,7));
  assert.match(v.taskCommit.subject,/change the button colour/);
  assert.notEqual(v.landedAs.sha,v.taskCommit.sha,'a merge is its own commit');
  assert.equal(v.landedAs.sha,sh(root,['rev-parse',target]),'and it is what the destination points at');
  assert.equal(sh(root,['rev-list','--merges','--count',v.landedAs.sha]),'1');
  assert.equal(v.next.length,0,'nothing left to run');
});

test('a fast-forward names the work itself, because no other commit carried it',async()=>{
  const root=repoWith('app.mjs');
  const {s,t}=await worked(root);
  sh(root,['branch','staging',currentBranch(root)]);
  const r=await s.port(t.id,{to:'staging'});
  const v=s.diff(t.id,{to:'staging'});
  assert.equal(v.state.key,'landed');
  assert.equal(v.landedAs.sha,v.taskCommit.sha,'one commit, and it is both the work and how it arrived');
  assert.equal(v.landedAs.sha,r.commit);
});

test('diffLines numbers only the lines that are content',()=>{
  // The gutter bug this replaces: every line that is not content advanced both
  // counters, so one file header, mode change or no-newline note shifted the two
  // gutters from that line to the end of the diff. Each assertion below names one
  // of those, because each one is a line git emits in an ordinary diff.
  const diff=[
    'diff --git a/old.txt b/new.txt',
    'old mode 100644',
    'new mode 100755',
    'similarity index 87%',
    'rename from old.txt',
    'rename to new.txt',
    'index 1111111..2222222 100644',
    '--- a/new.txt',
    '+++ b/new.txt',
    // A hunk that does not start at line 1, because one that does cannot tell a read
    // header from an unread one: both counters begin at zero either way, and the
    // gutter is right by accident. This is where the hunk's start lines are pinned.
    '@@ -40,3 +50,4 @@',
    ' one',
    '-two',
    '+TWO',
    '+three',
    ' four',
    '\\ No newline at end of file',
    'diff --git a/bin.dat b/bin.dat',
    'index 3333333..4444444 100644',
    'GIT binary patch',
    'literal 0',
  ].join('\n');
  const rows=diffLines(diff);
  const at=(text)=>rows.find((r)=>r.text===text);

  // The header pair is a file header, not a deletion and an addition.
  assert.equal(at('--- a/new.txt').cls,'diff-file');
  assert.equal(at('+++ b/new.txt').cls,'diff-file');
  // The hunk re-seeds both counters from its own header, and each counter carries the
  // start line of its own side of it: the old file counts this hunk from 40, the new
  // file from 50.
  assert.equal(at(' one').old,'40');
  assert.equal(at(' one').new,'50');
  assert.equal(at('-two').old,'41');
  assert.equal(at('+TWO').new,'51');
  assert.equal(at('+three').new,'52');
  assert.equal(at(' four').old,'42');
  assert.equal(at(' four').new,'53');
  // And the metadata between them belongs to neither file, so it carries no number.
  for(const text of ['old mode 100644','new mode 100755','similarity index 87%','rename from old.txt','rename to new.txt','index 1111111..2222222 100644','\\ No newline at end of file','GIT binary patch','literal 0']){
    assert.equal(at(text).old,'',`${text} is not a line of the old file`);
    assert.equal(at(text).new,'',`${text} is not a line of the new file`);
  }
  // A second file section restarts the header/content distinction, and the `---`
  // line in it is a header again rather than a deletion.
  assert.equal(rows[rows.length-1].cls,'diff-meta');
});

test('diffLines reads a deleted line that looks like a file header as content',()=>{
  // `--- x` is a file header before the first hunk and a deleted line after it. A
  // diff of a markdown file is full of thematic breaks, and reading one as a header
  // would drop a real deletion from the gutter.
  const rows=diffLines(['diff --git a/notes.md b/notes.md','--- a/notes.md','+++ b/notes.md','@@ -1,2 +1,2 @@',' ---','-gone','+kept'].join('\n'));
  assert.equal(rows[1].cls,'diff-file');
  assert.equal(rows[4].cls,'diff-ctx');
  assert.equal(rows[5].cls,'diff-del');
  assert.equal(rows[5].old,'2');
  assert.equal(rows[6].new,'2');
});

test('diffSides pairs a run of deletions with the run of additions after it',()=>{
  // A rewrite is one block of `-` lines followed by one block of `+` lines, and the
  // split view's whole job is to put them opposite each other. The shorter side is
  // padded rather than the block being broken up, so both numbers below still name
  // the line they came from: the deletion counts under the old file, the addition
  // under the new one, and neither is the other's number.
  const rows=diffSides(['diff --git a/app.mjs b/app.mjs','--- a/app.mjs','+++ b/app.mjs','@@ -1,5 +1,3 @@',' import a','-old1','-old2','-old3','+new1',' keep'].join('\n'));
  // The four lines before the first change are about the diff, not about a line of
  // either version, so they span both columns instead of filling one.
  assert.deepEqual(rows.slice(0,4).map((r)=>r.kind),['span','span','span','span']);
  // An unchanged line is a row of its own, on both sides at once.
  assert.equal(rows[4].left.cls,'diff-ctx');
  assert.equal(rows[4].right.cls,'diff-ctx');
  // A deletion and an addition sit opposite each other, each numbered by its own file.
  assert.deepEqual(rows[5].left,{no:'2',text:'-old1',cls:'diff-del'});
  assert.deepEqual(rows[5].right,{no:'2',text:'+new1',cls:'diff-add'});
  // Three deletions against one addition: the two extra rows keep their left side and
  // carry an empty right one, so a block is as tall as its longest side.
  assert.equal(rows[6].left.no,'3');
  assert.equal(rows[6].right,null);
  assert.equal(rows[7].left.text,'-old3');
  assert.equal(rows[7].right,null);
  // The last unchanged line is counted one higher by the old file than by the new one,
  // which is the three-into-one deletion the pairing above is showing.
  assert.equal(rows[8].left.no,'5');
  assert.equal(rows[8].right.no,'3');
  assert.equal(rows.length,9);
});

test('diffSides pads the other side, and never pairs across a hunk',()=>{
  // The mirror of the test above - more additions than deletions - and then a second
  // hunk, because a hunk header is where a run ends. Without that, the deletions of
  // the first hunk would pair against the additions of the second and the two halves
  // would describe changes that have nothing to do with each other.
  const rows=diffSides([
    'diff --git a/app.mjs b/app.mjs','--- a/app.mjs','+++ b/app.mjs',
    '@@ -1,2 +1,3 @@',' ctx','-one','+ONE','+extra',
    '@@ -20,2 +21,2 @@',' ctx2','-two','+TWO',
  ].join('\n'));
  assert.equal(rows[5].left.text,'-one');
  assert.equal(rows[5].right.text,'+ONE');
  assert.equal(rows[6].left,null);
  assert.equal(rows[6].right.text,'+extra');
  // The second hunk's header spans, and the pair after it is its own.
  assert.equal(rows[7].kind,'span');
  assert.equal(rows[7].line.cls,'diff-hunk');
  assert.equal(rows[9].left.text,'-two');
  assert.equal(rows[9].right.text,'+TWO');
  // Numbers are read per hunk, off that hunk's own header start lines: this hunk
  // begins at old 20 and new 21, so the deletion and the addition below it are a line
  // apart rather than equal. A splintered counter would have carried the first hunk's
  // numbering into this one.
  assert.equal(rows[8].left.no,'20');
  assert.equal(rows[8].right.no,'21');
  assert.equal(rows[9].left.no,'21');
  assert.equal(rows[9].right.no,'22');
  assert.equal(rows.length,10);
});

// -- unifiedDiff: the producer for the format the two tests above consume ---------
//
// Every assertion here round-trips through diffLines rather than counting characters,
// because the contract that matters is not "this is the diff git would write" - it is
// "the reader renders it correctly", and the reader is diffLines.

test('a diff of two texts is read back with the right numbers on both sides',()=>{
  const diff=unifiedDiff('one\ntwo\nthree','one\nTWO\nthree');
  assert.equal(diff.split('\n')[0],'diff --git a/plan b/plan','a file section, which is what closes a hunk for the reader');
  const rows=diffLines(diff);
  const by=(cls)=>rows.filter(r=>r.cls===cls);
  assert.equal(by('diff-add').length,1);
  assert.equal(by('diff-del').length,1);
  assert.equal(by('diff-add')[0].text,'+TWO');
  // The replacement sits on line 2 of both sides, so the numbers have to agree with
  // each other and with the surrounding context, not merely be present.
  assert.equal(by('diff-del')[0].old,'2');
  assert.equal(by('diff-add')[0].new,'2');
  assert.equal(by('diff-ctx')[0].old,'1');
  assert.equal(by('diff-ctx')[0].new,'1');
  assert.equal(by('diff-ctx')[1].old,'3');
  assert.equal(by('diff-ctx')[1].new,'3');
});

test('an insertion is numbered without counting itself as an old line',()=>{
  const rows=diffLines(unifiedDiff('one\nthree\nfour','one\ntwo\nthree\nfour'));
  assert.equal(rows.find(r=>r.cls==='diff-add').text,'+two');
  assert.equal(rows.filter(r=>r.cls==='diff-del').length,0,'an insertion deletes nothing');
  // The line after the insertion has moved down on the new side and not on the old:
  // this is the assertion a counter that incremented both sides would fail.
  const after=rows.filter(r=>r.cls==='diff-ctx').pop();
  assert.equal(after.text,' three');
  assert.equal(after.old,'2','unchanged by the insertion');
  assert.equal(after.new,'3','and one line further down than the old side has it');
});

test('a deletion is numbered the same way round',()=>{
  const rows=diffLines(unifiedDiff('one\ntwo\nthree','one\nthree'));
  assert.equal(rows.find(r=>r.cls==='diff-del').text,'-two');
  const after=rows.filter(r=>r.cls==='diff-ctx').pop();
  assert.equal(after.old,'3');
  assert.equal(after.new,'2');
});

test('a diff of identical text is empty, so a caller can ask whether there is one',()=>{
  assert.equal(unifiedDiff('one\ntwo\nthree','one\ntwo\nthree'),'');
  assert.equal(unifiedDiff('',''),'');
  // A trailing newline is not a line. Both of these describe the same three lines,
  // and the diff of a plan against itself must not be a blank-line change.
  assert.equal(unifiedDiff('one\ntwo\n','one\ntwo'),'');
});

test('hunks are far apart only when the change is, and the gap between them is context',()=>{
  const para=(n)=>Array.from({length:n},(_,i)=>`line ${i}`);
  const before=[...para(12),'old'];
  const after=[...para(12),'new'];
  const one=diffLines(unifiedDiff(before.join('\n'),after.join('\n')));
  assert.equal(one.filter(r=>r.cls==='diff-hunk').length,1,'a single change is a single hunk');
  assert.equal(unifiedDiff('a\nb\nc\nd\ne\nf','A\nb\nc\nd\ne\nF').split('\n').filter(l=>l.startsWith('@@')).length,2,'two changes far apart are two hunks, so neither carries a screenful of the other');
});

test('every diff carries the file section and the body kind the renderer reads',()=>{
  const diff=unifiedDiff('a\nb','a\nB');
  assert.equal(bodyKind(diff),'diff','the port tab decides how to render from this');
  assert.equal(diffLines(diff).filter(r=>r.cls==='diff-file').length,2,'the --- and +++ headers, which the reader must not number');
});

test('a plan may contain lines that look like diff metadata',()=>{
  // The reason diffLines keeps a hunk flag at all: `--- ` and `+++ ` are content inside
  // a hunk and headers outside one, and a plan is prose that can begin a line with
  // anything - a markdown rule, a bullet, an underline.
  const rows=diffLines(unifiedDiff('intro','intro\n--- \n+++ not a header'));
  // The generator's own prefix is the leading +, so the second line's text really does
  // begin with four of them: three are content and one is the diff marker.
  assert.deepEqual(rows.slice(-2).map(r=>r.text),['+--- ','++++ not a header']);
  assert.deepEqual(rows.slice(-2).map(r=>r.cls),['diff-add','diff-add'],'content, not file headers, because a hunk is open above them');
  assert.equal(rows.filter(r=>r.cls==='diff-file').length,2,'the only file headers are the two the generator wrote');
});
test('closeTask succeeds from CREATED',()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');const closed=s.closeTask(t.id);assert.equal(closed.state,'CANCELLED')});
test('closeTask succeeds from PLANNING with no run',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);const closed=s.closeTask(t.id);assert.equal(closed.state,'CANCELLED')});
test('closeTask throws when a run is live',()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);s.store.addRun({id:'live',taskId:t.id,role:'planner',providerId:'mock',modelId:'mock',status:'running',startedAt:new Date().toISOString()});s.store.heartbeat('live',t.id);let threw=false;try{s.closeTask(t.id)}catch(e){threw=true;assert.match(e.message,/task cancel/)}assert.ok(threw,'closeTask should have thrown');
// A cancel only marks the lease; the process that owns the run releases it on the way out. Until then the run is still driving the task - which is the whole point of gating on liveness rather than on the task's state, so close keeps refusing after the cancel and unblocks when the lease goes.
s.cancelTask(t.id);let stillThrew=false;try{s.closeTask(t.id)}catch(e){stillThrew=true;assert.match(e.message,/task cancel/)}assert.ok(stillThrew,'a cancelled-but-unreleased run is still live');s.store.releaseLease('live');const closed=s.closeTask(t.id);assert.equal(closed.state,'CANCELLED')});
test('CANCELLED is a terminal state',()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.closeTask(t.id);assert.throws(()=>s.transition(t.id,'PLANNING'),/Invalid transition/)});
test('closeTask removes the worktree if it exists',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);const beforeClose=s.task(t.id);assert.equal(beforeClose.state,'APPROVED');const wtDir=createWorktree(s.project(p.id).path,t.id);s.store.updateTask(t.id,{worktree:wtDir.dir,branch:wtDir.branch,base_commit:wtDir.base});assert.ok(fs.existsSync(wtDir.dir));s.closeTask(t.id);assert.equal(fs.existsSync(wtDir.dir),false)});
