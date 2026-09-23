import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {spawn,execFileSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {Service} from '../src/service.mjs';
function get(url){return new Promise((res,rej)=>http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res({status:r.statusCode,body:b}))}).on('error',rej))}
function post(url,payload){return new Promise((res,rej)=>{const data=JSON.stringify(payload||{});const u=new URL(url);const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res({status:r.statusCode,body:b}))});req.on('error',rej);req.write(data);req.end()})}
// Reads an event stream to its end. The deadline is the point of the test: a
// stream that only stops at the server's absolute tick cap has failed it.
function stream(url,deadlineMs=25000){return new Promise((res,rej)=>{const req=http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{clearTimeout(t);res({status:r.statusCode,body:b})})});const t=setTimeout(()=>{req.destroy();rej(new Error(`stream still open after ${deadlineMs}ms`))},deadlineMs);req.on('error',(e)=>{clearTimeout(t);rej(e)})})}
const frames=(body)=>body.split('\n\n').filter(Boolean).map(f=>{const [head,...rest]=f.split('\n');const type=head.replace('event: ','');const raw=rest.join('\n').replace('data: ','');let data=null;try{data=JSON.parse(raw)}catch{}return {type,data}});

// A root seeded before the server starts, so the server only has to serve it: a
// fast mock plans and a slow one implements, which is what leaves a run in flight
// long enough to be cancelled from outside the process.
const git=(cwd,args)=>execFileSync('git',args,{cwd,stdio:'ignore'});

function seeded(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-http-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  // The seeded test provider answers every role instantly. Left enabled it would
  // be the last-resort mock for both roles and the delay below would never apply.
  s.updateProvider('mock',{enabled:false});
  s.addProvider({id:'planner',name:'Planner',kind:'mock',enabled:true,config:{routable:true}});
  s.addProvider({id:'worker',name:'Worker',kind:'mock',enabled:true,config:{routable:true,delayMs:30000}});
  s.addModel({id:'planner-m',providerId:'planner',name:'planner',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});
  s.addModel({id:'worker-m',providerId:'worker',name:'worker',capabilities:['coding','review','repair'],speed:10,quality:10,cost:0,contextLength:100000});
  const t=s.createTask(p.id,'serve the api');
  s.prepare(t.id);
  return {root,taskId:t.id};
}

// The CLI runs with the fixture as its working directory, since that is where it
// looks for the database, so its own path has to be absolute.
const cliPath=path.resolve('src/cli.mjs');

// A fresh git repo for tests that need separate project directories.
function gitRepo(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-list-'));git(d,['init','-q']);fs.writeFileSync(path.join(d,'README.md'),'x');git(d,['add','.']);git(d,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);return d}

// A port nobody is holding. Hardcoding these is how this suite once went green
// against a stranger's server: the child failed to bind, exited, and the poll that
// was supposed to prove the dashboard answered was answered by whatever already had
// the port.
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>res(port))})})}

// One readiness attempt, bounded. A port held by something that accepts the
// connection and then never answers does not fail the request, it hangs it - so
// without this the wait below never reaches its own deadline.
function probe(url,ms=750){
  return new Promise((res)=>{const t=setTimeout(()=>res(null),ms);get(url).then((r)=>{clearTimeout(t);res(r)}).catch(()=>{clearTimeout(t);res(null)})});
}

// Spawns the real server and waits until it is the thing answering. A fixed sleep
// cannot tell a bound server from a broken one, and cannot tell either from the
// stale process on the same port that makes the difference invisible.
async function startServer(root,extra={}){
  const port=await freePort();
  const proc=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),env:{...process.env,AI_CODE_ROOT:root,PORT:String(port),...extra},stdio:['ignore','pipe','pipe']});
  const base=`http://localhost:${port}`;
  let stderr='';let exited=null;
  proc.stderr.on('data',(c)=>{stderr+=c});
  proc.on('exit',(code)=>{if(!exited)exited={code}});
  const deadline=Date.now()+20000;
  for(;;){
    if(exited){throw new Error(`server exited (${exited.code}) before it answered on :${port}\n${stderr}`)}
    // The child exiting is checked first and every time: a server that cannot bind
    // dies on EADDRINUSE, and a squatter on the port would answer this poll for it.
    if((await probe(`${base}/api/overview`))?.status===200) break;
    if(Date.now()>deadline){proc.kill('SIGKILL');throw new Error(`server never answered on :${port}\n${stderr}`)}
    await new Promise(r=>setTimeout(r,25));
  }
  return {proc,base,port,stderr:()=>stderr,stop:()=>proc.kill('SIGTERM')};
}

test('dashboard API responds',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-server-'));const s=await startServer(root);try{const r=await get(`${s.base}/api/overview`);assert.equal(r.status,200);assert.ok(JSON.parse(r.body).providers)}finally{s.stop()}});

test('dashboard control-plane APIs exist',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-api-'));const s=await startServer(root);try{for(const u of ['/api/providers','/api/routing','/api/runs','/api/usage','/api/automations','/api/doctor','/api/jobs']){const r=await get(s.base+u);assert.equal(r.status,200,u)}}finally{s.stop()}});

// The dashboard renders events with the CLI's own formatters, served from src/
// rather than copied into web/. If that route stops working the activity tab goes
// blank, and nothing in the unit suite would notice.
test('the browser can load the shared formatters',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-shared-'));const s=await startServer(root);try{const r=await get(`${s.base}/shared/format.mjs`);assert.equal(r.status,200);assert.match(r.body,/export function describeEvent/);assert.match(r.body,/export function formatEvent/);
  // diffLines is what the port tab numbers its diff with, so a dropped export would
  // take the gutter with it - and nothing in the unit suite imports through here.
  // diffSides is the split view's other half; an export missing here is a blank pane
  // in the one view nothing on the server side would otherwise exercise.
  assert.match(r.body,/export function diffLines/);assert.match(r.body,/export function diffSides/);
  // unifiedDiff is the producer for what the two above consume, and it is only ever
  // reached from a view: the revision panel is the sole caller, so nothing on the
  // server side would notice the export going missing.
  assert.match(r.body,/export function unifiedDiff/)}finally{s.stop()}});

test('the dashboard pins the markdown renderer and the sanitiser beside it',async()=>{
  // The plan and review tabs hand untrusted model text to these two modules, so a
  // dropped pin or a specifier renamed without the import that uses it would break
  // the tab at render time rather than at load. This is the same class of check as
  // the shared-route test above: assert the served asset says what it must say.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-md-'));const s=await startServer(root);
  try{
    const r=await get(`${s.base}/`);
    assert.equal(r.status,200);
    const pins={
      'marked':'https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.esm.js',
      'dompurify':'https://cdn.jsdelivr.net/npm/dompurify@3.4.15/dist/purify.es.mjs',
    };
    for(const [name,url] of Object.entries(pins)){
      const re=new RegExp(`"${name}"\\s*:\\s*"${url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"`);
      assert.match(r.body,re,`the import map should pin ${name}`);
    }
  }finally{s.stop()}
});

test('a background job stops when cancelled from another process and the stream ends with it',async()=>{
  const {root,taskId}=seeded();
  const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  const base=server.base;
  try{
    await post(`${base}/api/tasks/${taskId}/plan`);
    await post(`${base}/api/tasks/${taskId}/approve`);
    assert.equal(JSON.parse((await get(`${base}/api/tasks/${taskId}/show`)).body).task.state,'APPROVED');

    // Opened before the work starts, so the stream observes the task move. That is
    // what makes its termination meaningful rather than a resting task ending at once.
    const reading=stream(`${base}/api/tasks/${taskId}/stream`,25000);
    const queued=await post(`${base}/api/tasks/${taskId}/execute/background`);
    assert.equal(queued.status,202,'queued, not blocked on');
    const job=JSON.parse(queued.body);
    // `running` rather than `queued` when a slot was free: the queue dispatches
    // synchronously, so the row is already claimed by the time it is serialised.
    assert.ok(['queued','running'].includes(job.state),`job is ${job.state}`);
    assert.equal(job.task_id,taskId);

    // The slow mock holds the implementer open until the cancel reaches it.
    await new Promise(r=>setTimeout(r,500));
    await post(`${base}/api/tasks/${taskId}/cancel`);

    const started=Date.now();
    const {body}=await reading;
    const elapsed=Date.now()-started;
    const seen=frames(body);
    const lastState=seen.filter(f=>f.type==='state').pop();

    assert.equal(lastState.data.task.state,'APPROVED','a cancelled run reverts the task so it can be executed again');
    assert.ok(elapsed<20000,'the stream ended when the task stopped, not at the 180s tick cap');
    const runs=JSON.parse((await get(`${base}/api/runs?taskId=${taskId}`)).body);
    assert.equal(runs.filter(r=>r.role==='implementer')[0].status,'cancelled','the run in flight was stopped, not left running');
    assert.equal(JSON.parse((await get(`${base}/api/jobs?taskId=${taskId}`)).body)[0].state,'cancelled');
  }finally{server.stop()}
});

test('show carries the revision of the plan, against the one it replaced',async()=>{
  // The dashboard's whole revision panel reads from this one key: the diff, whether
  // there is one to show, and the timestamp the "revised" marker compares per tick.
  const {root,taskId}=seeded();
  // The fixture's planner is a mock provider, so the server has to be told mocks are
  // routable - production routing excludes them by construction.
  const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  const base=server.base;
  try{
    assert.equal((await post(`${base}/api/tasks/${taskId}/plan`)).status,200);
    const first=JSON.parse((await get(`${base}/api/tasks/${taskId}/show`)).body);
    assert.equal(first.revision.changed,false,'a first plan replaced nothing');
    assert.equal(first.revision.hasPrev,false);
    assert.equal(first.revision.diff,'');

    const patched=await fetch(`${base}/api/tasks/${taskId}/plan`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({plan:'a hand-written revision'})});
    assert.equal(patched.status,200,await patched.text());
    const second=JSON.parse((await get(`${base}/api/tasks/${taskId}/show`)).body);
    assert.equal(second.task.plan,'a hand-written revision');
    assert.equal(second.revision.changed,true);
    assert.equal(second.revision.hasPrev,true);
    assert.equal(second.revision.at,second.task.plan_at);
    assert.match(second.revision.diff,/\+a hand-written revision/);
  }finally{server.stop()}
});

test('live is the lease, not the status column, and the stream carries it',async()=>{
  // Two surfaces used to answer "is this task busy" by asking the runs table whether
  // anything was running - a column that stays 'running' for as long as it takes
  // somebody to notice the process that owned it is gone. The first two assertions
  // are the ones that stop this being simplified back into that scan.
  const {root,taskId}=seeded();
  const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  const base=server.base;
  try{
    // Opened after the server so its reaper has already run, and nothing reaps again
    // for as long as either store stays open. The ghost below is what that buys: a
    // running row with no lease, which is the exact shape being asserted on.
    const s=new Service(root,{allowMock:true,silent:true});
    // Parked, not planning: a task sitting in a WORKING_STATE is busy on its state
    // alone, which would leave the lease with nothing to prove.
    s.store.updateTask(taskId,{state:'AWAITING_APPROVAL'});
    s.store.addRun({id:'ghost',taskId,role:'implementer',providerId:'worker',modelId:'worker-m',status:'running',startedAt:new Date().toISOString()});
    let show=JSON.parse((await get(`${base}/api/tasks/${taskId}/show`)).body);
    assert.equal(show.live,null,'a running status is not liveness');
    assert.equal(show.runs.find(r=>r.id==='ghost').status,'running','and the two really do disagree');
    assert.equal(show.revision.changed,false,'the revision rides on the same payload');

    // The lease is what makes it live. The task is resting and stays resting, so the
    // lease is the only thing in the system saying anything is happening.
    s.store.heartbeat('ghost',taskId);
    show=JSON.parse((await get(`${base}/api/tasks/${taskId}/show`)).body);
    assert.deepEqual(Object.keys(show.live).sort(),['fallbackFrom','modelId','providerId','role','runId','startedAt'],'a narrow shape: /api/runs already carries the tokens and the cost');
    assert.equal(show.live.runId,'ghost');
    assert.equal(show.live.role,'implementer');
    assert.equal(show.live.providerId,'worker');
    assert.equal(show.live.fallbackFrom,null);
    assert.ok(Date.parse(show.live.startedAt)>0);

    // Ticks land at 500ms, so the read at 900ms is at least one in, and the lease
    // drops with one more tick still to come.
    const reading=stream(`${base}/api/tasks/${taskId}/stream`,25000);
    await new Promise(r=>setTimeout(r,900));
    s.store.releaseLease('ghost');
    const {body}=await reading;
    assert.match(body,/^retry: 1000/,'the reconnect gap is a second, not the browser default of three');
    const states=frames(body).filter(f=>f.type==='state');
    assert.equal(states[0].data.live.runId,'ghost','the frame says which run, not merely that one exists');
    assert.equal(states[0].data.task.id,taskId,'and carries the task beside it, so the plan refreshes without a poll');
    assert.ok(states.some(f=>f.data.live===null),'the field goes null when the lease does, which is also what ends the stream');
  }finally{server.stop()}
});

test('--background without a server fails with a message that says what to do',async()=>{
  const {root,taskId}=seeded();
  // A port nothing holds, chosen rather than assumed: the test is about what the CLI
  // does when no server answers there, so a squatter would invert its meaning.
  const port=await freePort();
  const r=await new Promise((res)=>{const p=spawn(process.execPath,[cliPath,'task','execute',taskId,'--background'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});let err='';p.stderr.on('data',c=>err+=c);p.on('close',code=>res({code,err}))});
  assert.equal(r.code,1,'a job nobody can run is not a success');
  assert.match(r.err,new RegExp(`no dashboard server on :${port}`));
  assert.match(r.err,/--background/,'and it names the way out');
});

test('--background with a server returns immediately and queues the job',async()=>{
  const {root,taskId}=seeded();
  const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  const port=server.port;
  try{
    await post(`${server.base}/api/tasks/${taskId}/plan`);
    await post(`${server.base}/api/tasks/${taskId}/approve`);
    const started=Date.now();
    const r=await new Promise((res)=>{const p=spawn(process.execPath,[cliPath,'task','execute',taskId,'--background'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('close',code=>res({code,out,err}))});
    assert.equal(r.code,0,r.err);
    assert.equal(JSON.parse(r.out).kind,'execute');
    assert.ok(Date.now()-started<10000,'the CLI handed it off rather than waiting for it');
  }finally{server.stop()}
});

// Reads a ref, for the assertions about refs rather than about responses.
const read=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();

// A root with a task whose worktree already holds work. The workflow is driven
// in-process before the server starts, because the slow worker the other fixtures
// need to keep a run in flight is 30 seconds and none of these routes care how the
// work got into the worktree.
async function worked(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-port-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  fs.writeFileSync(path.join(root,'app.mjs'),'export const version=1;\n');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  s.updateProvider('mock',{enabled:false});
  s.addProvider({id:'fast',name:'Fast',kind:'mock',enabled:true,config:{routable:true,writes:['app.mjs']}});
  s.addModel({id:'fast-m',providerId:'fast',name:'fast',capabilities:['planning','coding','review','repair'],speed:10,quality:10,cost:0,contextLength:100000});
  const t=s.createTask(p.id,'port me');
  s.prepare(t.id);await s.plan(t.id);s.approve(t.id);await s.implement(t.id);
  return {root,taskId:t.id};
}

test('show carries the branches a port could land on, and not the task branches',async()=>{
  // The port form needs a destination list on the same render as the task it would
  // port. Every task owns an ai-code/<id> branch, so offering one as where to merge
  // ai-code/<id> would be a footgun rather than an option, and excluding them is a
  // filter rather than a promise not to add them later.
  const {root,taskId}=await worked();
  const s=await startServer(root);
  try{
    const main=read(root,['rev-parse','--abbrev-ref','HEAD']);
    git(root,['branch','staging','HEAD']);
    const r=await get(`${s.base}/api/tasks/${taskId}/show`);
    assert.equal(r.status,200);
    const b=JSON.parse(r.body);
    assert.ok(b.branches.includes(main),'the branch the work would land on by default');
    assert.ok(b.branches.includes('staging'));
    assert.equal(b.branches.some((x)=>x.startsWith('ai-code/')),false,'the task branches are not destinations');
  }finally{s.stop()}
});

test('the port routes take their options from the request',async()=>{
  const {root,taskId}=await worked();
  const s=await startServer(root);
  try{
    git(root,['branch','staging','HEAD']);
    const d=await get(`${s.base}/api/tasks/${taskId}/diff?to=staging`);
    assert.equal(d.status,200);
    const view=JSON.parse(d.body);
    assert.equal(view.target,'staging','the destination comes from the query string');
    assert.match(view.diff,/diff --git a\/app\.mjs/);
    assert.equal(view.pending,true,'the work is uncommitted, and the assessment says so');
    assert.equal(view.state.key,'pending','and the verdict the tab leads with is served with it');
    assert.match(view.state.headline,/uncommitted/, 'the verdict is prose, not a key the client expands');

    const before=read(root,['rev-parse','staging']);
    const dry=await post(`${s.base}/api/tasks/${taskId}/port`,{to:'staging',dryRun:true});
    assert.equal(dry.status,200);
    assert.equal(JSON.parse(dry.body).dryRun,true);
    assert.equal(read(root,['rev-parse','staging']),before,'a dry run over HTTP writes nothing either');

    const real=await post(`${s.base}/api/tasks/${taskId}/port`,{to:'staging'});
    assert.equal(real.status,200);
    assert.notEqual(read(root,['rev-parse','staging']),before,'and the real one lands');
    assert.match(read(root,['show','staging:app.mjs']),/written by the mock implementer/);

    const landed=JSON.parse((await get(`${s.base}/api/tasks/${taskId}/diff?to=staging`)).body);
    assert.equal(landed.state.key,'landed','and the tab is told so rather than left to infer it');
    assert.equal(landed.landedAs.sha,landed.taskCommit.sha,'a fast-forward, so one commit is both the work and how it arrived');
    assert.match(landed.taskCommit.subject,/port me/,'and it is named by its own message');
    assert.deepEqual(landed.next,[]);
  }finally{s.stop()}
});

test('the refine route refuses a task that already has a run in flight',async()=>{
  // The refusal has to survive the HTTP boundary as a 400 carrying the message,
  // because that body is the whole of what the dashboard renders. And it has to be
  // decided from the lease rather than from this process's run registry: the run
  // below belongs to the test process, and the server is a different one.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-refine-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'refine me');
  s.prepare(t.id);await s.plan(t.id);
  assert.equal(s.task(t.id).state,'AWAITING_APPROVAL');
  s.store.addRun({id:'live',taskId:t.id,role:'planner',providerId:'mock',modelId:'mock',status:'running',startedAt:new Date().toISOString()});
  s.store.heartbeat('live',t.id);
  const srv=await startServer(root);
  try{
    const r=await post(`${srv.base}/api/tasks/${t.id}/refine`,{feedback:'make it smaller'});
    assert.equal(r.status,400);
    assert.match(JSON.parse(r.body).error,/in flight/);
  }finally{srv.stop()}
});

test('task list passes the project id through and filters by --state',async()=>{const rootA=gitRepo(),rootB=gitRepo();const s=new Service(rootA,{allowMock:true,silent:true});const pa=s.initProject('pa',rootA);const pb=s.initProject('pb',rootB);const t1=s.createTask(pa.id,'in project a, created');const t2=s.createTask(pa.id,'in project a, planning');s.store.updateTask(t2.id,{state:'PLANNING'});const t3=s.createTask(pb.id,'in project b, created');const run=(args)=>new Promise((res)=>{const p=spawn(process.execPath,[cliPath,'task','list',...args],{cwd:rootA,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('close',code=>res({code,out,err}))});{const {code,out}=await run([pa.id]);assert.equal(code,0);assert.deepEqual(JSON.parse(out).map(r=>r.id).sort(),[t1.id,t2.id].sort())}{const {code,out}=await run(['--state','PLANNING']);assert.equal(code,0);assert.deepEqual(JSON.parse(out).map(r=>r.id),[t2.id])}{const {code,out}=await run([pa.id,'--state','PLANNING']);assert.equal(code,0);assert.deepEqual(JSON.parse(out).map(r=>r.id),[t2.id])}{const {code,err}=await run(['--state','NOT_A_STATE']);assert.equal(code,1);assert.match(err,/Invalid state NOT_A_STATE/);assert.match(err,/CREATED/);assert.match(err,/COMPLETE/)}});
