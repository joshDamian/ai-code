import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {Service} from '../src/service.mjs';
function repo(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-'));execFileSync('git',['init','-q'],{cwd:d});fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));fs.writeFileSync(path.join(d,'README.md'),'x');execFileSync('git',['add','.'],{cwd:d});execFileSync('git',['-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','init'],{cwd:d});return d}
test('approval is mandatory',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);await assert.rejects(()=>s.execute(t.id),/approval/i)});
test('mock full workflow completes',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);s.approve(t.id);const done=await s.execute(t.id);assert.equal(done.state,'COMPLETE');assert.ok(s.store.listRuns(t.id).length>=3)});
test('worktree is isolated',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);const a=s.createTask(p.id,'a');const b=s.createTask(p.id,'b');s.prepare(a.id);s.prepare(b.id);await s.plan(a.id);await s.plan(b.id);s.approve(a.id);s.approve(b.id);await s.execute(a.id);await s.execute(b.id);const ta=s.task(a.id),tb=s.task(b.id);assert.notEqual(ta.worktree,tb.worktree);assert.equal(fs.existsSync(ta.worktree),true);assert.equal(fs.existsSync(tb.worktree),true)});
test('provider fallback',async()=>{const root=repo();const s=new Service(root,{allowMock:true});const p=s.initProject('p',root);s.addProvider({id:'bad',name:'Bad',kind:'mock',enabled:true,config:{failRoles:['planner']}});s.addProvider({id:'good',name:'Good',kind:'mock',enabled:true,config:{}});for(const id of ['bad','good'])s.store.addModel({id:id+'-m',providerId:id,name:id,capabilities:['planning','coding','review','repair'],speed:10,cost:0,quality:id==='bad'?20:10,contextLength:100000});const t=s.createTask(p.id,'x');s.prepare(t.id);await s.plan(t.id);const runs=s.store.listRuns(t.id);assert.equal(runs.filter(r=>r.status==='failed').length,1);assert.equal(runs.filter(r=>r.status==='succeeded').length,1)});


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
