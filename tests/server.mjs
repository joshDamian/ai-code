import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';import crypto from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {Service} from '../src/service.mjs';import {WebSocket} from 'ws';import {TerminalSessions} from '../src/terminal.mjs';
function get(url){return new Promise((res,rej)=>http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res({status:r.statusCode,body:b}))}).on('error',rej))}
function post(url,payload){return new Promise((res,rej)=>{const data=JSON.stringify(payload||{});const u=new URL(url);const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res({status:r.statusCode,body:b}))});req.on('error',rej);req.write(data);req.end()})}
function patch(url,payload){return new Promise((res,rej)=>{const data=JSON.stringify(payload||{});const u=new URL(url);const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:'PATCH',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res({status:r.statusCode,body:b}))});req.on('error',rej);req.write(data);req.end()})}
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
  // A second planning model, deliberately out-scored by the first so every test
  // that only needs *a* planner keeps the one it has always had.
  s.addModel({id:'planner-m2',providerId:'planner',name:'planner-m2',capabilities:['planning'],speed:1,quality:1,cost:0,contextLength:100000});
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

// PORT=0 is what every agent run is handed, so a smoke-test server cannot collide with
// the dashboard that spawned the agent. That only works if the port the kernel picked is
// announced: a line echoing the request back would print `localhost:0` and leave the
// agent with nothing to curl, which is how the collision turned into a kill in the first
// place. Asserted by reaching the announced port, not by matching the log text.
test('a server asked for port 0 announces the port it bound, and answers there',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-port0-'));
  const proc=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),env:{...process.env,AI_CODE_ROOT:root,PORT:'0'},stdio:['ignore','pipe','pipe']});
  try{
    const port=await new Promise((res,rej)=>{
      let out='';
      const t=setTimeout(()=>rej(new Error(`no port announced: ${JSON.stringify(out)}`)),20000);
      proc.stdout.on('data',(c)=>{
        out+=c;
        const m=out.match(/localhost:(\d+)/);
        if(m){clearTimeout(t);res(Number(m[1]))}
      });
      proc.on('exit',()=>{clearTimeout(t);rej(new Error('server exited before announcing a port'))});
    });
    assert.ok(port>0,`announced ${port}, which is the request rather than the result`);
    assert.equal((await get(`http://localhost:${port}/api/overview`)).status,200);
  } finally { proc.kill('SIGKILL') }
});

test('dashboard API responds',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-server-'));const s=await startServer(root);try{const r=await get(`${s.base}/api/overview`);assert.equal(r.status,200);assert.ok(JSON.parse(r.body).providers)}finally{s.stop()}});

test('dashboard control-plane APIs exist',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-api-'));const s=await startServer(root);try{for(const u of ['/api/providers','/api/routing','/api/runs','/api/usage','/api/automations','/api/doctor','/api/jobs']){const r=await get(s.base+u);assert.equal(r.status,200,u)}}finally{s.stop()}});

// A model id is namespaced with the provider's own slug, and OpenRouter's contain a
// slash. The dashboard encodes the id into one path segment and the route decodes it
// back; missing either half leaves the Disable button answering 404, which is exactly
// what a manual click of it did. Asserted over HTTP because that is where the id is
// split - the service call takes the id whole either way.
test('a model whose id contains a slash can be disabled and enabled over the API',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-model-id-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  s.addProvider({id:'openrouter',name:'OpenRouter',kind:'openrouter',enabled:true,config:{apiKeyEnv:'OPENROUTER_API_KEY'}});
  const model='openrouter:anthropic/claude-opus-5';
  s.addModel({id:model,providerId:'openrouter',name:'claude-opus-5',capabilities:['coding'],speed:7,quality:10,cost:0,contextLength:200000});
  const srv=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  try{
    const url=`${srv.base}/api/models/${encodeURIComponent(model)}`;
    const off=await patch(url,{enabled:false});
    assert.equal(off.status,200,'the encoded id has to reach the model, not the 404 branch');
    assert.equal(JSON.parse(off.body).enabled,false);
    assert.equal(s.store.getModel(model).enabled,false,'the flip is the row, not the echo');
    const on=await patch(url,{enabled:true});
    assert.equal(on.status,200);
    assert.equal(JSON.parse(on.body).enabled,true);
  }finally{srv.stop()}
});

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

test('the chat view resolves the project the route does not hand it',async()=>{
  // There is no DOM harness here - preact and htm arrive through the import map, so
  // nothing in this suite can render a view - which is how a view that can never
  // create anything stays green. Asserting the served asset says what it must is the
  // check the markdown pin above makes, and this is the thing it has to say: a
  // conversation belongs to a project, the route passes none down, so the view has
  // to load the list itself or New Chat is a button that cannot fire.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-chat-view-'));const s=await startServer(root);
  try{
    const r=await get(`${s.base}/views/chat.mjs`);
    assert.equal(r.status,200);
    assert.match(r.body,/\.projects\(\)/,'the view loads the projects it has to choose from');
    assert.match(r.body,/api\.chatSessions\(projectId\)/,"and asks for that project's conversations, not every project's");
    assert.match(r.body,/api\.createChatSession\(projectId/,'a conversation is created in the project that was chosen');
    // And the route and the nav entry, without which the view is not reachable at all.
    const app=await get(`${s.base}/app.mjs`);
    assert.equal(app.status,200);
    assert.match(app.body,/from '\.\/views\/chat\.mjs'/);
    assert.match(app.body,/case 'chat-detail'/);
    assert.match(app.body,/c: '#\/chat'/);
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

test('a task carries a planning-model preference, and the next planner run honours it',async()=>{
  const {root,taskId}=seeded();
  const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  const base=server.base;
  const patch=(payload)=>fetch(`${base}/api/tasks/${taskId}/plan`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const task=async()=>JSON.parse((await get(`${base}/api/tasks/${taskId}/show`)).body).task;
  try{
    const before=await task();
    const named=await patch({plan_model:'planner-m2'});
    const namedBody=await named.text();
    assert.equal(named.status,200,namedBody);
    assert.equal(JSON.parse(namedBody).plan_model,'planner-m2');
    // The wipe this guards: updatePlan reads a body's `plan` whether or not it has
    // one, so a request that only names a model would otherwise store undefined as
    // the plan. Two fields on one route is what makes that reachable from the UI.
    const after=await task();
    assert.equal(after.plan,before.plan,'naming a model is not an edit of the plan');
    assert.equal(after.plan_at,before.plan_at);

    const unknown=await patch({plan_model:'nope'});
    assert.equal(unknown.status,400);
    assert.match(JSON.parse(await unknown.text()).error,/Unknown model/);
    assert.equal((await task()).plan_model,'planner-m2','a refused write changes nothing');

    assert.equal((await patch({plan_model:''})).status,200);
    assert.equal((await task()).plan_model,null,'the empty string is Automatic');

    await patch({plan_model:'planner-m2'});
    assert.equal((await post(`${base}/api/tasks/${taskId}/plan`)).status,200);
    const run=JSON.parse((await get(`${base}/api/tasks/${taskId}/show`)).body).runs.find((r)=>r.role==='planner');
    assert.equal(run.model_id,'planner-m2','the preference is what the planner ran on');
    assert.equal((await task()).plan_model,'planner-m2','and it stays on the task the run does not consume');
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

test('show reports a completed task as ported once its port has run',async()=>{
  // The next-step banner and the dot on the port tab are drawn from this field, and
  // they are drawn on the payload the task itself arrives on - a port writes refs, so
  // the client cannot derive it, and a reload has to see what the click saw.
  const {root,taskId}=await worked();
  const svc=new Service(root,{silent:true});
  svc.store.updateTask(taskId,{state:'COMPLETE'});
  const s=await startServer(root);
  try{
    const before=JSON.parse((await get(`${s.base}/api/tasks/${taskId}/show`)).body);
    assert.equal(before.task.state,'COMPLETE');
    assert.equal(before.ported,false,'the work is still in the worktree, so nothing has been ported');
    const port=await post(`${s.base}/api/tasks/${taskId}/port`,{});
    assert.equal(port.status,200);
    const after=JSON.parse((await get(`${s.base}/api/tasks/${taskId}/show`)).body);
    assert.equal(after.ported,true,'and the port that just ran is what the next show reports');
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

test('task list passes the project id through and filters by --state',async()=>{const rootA=gitRepo(),rootB=gitRepo();const s=new Service(rootA,{allowMock:true,silent:true});const pa=s.initProject('pa',rootA);const pb=s.initProject('pb',rootB);const t1=s.createTask(pa.id,'in project a, created');const t2=s.createTask(pa.id,'in project a, planning');s.store.updateTask(t2.id,{state:'PLANNING'});const t3=s.createTask(pb.id,'in project b, created');const run=(args)=>new Promise((res)=>{const p=spawn(process.execPath,[cliPath,'task','list',...args],{cwd:rootA,env:{...process.env,AI_CODE_ROOT:rootA},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('close',code=>res({code,out,err}))});{const {code,out}=await run([pa.id]);assert.equal(code,0);assert.deepEqual(JSON.parse(out).map(r=>r.id).sort(),[t1.id,t2.id].sort())}{const {code,out}=await run(['--state','PLANNING']);assert.equal(code,0);assert.deepEqual(JSON.parse(out).map(r=>r.id),[t2.id])}{const {code,out}=await run([pa.id,'--state','PLANNING']);assert.equal(code,0);assert.deepEqual(JSON.parse(out).map(r=>r.id),[t2.id])}{const {code,err}=await run(['--state','NOT_A_STATE']);assert.equal(code,1);assert.match(err,/Invalid state NOT_A_STATE/);assert.match(err,/CREATED/);assert.match(err,/COMPLETE/)}});

test('POST /api/tasks/:id/close moves to CANCELLED',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-close-'));git(root,['init','-q']);fs.writeFileSync(path.join(root,'README.md'),'x');git(root,['add','.']);git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);const s=new Service(root,{allowMock:true,silent:true});const p=s.initProject('p',root);const t=s.createTask(p.id,'close me');s.prepare(t.id);const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});try{const r=await post(`${server.base}/api/tasks/${t.id}/close`);assert.equal(r.status,200);const body=JSON.parse(r.body);assert.equal(body.state,'CANCELLED')}finally{server.stop()}});

test('GET /api/tasks?state=CANCELLED returns closed tasks',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-close-list-'));git(root,['init','-q']);fs.writeFileSync(path.join(root,'README.md'),'x');git(root,['add','.']);git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);const s=new Service(root,{allowMock:true,silent:true});const p=s.initProject('p',root);const t1=s.createTask(p.id,'close me');const t2=s.createTask(p.id,'keep me');s.prepare(t1.id);s.closeTask(t1.id);const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});try{const r=await get(`${server.base}/api/tasks?state=CANCELLED`);assert.equal(r.status,200);const body=JSON.parse(r.body);const ids=body.map(t=>t.id);assert.ok(ids.includes(t1.id));assert.equal(ids.includes(t2.id),false)}finally{server.stop()}});

test('close refuses a task with a run in flight',async()=>{const {root,taskId}=seeded();const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});try{await post(`${server.base}/api/tasks/${taskId}/plan`);await post(`${server.base}/api/tasks/${taskId}/approve`);const reading=stream(`${server.base}/api/tasks/${taskId}/stream`,25000);const queued=await post(`${server.base}/api/tasks/${taskId}/execute/background`);await new Promise(r=>setTimeout(r,500));const closeR=await post(`${server.base}/api/tasks/${taskId}/close`);assert.equal(closeR.status,400);assert.match(JSON.parse(closeR.body).error,/task cancel/);await post(`${server.base}/api/tasks/${taskId}/cancel`);const closeR2=await post(`${server.base}/api/tasks/${taskId}/close`);assert.equal(closeR2.status,200)}finally{server.stop()}});

test('ai-code task close exits 0 and prints CANCELLED state',async()=>{const {root,taskId}=seeded();const r=await new Promise((res)=>{const p=spawn(process.execPath,[cliPath,'task','close',taskId],{cwd:root,env:{...process.env,AI_CODE_ROOT:root},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('close',code=>res({code,out,err}))});assert.equal(r.code,0);assert.match(r.out,/CANCELLED/)});

// The state an install that added OpenRouter before the catalog changed is in: the
// retired slug still has a row and the Claude entries were never seeded. Re-running
// `add-openrouter` must not be the way out of it - that rewrites the provider row -
// so `provider sync` is, and `add-*` refuses instead.
test('provider sync re-seeds the openrouter catalog and add-openrouter refuses a re-run',async()=>{
  const root=gitRepo();
  const s=new Service(root,{allowMock:true,silent:true});
  s.initProject('p',root);
  s.addProvider({id:'openrouter',name:'OpenRouter',kind:'openrouter',enabled:true,config:{apiKeyEnv:'OPENROUTER_API_KEY',effort:'max',routable:true,billingMode:'api'}});
  s.addModel({id:'openrouter:mistralai/codestral-2501',providerId:'openrouter',name:'codestral-2501',capabilities:['coding'],speed:5,quality:5});
  s.addModel({id:'openrouter:anthropic/claude-sonnet-5',providerId:'openrouter',name:'claude-sonnet-5',capabilities:['coding'],speed:1,quality:1,enabled:false});
  const run=(args)=>new Promise((res)=>{const p=spawn(process.execPath,[cliPath,...args],{cwd:root,env:{...process.env,AI_CODE_ROOT:root},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('close',code=>res({code,out,err}))});

  const first=await run(['provider','sync','openrouter']);
  assert.equal(first.code,0);
  assert.equal(JSON.parse(first.out).removed,1,'the retired slug is the one row that leaves');
  const {providers,models}=JSON.parse((await run(['provider','list'])).out);
  const ids=models.map(m=>m.id);
  assert.equal(ids.includes('openrouter:mistralai/codestral-2501'),false,'the dead model is gone from the database');
  assert.equal(ids.filter(id=>id.startsWith('openrouter:anthropic/claude-')).length,5,'the five Claude entries are attached');
  assert.equal(models.find(m=>m.id==='openrouter:anthropic/claude-sonnet-5').enabled,false,'a model someone turned off stays off');
  assert.equal(providers.find(p=>p.id==='openrouter').config.effort,'max','and the provider config survives');

  const second=JSON.parse((await run(['provider','sync','openrouter'])).out);
  assert.equal(second.added,0);
  assert.equal(second.removed,0,'a second sync has nothing left to do');

  const all=JSON.parse((await run(['provider','sync'])).out);
  assert.deepEqual(all.map(s=>s.providerId),['openrouter'],'an unqualified sync covers what this install has, rather than failing on what it does not');

  const dup=await run(['provider','add-openrouter']);
  assert.equal(dup.code,1);
  assert.match(dup.err,/already exists/);
  assert.match(dup.err,/provider sync openrouter/);

  const unknown=await run(['provider','sync','nope']);
  assert.equal(unknown.code,1);
  assert.match(unknown.err,/Unknown provider 'nope'/);
  assert.match(unknown.err,/openrouter/);
});

test('POST /api/chat/sessions creates a new chat',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-chat-'));git(root,['init','-q']);fs.writeFileSync(path.join(root,'README.md'),'x');git(root,['add','.']);git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);const s=new Service(root,{allowMock:true,silent:true});const p=s.initProject('p',root);const srv=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});try{const r=await post(`${srv.base}/api/chat/sessions`,{projectId:p.id});assert.equal(r.status,201);const body=JSON.parse(r.body);assert.ok(body.id);assert.equal(body.project_id,p.id);assert.equal(body.title,'New chat')}finally{srv.stop()}});

test('POST /api/chat/sessions/:id/messages queues a job and returns 202',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-chat-msg-'));git(root,['init','-q']);fs.writeFileSync(path.join(root,'README.md'),'x');git(root,['add','.']);git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);const s=new Service(root,{allowMock:true,silent:true});const p=s.initProject('p',root);s.updateProvider('mock',{enabled:false});s.addProvider({id:'chat-provider',name:'Chat',kind:'mock',enabled:true,config:{routable:true,chatText:'Answer to the question.'}});s.addModel({id:'chat-m',providerId:'chat-provider',name:'chat',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});const srv=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});try{const createResp=await post(`${srv.base}/api/chat/sessions`,{projectId:p.id});const session=JSON.parse(createResp.body);const msgResp=await post(`${srv.base}/api/chat/sessions/${session.id}/messages`,{message:'What is in this repo?'});assert.equal(msgResp.status,202);const body=JSON.parse(msgResp.body);assert.ok(body.message);assert.equal(body.message.role,'user');assert.equal(body.message.content,'What is in this repo?');assert.ok(body.job);assert.equal(body.job.kind,'chat')}finally{srv.stop()}});


test('POST /api/chat/sessions/:id/messages returns 409 while answering',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-chat-busy-'));git(root,['init','-q']);fs.writeFileSync(path.join(root,'README.md'),'x');git(root,['add','.']);git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);const s=new Service(root,{allowMock:true,silent:true});const p=s.initProject('p',root);s.updateProvider('mock',{enabled:false});s.addProvider({id:'chat-provider',name:'Chat',kind:'mock',enabled:true,config:{routable:true,delayMs:500,chatText:'Slow answer.'}});s.addModel({id:'chat-m',providerId:'chat-provider',name:'chat',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});const srv=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});try{const createResp=await post(`${srv.base}/api/chat/sessions`,{projectId:p.id});const session=JSON.parse(createResp.body);await post(`${srv.base}/api/chat/sessions/${session.id}/messages`,{message:'First question?'});await new Promise(r=>setTimeout(r,100));const secondResp=await post(`${srv.base}/api/chat/sessions/${session.id}/messages`,{message:'Second question?'});assert.equal(secondResp.status,409);assert.match(JSON.parse(secondResp.body).error,/already answering/)}finally{srv.stop()}});

// The whole turn over HTTP: a question posted, a stream open while it is answered,
// the answer stored, and the bookkeeping kept out of the two surfaces a task's run
// is counted on. The unit suite drives `Service.chat` directly, so nothing else
// would notice a route that answered on one path and stored on another.
test('a chat question is answered over HTTP, and its turn is not a task run',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-chat-e2e-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'a task that is not this chat');
  s.updateProvider('mock',{enabled:false});
  // Slow enough that a 500ms stream tick lands inside the turn. The stream ends on
  // `answering` going false after having been seen true, so a mock that answered in
  // one tick would leave it waiting on a state it never observed.
  s.addProvider({id:'chat-provider',name:'Chat',kind:'mock',enabled:true,config:{routable:true,delayMs:1200,chatText:'The queue lives in src/runner.mjs.'}});
  s.addModel({id:'chat-m',providerId:'chat-provider',name:'chat',capabilities:['planning'],speed:10,quality:10,cost:0,contextLength:100000});
  const srv=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  try{
    const session=JSON.parse((await post(`${srv.base}/api/chat/sessions`,{projectId:p.id})).body);
    // Opened before the question is asked, which is the browser's own order and the
    // only one in which the stream can watch the turn arrive.
    const reading=stream(`${srv.base}/api/chat/sessions/${session.id}/stream`,25000);
    const asked=await post(`${srv.base}/api/chat/sessions/${session.id}/messages`,{message:'Where does the queue live?'});
    assert.equal(asked.status,202);
    const fr=frames((await reading).body);
    const answer=fr.filter(f=>f.type==='message'&&f.data?.role==='assistant').pop();
    assert.ok(answer,'the stream carries the answer it was opened for');
    assert.equal(answer.data.content,'The queue lives in src/runner.mjs.');
    assert.ok(fr.some(f=>f.type==='state'&&f.data.answering===true),'the stream reported the turn in flight before it ended');
    // Stored through the HTTP path, which is what a reload reads back.
    const shown=JSON.parse((await get(`${srv.base}/api/chat/sessions/${session.id}`)).body);
    assert.deepEqual(shown.messages.map(m=>[m.role,m.content]),[['user','Where does the queue live?'],['assistant','The queue lives in src/runner.mjs.']]);
    assert.equal(shown.session.title,'Where does the queue live?');
    // The two surfaces the plan named, read over the API a browser reads them from:
    // a chat turn is a run of no task, so neither counts it.
    assert.deepEqual(JSON.parse((await get(`${srv.base}/api/runs`)).body),[]);
    assert.deepEqual(JSON.parse((await get(`${srv.base}/api/runs?taskId=${t.id}`)).body),[]);
    const usage=JSON.parse((await get(`${srv.base}/api/usage?period=all`)).body);
    assert.equal(usage.totals.runs,0,'the usage page is the record of what tasks spent');
    assert.equal(usage.by_role.some(r=>r.role==='chat'),false);
    // And the turn is accounted for where the conversation reads it, so the spend
    // is recorded rather than dropped on the floor by the move.
    const turn=new Service(root,{allowMock:true,silent:true}).store.listChatRuns(session.id);
    assert.equal(turn.length,1);
    assert.equal(turn[0].role,'chat');
    assert.equal(turn[0].status,'succeeded');
  }finally{srv.stop()}
});

// One terminal socket. The options exist for the guard tests, which are about the
// headers a request arrives with rather than about what the shell does.
function terminalSocket(base,taskId,target,options={}){
  const url=`${base.replace(/^http/,'ws')}/api/tasks/${taskId}/terminal?target=${encodeURIComponent(target)}`;
  return new WebSocket(url,options);
}

// Everything the shell has printed, and a way to wait for a string to appear in it.
// The assertions below are all "the shell answered", and none of them cares how many
// frames it took to say so, so the collector keeps the text rather than parsing the
// protocol.
function reader(ws){
  let out='';
  const waiting=[];
  ws.on('message',(d)=>{
    out+=d.toString();
    for(const w of [...waiting]) if(w.re.test(out)){waiting.splice(waiting.indexOf(w),1);clearTimeout(w.t);w.ok(out)}
  });
  return {
    text:()=>out,
    // Bounded: a shell that never answers has to fail the test rather than hang the
    // suite, and the output so far is what says which line it stopped at.
    until(re,ms=15000){
      if(re.test(out))return Promise.resolve(out);
      return new Promise((ok,bad)=>{const w={re,ok};w.t=setTimeout(()=>{waiting.splice(waiting.indexOf(w),1);bad(new Error(`the terminal never printed ${re}\n--- output ---\n${out.slice(-2000)}`))},ms);waiting.push(w)});
    },
  };
}

const typed=(ws,data)=>ws.send(JSON.stringify({type:'input',data}));
const sized=(ws,cols,rows)=>ws.send(JSON.stringify({type:'resize',cols,rows}));

// A socket that became one, which is what every accepted upgrade ends in.
function opened(ws,ms=15000){
  return new Promise((ok,bad)=>{
    const t=setTimeout(()=>bad(new Error('the terminal socket never opened')),ms);
    ws.on('open',()=>{clearTimeout(t);ok(ws)});
    ws.on('error',(e)=>{clearTimeout(t);bad(e)});
  });
}

// A socket that never became one. An upgrade this server refuses is answered as HTTP,
// not as a WebSocket close - the handshake it would have closed on never happened - so
// the client sees a failed connection and the message carries the status.
function refused(ws,ms=15000){
  return new Promise((ok,bad)=>{
    const t=setTimeout(()=>{ws.close();bad(new Error('the upgrade was still pending, so it was neither accepted nor refused'))},ms);
    ws.on('open',()=>{clearTimeout(t);ws.close();bad(new Error('the upgrade was accepted'))});
    ws.on('error',(e)=>{clearTimeout(t);ok(e.message)});
  });
}

const escapeRe=(s)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// A directory as the shell may print it. `pwd` reports the path the process was
// started with, and on macOS /var is a symlink to /private/var - which of the two
// comes back is the platform's business, so both are accepted.
const anyPath=(dir)=>new RegExp(`${escapeRe(dir)}|${escapeRe(fs.realpathSync(dir))}`);

test('the terminal runs a real shell in the worktree and in the parent checkout',async()=>{
  const {root,taskId}=await worked();
  const s=await startServer(root);
  try{
    const show=JSON.parse((await get(`${s.base}/api/tasks/${taskId}/show`)).body);
    assert.equal(show.terminal.enabled,true);
    const dir=Object.fromEntries(show.terminal.targets.map((t)=>[t.id,t.dir]));
    // Realpath'd on the way in, which is how the project knows it: on macOS /var is a
    // symlink, so the same directory has two spellings and only one of them is stored.
    assert.equal(dir.parent,fs.realpathSync(root),'the parent target is the checkout the branch would land on');
    assert.ok(dir.worktree&&dir.worktree!==root,'and the worktree is a directory of its own');
    assert.equal(show.terminal.targets.every((t)=>t.available),true);

    for(const target of ['worktree','parent']){
      const ws=await opened(terminalSocket(s.base,taskId,target));
      const r=reader(ws);
      // Wide before anything is asked of it. The tty wraps what a program prints at the
      // width it was given, and these directories are long enough that a default 80
      // would break a path across two lines and match nothing.
      sized(ws,200,50);
      typed(ws,`echo HELLO-${target}\n`);
      await r.until(new RegExp(`HELLO-${target}`));
      // The size the browser reported is the size the kernel has: this is what a
      // full-screen program redraws off, and a terminal that ignores it shows claude
      // drawing to a box nobody can see.
      typed(ws,'stty size\n');
      await r.until(/50 200/);
      typed(ws,'pwd\n');
      await r.until(anyPath(dir[target]));
      ws.close();
    }
  }finally{s.stop()}
});

test('a terminal session outlives the tab that opened it',async()=>{
  // The whole reason the PTY is not per-socket. A refresh in the middle of a long run
  // has to come back to the same shell - so the proof is a shell variable, which only
  // the process that was told about it can answer with.
  const {root,taskId}=await worked();
  const s=await startServer(root);
  try{
    const first=await opened(terminalSocket(s.base,taskId,'worktree'));
    const a=reader(first);
    sized(first,200,50);
    // The expansion is what is waited for rather than the typed line, which comes back
    // on the echo whether or not the shell ever ran it.
    typed(first,'export AI_CODE_SESSION=alive-1234; echo "armed:$AI_CODE_SESSION"\n');
    await a.until(/armed:alive-1234/);
    first.close();
    await new Promise((r)=>setTimeout(r,200));

    const second=await opened(terminalSocket(s.base,taskId,'worktree'));
    const b=reader(second);
    // The replay is the other half: a reattach that came back to a blank screen would
    // be no better than a new shell.
    await b.until(/alive-1234/);
    typed(second,'echo "same:$AI_CODE_SESSION"\n');
    await b.until(/same:alive-1234/);
    second.close();
  }finally{s.stop()}
});

test('a shell that exits ends its session, and the next reader gets a live one',async()=>{
  const {root,taskId}=await worked();
  const s=await startServer(root);
  try{
    const ws=await opened(terminalSocket(s.base,taskId,'worktree'));
    sized(ws,120,40);
    typed(ws,'exit\n');
    // 1000 rather than a bare close: it is the code a client reads as "the shell ended,
    // do not reconnect". A retry here spawns a shell every couple of seconds at a
    // command that exits immediately.
    const code=await new Promise((ok)=>ws.on('close',(c)=>ok(c)));
    assert.equal(code,1000);

    // And a reload after `exit` is a working terminal rather than the dead one: the
    // session is dropped with the process, so the next connection opens a new shell.
    const again=await opened(terminalSocket(s.base,taskId,'worktree'));
    const r=reader(again);
    sized(again,200,50);
    typed(again,'echo BACK-AGAIN\n');
    await r.until(/BACK-AGAIN/);
    again.close();
  }finally{s.stop()}
});

test('the terminal is localhost-only, and refuses by name',async()=>{
  // A terminal is arbitrary command execution, so the route narrows relative to the
  // rest of the server: the upgrade is refused unless it came from this machine, and a
  // valid token does not change that. CORS does not cover WebSocket upgrades, so a page
  // on any origin can open a socket to localhost - which is the case the Origin check
  // is for - and a rebound DNS name is the case the Host check is.
  const {root,taskId}=await worked();
  const s=await startServer(root);
  try{
    // The browser on this machine: accepted, so the refusals below are the guard and
    // not a route that never worked.
    (await opened(terminalSocket(s.base,taskId,'parent'))).close();

    assert.match(await refused(terminalSocket(s.base,taskId,'parent',{headers:{origin:'http://evil.example.com'}})),/403/);
    assert.match(await refused(terminalSocket(s.base,taskId,'parent',{headers:{host:'evil.example.com'}})),/403/);
    // A phone that has paired and holds a valid token, asking anyway. Reaching the API
    // is not the same permission as opening a shell on the machine, and this is the
    // case the two are distinguished by - so it is asserted rather than assumed.
    const {root:tokRoot,taskId:tokTask}=seeded();
    const tok=await startedWithToken(tokRoot);
    try{
      const phone={host:'workstation.tailnet-abc.ts.net',authorization:`Bearer ${tok.token}`};
      assert.equal((await withHeaders(`${tok.base}/api/tasks/${tokTask}/show`,phone)).status,200,'the token itself has to be accepted, or the refusal below proves nothing');
      assert.match(await refused(terminalSocket(tok.base,tokTask,'parent',{headers:phone})),/403/);
    }finally{tok.stop()}
    // A target that is not a directory: a bad request rather than a shell in one.
    assert.match(await refused(terminalSocket(s.base,taskId,'everywhere')),/400/);
    // A task that does not exist.
    assert.match(await refused(terminalSocket(s.base,'no-such-task','parent')),/404/);
  }finally{s.stop()}
});

test('AI_CODE_DISABLE_TERMINAL closes the route and says so before a socket is opened',async()=>{
  const {root,taskId}=await worked();
  const s=await startServer(root,{AI_CODE_DISABLE_TERMINAL:'1'});
  try{
    const show=JSON.parse((await get(`${s.base}/api/tasks/${taskId}/show`)).body);
    assert.equal(show.terminal.enabled,false,'the tab has to know before it renders a picker that cannot work');
    assert.match(await refused(terminalSocket(s.base,taskId,'parent')),/403/);
  }finally{s.stop()}
});

test('a target that cannot be opened is refused, and the reason rides on show',async()=>{
  // The tab renders "no worktree yet" from the payload without opening anything, and
  // the socket refuses the same target rather than spawning a shell with a cwd that is
  // not there.
  const {root,taskId}=seeded();
  const s=await startServer(root);
  try{
    const t=JSON.parse((await get(`${s.base}/api/tasks/${taskId}/show`)).body).terminal;
    const wt=t.targets.find((x)=>x.id==='worktree');
    assert.equal(wt.available,false);
    assert.equal(wt.dir,null);
    assert.match(wt.reason,/no worktree/);
    assert.equal(t.targets.find((x)=>x.id==='parent').available,true,'the checkout the branch would land on is there whatever the task is doing');
    // 409 rather than 404: the task exists, the directory it would open in does not.
    assert.match(await refused(terminalSocket(s.base,taskId,'worktree')),/409/);
  }finally{s.stop()}
});

test('the parent terminal opens in the project checkout, not where the server was started',async()=>{
  // Two projects, two repositories, one server. `AI_CODE_ROOT` is where the process was
  // started and where the database lives; the checkout a task's branch lands on is the
  // project's own path, and for a project added anywhere else those are different
  // directories. A shell opened in the wrong one is a terminal in a repository that has
  // never heard of the task - and `git merge` there would land nothing.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-term-here-'));
  const other=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-term-elsewhere-'));
  for(const d of [root,other]){
    git(d,['init','-q']);
    fs.writeFileSync(path.join(d,'README.md'),'x');
    git(d,['add','.']);
    git(d,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  }
  const svc=new Service(root,{allowMock:true,silent:true});
  svc.initProject('here',root);
  const p2=svc.initProject('elsewhere',other);
  const t=svc.createTask(p2.id,'a task in the other repository');
  const s=await startServer(root);
  try{
    assert.notEqual(fs.realpathSync(other),fs.realpathSync(root),'the fixture keeps the two apart, or this test proves nothing');
    const parent=JSON.parse((await get(`${s.base}/api/tasks/${t.id}/show`)).body).terminal.targets.find((x)=>x.id==='parent');
    assert.equal(parent.dir,fs.realpathSync(other),'the project named on the task is what it opens');

    const ws=await opened(terminalSocket(s.base,t.id,'parent'));
    const r=reader(ws);
    sized(ws,200,50);
    typed(ws,'pwd\n');
    await r.until(anyPath(parent.dir));
    typed(ws,'git --no-pager -c color.ui=false log --oneline -n 1\n');
    await r.until(/[0-9a-f]{7,} \((HEAD|tag:)/);
    ws.close();
  }finally{s.stop()}
});

test('a session nobody reconnects to is reaped, and a reconnect inside the window is not',async()=>{
  // The timer is the only thing between "a shell survives a refresh" and "a shell
  // survives the rest of the day", and it is an option so this can assert it in
  // milliseconds rather than by waiting out the default ten minutes.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-reap-'));
  const sessions=new TerminalSessions({reapMs:150});
  // A stand-in for a socket: what is under test is which timer is running, and a real
  // one would only add a handshake to wait on.
  const ws={readyState:0,on(){},send(){},close(){}};
  try{
    const first=sessions.open({taskId:'t',target:'parent',cwd:dir});
    sessions.attach(first,ws);
    assert.equal(sessions.size,1);
    sessions.detach(first,ws);
    await new Promise((r)=>setTimeout(r,400));
    assert.equal(sessions.size,0,'the shell was killed and the session dropped');

    const second=sessions.open({taskId:'t',target:'parent',cwd:dir});
    sessions.attach(second,ws);
    sessions.detach(second,ws);
    // Back before the timer is up, which is the refresh case: reload in under ten
    // minutes and the shell is still running.
    await new Promise((r)=>setTimeout(r,80));
    sessions.attach(second,ws);
    await new Promise((r)=>setTimeout(r,250));
    assert.equal(sessions.size,1,'reconnecting cancelled the reap');

    sessions.killAll();
    assert.equal(sessions.size,0,'and shutdown takes the shells with it');
  }finally{sessions.killAll()}
});

test('a merge typed into the terminal is what the port tab reports on the next load',async()=>{
  // The port tab reads live git state rather than anything a port wrote, and this is
  // the check that the terminal did not quietly change that: the merge happens in the
  // parent checkout, typed by hand into a shell, and the tab catches up on its own
  // with no code in between.
  const {root,taskId}=await worked();
  const s=await startServer(root);
  try{
    // Published to the task branch first, which is what a port does when the branch it
    // would land on is checked out here, and the state a person is in when they decide
    // to do the merge themselves.
    const port=await post(`${s.base}/api/tasks/${taskId}/port`,{});
    assert.equal(port.status,200);
    const branch=JSON.parse(port.body).branch;
    assert.ok(branch,`the port published to a branch: ${port.body}`);
    const before=JSON.parse((await get(`${s.base}/api/tasks/${taskId}/diff`)).body);
    assert.notEqual(before.state.key,'landed','nothing has landed yet');

    const ws=await opened(terminalSocket(s.base,taskId,'parent'));
    const r=reader(ws);
    sized(ws,200,50);
    // No pager and no colour: an interactive shell hands `git log` to `less`, which
    // opens the alternate screen and waits for a keypress that nothing here is going to
    // send. That is the right behaviour for a person and the wrong one for a reader.
    typed(ws,'git --no-pager -c color.ui=false log --oneline\n');
    // A hash opening a line of git's own output - `f76f79a (HEAD -> main) init` -
    // and not the same characters inside the echoed command.
    await r.until(/[0-9a-f]{7,} \((HEAD|tag:)/);
    // The exit code is echoed rather than inferred from the output: `git merge` answers
    // "Already up to date." with a zero and a conflict with something that reads like
    // progress, and the assertion below is about the ref having moved.
    typed(ws,`git merge ${branch}; echo MERGE-EXIT=$?\n`);
    await r.until(/MERGE-EXIT=0/);
    ws.close();

    const after=JSON.parse((await get(`${s.base}/api/tasks/${taskId}/diff`)).body);
    assert.equal(after.state.key,'landed','a merge the port did not perform is still its answer');
    // The commit it names is the one now at the destination. Nothing moved main before
    // the merge, so that is a fast-forward and the commit is the branch's own tip.
    assert.equal(after.landedAs.sha,read(root,['rev-parse','HEAD']));
    assert.deepEqual(after.next,[]);
  }finally{s.stop()}
});

test('the dashboard pins the terminal emulator beside the other CDN modules',async()=>{
  // Same class of check as the markdown pins: the tab hands PTY output to xterm, and a
  // dropped pin or a renamed specifier breaks the tab at load rather than at render,
  // where nothing in the unit suite can see it.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-xterm-'));
  const s=await startServer(root);
  try{
    const r=await get(`${s.base}/`);
    assert.equal(r.status,200);
    const pins={
      '@xterm/xterm':'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs',
      '@xterm/addon-fit':'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs',
    };
    for(const [name,url] of Object.entries(pins)){
      const re=new RegExp(`"${name}"\\s*:\\s*"${url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"`);
      assert.match(r.body,re,`the import map should pin ${name}`);
    }
    // The emulator's own stylesheet. Without it the terminal is an unstyled column of
    // text on a transparent box.
    assert.match(r.body,/@xterm\/xterm@6\.0\.0\/css\/xterm\.css/);

    const pane=await get(`${s.base}/components/terminal.mjs`);
    assert.equal(pane.status,200);
    assert.match(pane.body,/from '@xterm\/xterm'/);
    assert.match(pane.body,/from '@xterm\/addon-fit'/);
    // The tab itself, which is the only thing that reaches the component.
    const view=await get(`${s.base}/views/task-detail.mjs`);
    assert.match(view.body,/from '\.\.\/components\/terminal\.mjs'/);
    assert.match(view.body,/'terminal'/);
  }finally{s.stop()}
});

// A task naming the task it builds on, over HTTP. The link is one field written
// through two routes - at creation and afterwards - and the header that renders it
// reads the parent's *title*, which is why `show` carries the row and not the id.
test('POST /api/tasks carries a parent, and /link sets and clears it',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-parent-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const parent=s.createTask(p.id,'move the queue into runner.mjs');
  const srv=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  try{
    const created=await post(`${srv.base}/api/tasks`,{projectId:p.id,title:'make it survive a restart',parentId:parent.id});
    assert.equal(created.status,201);
    const child=JSON.parse(created.body);
    assert.equal(child.parent_id,parent.id,'the parent is set on the row the response carries');
    assert.equal(s.task(child.id).parent_id,parent.id);
    const show=JSON.parse((await get(`${srv.base}/api/tasks/${child.id}/show`)).body);
    assert.equal(show.parent.id,parent.id,'the show payload resolves the row, not only the id');
    assert.equal(show.parent.title,'move the queue into runner.mjs');
    // The task with no link says so with null rather than with an absent key, so a
    // client can tell "no parent" from "this server does not know about parents".
    const alone=JSON.parse((await post(`${srv.base}/api/tasks`,{projectId:p.id,title:'unrelated'})).body);
    assert.equal(alone.parent_id,null);
    assert.equal(JSON.parse((await get(`${srv.base}/api/tasks/${alone.id}/show`)).body).parent,null);
    // Set after the fact, then cleared by naming nothing.
    assert.equal(JSON.parse((await post(`${srv.base}/api/tasks/${alone.id}/link`,{parentId:parent.id})).body).parent_id,parent.id);
    assert.equal(s.task(alone.id).parent_id,parent.id);
    assert.equal(JSON.parse((await post(`${srv.base}/api/tasks/${alone.id}/link`,{})).body).parent_id,null);
    assert.equal(s.task(alone.id).parent_id,null);
    // A parent that is not there is a 400 with the reason, not a 500.
    const bad=await post(`${srv.base}/api/tasks/${alone.id}/link`,{parentId:'no-such-task'});
    assert.equal(bad.status,400);
    assert.match(JSON.parse(bad.body).error,/not found/);
    assert.equal(s.task(alone.id).parent_id,null);
  }finally{srv.stop()}
});

// Feedback on a completed task, which is the one write that takes a task back out
// of COMPLETE. Over HTTP because that is where the empty box is refused: a 400 with
// a reason is a better answer to it than a run that fails after the transition.
test('POST /api/tasks/:id/feedback re-opens a completed task, and refuses an empty note',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-feedback-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  // A mock that writes, so the repair changes the tree. One that did not would be
  // read as a repair that answered nothing, and the cycle would stop in REVIEWING
  // instead of running the verification this test is about.
  s.updateProvider('mock',{config:{writes:['app.mjs']}});
  const t=s.createTask(p.id,'build the queue');
  s.prepare(t.id);
  const srv=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  try{
    assert.equal((await post(`${srv.base}/api/tasks/${t.id}/plan`)).status,200);
    assert.equal((await post(`${srv.base}/api/tasks/${t.id}/approve`)).status,200);
    assert.equal(JSON.parse((await post(`${srv.base}/api/tasks/${t.id}/execute`,{})).body).state,'COMPLETE');
    const empty=await post(`${srv.base}/api/tasks/${t.id}/feedback`,{text:'   '});
    assert.equal(empty.status,400);
    assert.match(JSON.parse(empty.body).error,/text is required/);
    assert.equal(s.task(t.id).state,'COMPLETE','a refused note leaves the task where it was');
    const back=await post(`${srv.base}/api/tasks/${t.id}/feedback`,{text:'The retry path needs a test.'});
    assert.equal(back.status,200);
    // The whole cycle ran inside the request: repair, the test command, and the
    // verification that signed the work off again.
    assert.equal(s.task(t.id).state,'COMPLETE');
    assert.equal(s.task(t.id).feedback,null,'the note is spent on the repair it was written for');
    const runs=s.store.listRuns(t.id);
    assert.equal(runs.filter(r=>r.role==='repair').length,1,'the repair the note was written for ran');
    assert.equal(runs.filter(r=>r.role==='reviewer').length,2,'and the verification after it, which is what the cycle ends on');
  }finally{srv.stop()}
});

// A conversation scoped to a task: how a question about a finished one is asked
// with that task's plan and review in hand, rather than against the tree alone.
test('POST /api/chat/sessions accepts a task to scope the conversation to',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-chat-task-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'move the queue into runner.mjs');
  const srv=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  try{
    const r=await post(`${srv.base}/api/chat/sessions`,{projectId:p.id,taskId:t.id});
    assert.equal(r.status,201);
    const body=JSON.parse(r.body);
    assert.equal(body.task_id,t.id);
    assert.equal(body.title,'Questions about move the queue into runner.mjs');
    // The unscoped session is the project-wide chat it has always been, down to the
    // column being null rather than absent.
    const plain=JSON.parse((await post(`${srv.base}/api/chat/sessions`,{projectId:p.id})).body);
    assert.equal(plain.task_id,null);
    assert.equal(plain.title,'New chat');
    // A subject that is not there is a 400, like every other reference this API
    // refuses, rather than a session scoped to nothing.
    const bad=await post(`${srv.base}/api/chat/sessions`,{projectId:p.id,taskId:'no-such-task'});
    assert.equal(bad.status,400);
    assert.match(JSON.parse(bad.body).error,/not found/);
  }finally{srv.stop()}
});

// The CLI's own handling of the two new verbs, which is where the flag scanning
// lives: `--parent` has to come out of the description before the words are joined,
// and it has to come out of the words after the project id rather than out of all of
// them, or the project id is what gets eaten.
test('ai-code task create takes --parent without eating the description or the project',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-cli-parent-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const run=(args)=>new Promise((res)=>{const proc=spawn(process.execPath,[cliPath,'task',...args],{cwd:root,env:{...process.env,AI_CODE_ROOT:root},stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',c=>out+=c);proc.stderr.on('data',c=>err+=c);proc.on('close',code=>res({code,out,err}))});
  const parent=JSON.parse((await run(['create',p.id,'move the queue into runner.mjs'])).out);
  const created=await run(['create',p.id,'make','it','survive','a','restart','--parent',parent.id]);
  assert.equal(created.code,0,created.err);
  const child=JSON.parse(created.out);
  assert.equal(child.parent_id,parent.id);
  assert.equal(child.description,'make it survive a restart','the flag and its value are not part of the text');
  assert.equal(child.project_id,p.id,'and the project id is not one of the two words that came out');
  // A flag with nothing after it is refused rather than silently read as an empty
  // parent, which would be a task created with the flag still in its description.
  const dangling=await run(['create',p.id,'x','--parent']);
  assert.equal(dangling.code,1);
  assert.match(dangling.err,/--parent needs a task id/);
  // The link set after the fact, then cleared by naming nothing.
  const other=JSON.parse((await run(['create',p.id,'a second candidate'])).out);
  assert.equal(JSON.parse((await run(['link',child.id,other.id])).out).parent_id,other.id);
  assert.equal(JSON.parse((await run(['link',child.id])).out).parent_id,null);
  // `show` reports the parent row, which is the only way a person reads the link
  // from the CLI without a second command to resolve the id.
  await run(['link',child.id,parent.id]);
  const shown=JSON.parse((await run(['show',child.id])).out);
  assert.equal(shown.parent.id,parent.id);
  assert.equal(shown.parent.title,'move the queue into runner.mjs');
});

// The dispatch arm, not the cycle: this task is not COMPLETE, so the refusal is the
// proof the verb reached the service. An unwired arm answers with the
// "Unhandled task operation" a verb missing from the chain falls through to.
test('ai-code task feedback reaches the service rather than falling through the chain',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-cli-feedback-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const s=new Service(root,{allowMock:true,silent:true});
  const p=s.initProject('p',root);
  const t=s.createTask(p.id,'build the queue');
  const r=await new Promise((res)=>{const proc=spawn(process.execPath,[cliPath,'task','feedback',t.id,'do','it','differently'],{cwd:root,env:{...process.env,AI_CODE_ROOT:root},stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',c=>out+=c);proc.stderr.on('data',c=>err+=c);proc.on('close',code=>res({code,out,err}))});
  assert.equal(r.code,1);
  assert.match(r.err,/COMPLETE/);
  assert.doesNotMatch(r.err,/Unhandled task operation/);
  assert.equal(s.task(t.id).state,'CREATED');
});

// --- ai-code shell ----------------------------------------------------------
//
// One spawned process, its output collected. A variable set to undefined in `env`
// is removed rather than passed on as the string "undefined", which is how a test
// says "this key is not in the environment".
function spawnCapture(cmd,args,{cwd,env={}}={}){
  const e={...process.env,...env};
  for(const k of Object.keys(e)) if(e[k]===undefined) delete e[k];
  return new Promise((res)=>{
    const p=spawn(cmd,args,{cwd,env:e,stdio:['ignore','pipe','pipe']});
    let out='',err='';
    p.stdout.on('data',(c)=>out+=c);
    p.stderr.on('data',(c)=>err+=c);
    p.on('close',(code)=>res({code,out,err}));
  });
}

// A root with the deepseek provider installed through the real command, and a
// `claude` shim first on PATH that records the environment it was handed. The shim
// is what makes the assertion possible at all: without it, seeing which endpoint a
// session was pointed at would mean opening one and asking it.
async function shellFixture(root){
  root=root||fs.mkdtempSync(path.join(os.tmpdir(),'aicode-shell-'));
  git(root,['init','-q']);
  fs.writeFileSync(path.join(root,'README.md'),'x');
  git(root,['add','.']);
  git(root,['-c','user.email=t@e.com','-c','user.name=T','commit','-qm','init']);
  const shim=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-shim-'));
  const dump=path.join(shim,'env.txt');
  fs.writeFileSync(path.join(shim,'claude'),'#!/bin/sh\n{ echo "argv: $*"; printenv | sort; } > "$SHIM_OUT"\nexit 0\n',{mode:0o755});
  const add=await spawnCapture(process.execPath,[cliPath,'provider','add-deepseek'],{cwd:root,env:{AI_CODE_ROOT:root}});
  assert.equal(add.code,0,add.err);
  return {root,shim,dump};
}

test('shell opens the session on the provider rather than on the subscription',async()=>{
  const {root,shim,dump}=await shellFixture();
  const r=await spawnCapture(process.execPath,[cliPath,'shell','deepseek-claude-code','-p','hi'],{
    cwd:root,
    env:{AI_CODE_ROOT:root,PATH:`${shim}:${process.env.PATH}`,SHIM_OUT:dump,DEEPSEEK_API_KEY:'test-key',ANTHROPIC_MODEL:'ambient-model',ANTHROPIC_API_KEY:'ambient-key'},
  });
  assert.equal(r.code,0,r.err);
  const env=fs.readFileSync(dump,'utf8');
  assert.match(env,/^ANTHROPIC_BASE_URL=https:\/\/api\.deepseek\.com\/anthropic$/m);
  assert.match(env,/^ANTHROPIC_AUTH_TOKEN=test-key$/m);
  // The cheapest model in the catalog, which is what the shell's env default is -
  // and the ambient model the person had exported is gone, not passed through.
  assert.match(env,/^ANTHROPIC_MODEL=deepseek-flash$/m);
  assert.match(env,/^argv: -p hi$/m);
  assert.doesNotMatch(env,/^ANTHROPIC_API_KEY=/m,'the subscription key must not reach the session');
  assert.doesNotMatch(env,/ambient-model/);
});

// The command the user types, end to end: the wrapper resolves the CLI beside it and
// the session that opens is the provider's. This is the regression test for the
// reported symptom, which was this wrapper opening a subscription session.
test('bin/claude-cheap runs the session on the provider',async()=>{
  const {root,shim,dump}=await shellFixture();
  const r=await spawnCapture(path.resolve('bin','claude-cheap'),['-p','hi'],{
    cwd:root,
    env:{AI_CODE_ROOT:root,PATH:`${shim}:${process.env.PATH}`,SHIM_OUT:dump,DEEPSEEK_API_KEY:'test-key'},
  });
  assert.equal(r.code,0,r.err);
  const env=fs.readFileSync(dump,'utf8');
  assert.match(env,/^ANTHROPIC_BASE_URL=https:\/\/api\.deepseek\.com\/anthropic$/m);
  assert.match(env,/^ANTHROPIC_MODEL=deepseek-flash$/m);
});

// And the registry it reads is the installed one under $HOME, the same root the
// `ai-code` beside it resolves. The CLI's own default is the current directory, so a
// wrapper without the export looks for the provider wherever you happen to be
// standing and reports it missing - so the cwd here is deliberately a different
// place from the store.
test('bin/claude-cheap finds the registry under the installed root, not the current directory',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-home-'));
  const root=path.join(home,'.ai-code');
  fs.mkdirSync(root);
  const {shim,dump}=await shellFixture(root);
  const elsewhere=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-cwd-'));
  const r=await spawnCapture(path.resolve('bin','claude-cheap'),['-p','hi'],{
    cwd:elsewhere,
    env:{HOME:home,AI_CODE_ROOT:undefined,PATH:`${shim}:${process.env.PATH}`,SHIM_OUT:dump,DEEPSEEK_API_KEY:'test-key'},
  });
  assert.equal(r.code,0,r.err);
  assert.match(fs.readFileSync(dump,'utf8'),/^ANTHROPIC_BASE_URL=https:\/\/api\.deepseek\.com\/anthropic$/m);
});

// The failure that replaces the silent fallback: no key is a refusal, not a session
// on whatever login the machine happens to carry.
test('shell refuses to open a session when the provider key is missing',async()=>{
  const {root,shim,dump}=await shellFixture();
  const r=await spawnCapture(process.execPath,[cliPath,'shell','deepseek-claude-code','-p','hi'],{
    cwd:root,
    env:{AI_CODE_ROOT:root,PATH:`${shim}:${process.env.PATH}`,SHIM_OUT:dump,DEEPSEEK_API_KEY:undefined},
  });
  assert.equal(r.code,1);
  assert.match(r.err,/DEEPSEEK_API_KEY/);
  assert.equal(fs.existsSync(dump),false,'claude must not have been started at all');
});

test('shell names a provider it does not know',async()=>{
  const {root,shim,dump}=await shellFixture();
  const r=await spawnCapture(process.execPath,[cliPath,'shell','nope'],{
    cwd:root,
    env:{AI_CODE_ROOT:root,PATH:`${shim}:${process.env.PATH}`,SHIM_OUT:dump,DEEPSEEK_API_KEY:'test-key'},
  });
  assert.equal(r.code,1);
  assert.match(r.err,/add-deepseek/);
});

// ---------------------------------------------------------------------------
// Phone access: the token gate, the bind, and Web Push.

// One request with headers this test chooses. `get` above cannot send a Host or an
// Authorization, and both are the whole subject here.
function withHeaders(url,headers={},method='GET'){
  return new Promise((res,rej)=>{const u=new URL(url);const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname+u.search,method,headers},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res({status:r.statusCode,body:b}))});req.on('error',rej);req.end()});
}

// Waits for a spawned process to exit, and answers null when it outlives the
// deadline. `close` rather than `exit` because the assertions below are about a
// server that stopped, and a process still holding a socket has not.
function waitExit(proc,ms){
  if(proc.exitCode!==null||proc.signalCode)return Promise.resolve({code:proc.exitCode,signal:proc.signalCode});
  return new Promise((res)=>{const t=setTimeout(()=>res(null),ms);proc.once('close',(code,signal)=>{clearTimeout(t);res({code,signal})})});
}

// The token the server prints, read off its own stdout. A test that invented its own
// would be testing a comparison rather than the announcement a person pairs from.
async function startedWithToken(root,extra={}){
  const port=await freePort();
  const proc=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),env:{...process.env,AI_CODE_ROOT:root,PORT:String(port),...extra},stdio:['ignore','pipe','pipe']});
  const base=`http://localhost:${port}`;
  // Whatever the ambient environment holds would otherwise decide the answer for a
  // test that is about what happens when no token is configured.
  let out='';let stderr='';let exited=null;
  proc.stdout.on('data',(c)=>{out+=c});
  proc.stderr.on('data',(c)=>{stderr+=c});
  proc.on('exit',(code)=>{if(!exited)exited={code}});
  const deadline=Date.now()+20000;
  for(;;){
    if(exited)throw new Error(`server exited (${exited.code}) before it answered\n${stderr}`);
    const token=out.match(/^API token: (.+)$/m)?.[1];
    if(token&&(await probe(`${base}/api/overview`))?.status===200)return {proc,base,port,token,stop:()=>proc.kill('SIGTERM')};
    if(Date.now()>deadline){proc.kill('SIGKILL');throw new Error(`server never announced a token on :${port}\n${out}\n${stderr}`)}
    await new Promise(r=>setTimeout(r,25));
  }
}

// The header the phone does not send and the one it does. A request carrying the
// machine's Tailscale name is not on loopback, whichever socket it arrived on, and that
// is the whole mechanism: `tailscale serve` proxies from loopback, so only the Host
// distinguishes the phone from the desktop behind it.
const TS_HOST={host:'workstation.tailnet-abc.ts.net'};

test('an API request from off-loopback is refused without the token, and served with it',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-auth-'));
  const s=await startedWithToken(root);
  try{
    // The regression guard for the desktop, the TUI and the CLI: all three send a
    // loopback Host and none of them has a token to send. If this ever fails, the
    // dashboard on this machine stops working.
    assert.equal((await get(`${s.base}/api/overview`)).status,200);
    assert.equal((await withHeaders(`${s.base}/api/overview`,{host:'localhost:'+s.port})).status,200);

    assert.equal((await withHeaders(`${s.base}/api/overview`,TS_HOST)).status,401);
    assert.equal((await withHeaders(`${s.base}/api/overview`,{...TS_HOST,authorization:`Bearer ${s.token}`})).status,200);
    // EventSource and the WebSocket constructor cannot set a header, so the query
    // string is the transport for both.
    assert.equal((await withHeaders(`${s.base}/api/overview?token=${encodeURIComponent(s.token)}`,TS_HOST)).status,200);
    assert.equal((await withHeaders(`${s.base}/api/overview`,{...TS_HOST,authorization:'Bearer not-the-token'})).status,401);
    assert.equal((await withHeaders(`${s.base}/api/overview?token=not-the-token`,TS_HOST)).status,401);
    // A token of a different length must be refused rather than throw: the comparison
    // is over digests, which is what makes the lengths equal whatever arrives.
    assert.equal((await withHeaders(`${s.base}/api/overview`,{...TS_HOST,authorization:'Bearer x'})).status,401);

    // The shell a phone loads before it has a token has to be reachable without one,
    // or there is nothing to pair with.
    assert.equal((await withHeaders(`${s.base}/`,TS_HOST)).status,200);
    assert.equal((await withHeaders(`${s.base}/app.mjs`,TS_HOST)).status,200);
    assert.equal((await withHeaders(`${s.base}/manifest.webmanifest`,TS_HOST)).status,200);
    assert.equal((await withHeaders(`${s.base}/sw.js`,TS_HOST)).status,200);
    assert.equal((await withHeaders(`${s.base}/icons/icon-192.png`,TS_HOST)).status,200);
  }finally{s.stop()}
});

test('the manifest is served as a manifest, which is what makes the app installable',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-manifest-'));
  const s=await startedWithToken(root);
  try{
    const r=await new Promise((res,rej)=>{const u=new URL(s.base);const req=http.get({hostname:u.hostname,port:u.port,path:'/manifest.webmanifest'},(x)=>{let b='';x.on('data',(c)=>b+=c);x.on('end',()=>res({status:x.statusCode,type:x.headers['content-type'],body:b}))});req.on('error',rej)});
    assert.equal(r.status,200);
    // Chrome accepts octet-stream and installability checks do not.
    assert.match(r.type,/application\/manifest\+json/);
    const m=JSON.parse(r.body);
    assert.equal(m.display,'standalone');
    assert.ok(m.icons.some((i)=>i.purpose==='maskable'),'a launcher crops the icon, so one has to survive it');
  }finally{s.stop()}
});

test('the dashboard sends no CORS grant, so another origin cannot read the API',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-cors-'));
  const s=await startedWithToken(root);
  try{
    const r=await new Promise((res,rej)=>{const u=new URL(s.base);const req=http.get({hostname:u.hostname,port:u.port,path:'/api/overview'},(x)=>{x.resume();x.on('end',()=>res({status:x.statusCode,headers:x.headers}))});req.on('error',rej)});
    assert.equal(r.status,200);
    assert.equal(r.headers['access-control-allow-origin'],undefined);
  }finally{s.stop()}
});

test('a token can be supplied by environment instead of generated',async()=>{
  // An install that manages its own secret, which is also the only way a non-loopback
  // bind is allowed to start.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-envtoken-'));
  const s=await startedWithToken(root,{AI_CODE_TOKEN:'chosen-by-the-operator'});
  try{
    assert.equal((await withHeaders(`${s.base}/api/overview`,{...TS_HOST,authorization:'Bearer chosen-by-the-operator'})).status,200);
    assert.equal((await withHeaders(`${s.base}/api/overview`,TS_HOST)).status,401);
  }finally{s.stop()}
});

test('the token survives a restart, so a paired phone stays paired',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-tokenpersist-'));
  const first=await startedWithToken(root);
  const token=first.token;
  first.stop();
  await new Promise(r=>setTimeout(r,250));
  const second=await startedWithToken(root);
  try{
    assert.equal(second.token,token);
    assert.equal((await withHeaders(`${second.base}/api/overview`,{...TS_HOST,authorization:`Bearer ${token}`})).status,200);
  }finally{second.stop()}
});

test('a bind that is not loopback refuses to start without an explicitly named token',async()=>{
  // The address is reachable by anything on the network, so it does not get to run on
  // a secret this process invented and printed to a log nobody is reading.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-bind-'));
  const proc=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),env:{...process.env,AI_CODE_ROOT:root,PORT:'0',AI_CODE_HOST:'0.0.0.0',AI_CODE_TOKEN:''},stdio:['ignore','pipe','pipe']});
  let stderr='';
  proc.stderr.on('data',(c)=>{stderr+=c});
  const code=await new Promise((res)=>proc.on('exit',(c)=>res(c)));
  assert.notEqual(code,0,'exited 0, so an unauthenticated API was left listening on every interface');
  assert.match(stderr,/AI_CODE_TOKEN/);
});

test('a bind that is not loopback starts when the token is named',async()=>{
  // The other half: the refusal above is a guard, not a ban on the configuration.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-bindok-'));
  const port=await freePort();
  const proc=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),env:{...process.env,AI_CODE_ROOT:root,PORT:String(port),AI_CODE_HOST:'127.0.0.1',AI_CODE_TOKEN:'named-for-the-bind'},stdio:['ignore','pipe','pipe']});
  try{
    const deadline=Date.now()+20000;
    for(;;){
      if((await probe(`http://localhost:${port}/api/overview`))?.status===200)break;
      if(Date.now()>deadline)throw new Error('the server never answered on an explicitly named loopback bind');
      await new Promise(r=>setTimeout(r,25));
    }
    // Still exempt on loopback, so naming a token does not lock the desktop out.
    assert.equal((await get(`http://localhost:${port}/api/overview`)).status,200);
  }finally{proc.kill('SIGKILL')}
});

test('push is offered, subscribable, and unsubscribable',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-push-'));
  const s=await startedWithToken(root);
  try{
    const key=JSON.parse((await get(`${s.base}/api/push/key`)).body);
    // A VAPID public key is an uncompressed P-256 point: 65 bytes, base64url.
    assert.match(key.key,/^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(key.key.replace(/-/g,'+').replace(/_/g,'/'),'base64').length,65);

    const sub={endpoint:'https://fcm.googleapis.com/fcm/send/abc',keys:{p256dh:'p',auth:'a'}};
    const added=await post(`${s.base}/api/push/subscribe`,sub);
    assert.equal(added.status,201);
    assert.equal(JSON.parse(added.body).subscriptions,1);
    // Re-subscribing from the same browser replaces rather than duplicates, which is
    // what a rotated keypair looks like from here.
    assert.equal((await post(`${s.base}/api/push/subscribe`,{endpoint:sub.endpoint,keys:{p256dh:'p2',auth:'a2'}})).status,201);
    assert.equal((await post(`${s.base}/api/push/unsubscribe`,{endpoint:sub.endpoint})).status,200);
    assert.equal((await post(`${s.base}/api/push/unsubscribe`,{endpoint:sub.endpoint})).status,200,'unsubscribing twice is not an error');
    assert.equal((await post(`${s.base}/api/push/subscribe`,{endpoint:'nope'})).status,400);
  }finally{s.stop()}
});

test('the VAPID keypair is generated once and kept, so subscriptions outlive a restart',async()=>{
  // A keypair that changed on every start would silently invalidate every subscription
  // ever made, and the failure looks like "push just stopped working".
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-vapid-'));
  const first=await startedWithToken(root);
  const key=JSON.parse((await get(`${first.base}/api/push/key`)).body).key;
  first.stop();
  await new Promise(r=>setTimeout(r,250));
  const second=await startedWithToken(root);
  try{
    assert.equal(JSON.parse((await get(`${second.base}/api/push/key`)).body).key,key);
  }finally{second.stop()}
});

// A push service stand-in. `web-push` speaks only TLS - it parses the endpoint itself
// and builds the request with `https.request` - so the stub has to be an HTTPS server,
// and the certificate is generated per run rather than checked in: a checked-in fixture
// expires, and a test that fails on a calendar date is a test nobody trusts. Only the
// child server is told to accept it, through NODE_TLS_REJECT_UNAUTHORIZED.
function pushStub(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-pushstub-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'k.pem'),'-out',path.join(dir,'c.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const received=[];
  const server=https.createServer({key:fs.readFileSync(path.join(dir,'k.pem')),cert:fs.readFileSync(path.join(dir,'c.pem'))},(req,res)=>{
    let body='';req.on('data',(c)=>body+=c);
    req.on('end',()=>{
      received.push({path:req.url,headers:req.headers,body});
      // 410 Gone is the push service saying this subscription is dead for good, which
      // is the one answer the server acts on. The path is what makes a subscription
      // dead, so one stub can be both a live service and an expired one.
      const dead=req.url.startsWith('/dead');
      res.writeHead(dead?410:201);res.end();
    });
  });
  return {
    received,
    listen:()=>new Promise((ok)=>server.listen(0,'127.0.0.1',()=>ok(server.address().port))),
    close:()=>new Promise((ok)=>server.close(ok)),
  };
}

// The client half of a subscription, which web-push will not encrypt to unless the keys
// are real: `p256dh` is an uncompressed P-256 point and `auth` is 16 random bytes, both
// base64url, both generated here rather than faked.
function subscriptionKeys(){
  const ecdh=crypto.createECDH('prime256v1');ecdh.generateKeys();
  return {p256dh:ecdh.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')};
}

// The notification stream has no natural end - it is open for as long as a dashboard
// is - so it is read incrementally and closed by the test rather than awaited to its
// end, which would wait forever.
function openNotificationStream(url){
  let text='';
  const req=http.get(url,(r)=>{r.on('data',(c)=>{text+=c})});
  req.on('error',()=>{});
  return {text:()=>text,close:()=>req.destroy()};
}

async function untilFrame(reader,type,ms=25000){
  const deadline=Date.now()+ms;
  for(;;){
    if(frames(reader.text()).some((f)=>f.type===type))return;
    if(Date.now()>deadline)throw new Error(`no ${type} frame within ${ms}ms\n${reader.text()}`);
    await new Promise((r)=>setTimeout(r,100));
  }
}

test('a run that ends pushes once, to every subscription, however many dashboards are watching',async(t)=>{
  try{execFileSync('openssl',['version'],{stdio:'ignore'})}catch{return t.skip('openssl is not on this machine, so no local TLS endpoint can stand in for a push service')}
  const {root,taskId}=seeded();
  const stub=pushStub();
  const stubPort=await stub.listen();
  // The child is told to trust the stub's self-signed certificate. Scoped to that one
  // process; nothing about this test loosens TLS anywhere else.
  const s=await startedWithToken(root,{NODE_TLS_REJECT_UNAUTHORIZED:'0',AI_CODE_ALLOW_MOCK:'1'});
  const viewers=[];
  try{
    const good=`https://127.0.0.1:${stubPort}/good`;
    const dead=`https://127.0.0.1:${stubPort}/dead`;
    for(const endpoint of [good,dead])assert.equal((await post(`${s.base}/api/push/subscribe`,{endpoint,keys:subscriptionKeys()})).status,201);

    // Two dashboards, which is the case a per-connection push would get wrong: it would
    // send two notifications for one run, and none at all when nobody is watching -
    // and "nobody is watching" is exactly the backgrounded phone.
    viewers.push(openNotificationStream(`${s.base}/api/notifications`),openNotificationStream(`${s.base}/api/notifications`));
    await new Promise((r)=>setTimeout(r,300));

    assert.equal((await post(`${s.base}/api/tasks/${taskId}/plan`,{})).status,200);
    await untilFrame(viewers[0],'run-end');

    // web-push resolves the send before the frame loop drains, so the stub may be a
    // tick behind the stream the assertion above waited on.
    const deadline=Date.now()+15000;
    while(stub.received.length<2&&Date.now()<deadline)await new Promise((r)=>setTimeout(r,50));
    assert.equal(stub.received.length,2,`one run-end produced ${stub.received.length} sends for two watchers and two subscriptions`);
    for(const r of stub.received){
      assert.equal(r.headers['content-encoding'],'aes128gcm');
      assert.match(r.headers.authorization||'',/^vapid t=/,'a push has to be signed by the install key or the service drops it');
      assert.ok(r.body.length>0);
    }

    // The dead subscription answered 410, which is the one answer that means "delete
    // this row" - so the next subscribe reports one fewer than it otherwise would.
    const after=await post(`${s.base}/api/push/subscribe`,{endpoint:`https://127.0.0.1:${stubPort}/another`,keys:subscriptionKeys()});
    assert.equal(JSON.parse(after.body).subscriptions,2,`the dead subscription was kept: ${JSON.stringify(stub.received.map((r)=>r.path))}`);
  }finally{
    for(const v of viewers)v.close();
    s.stop();
    await stub.close();
  }
});

test('a run already in flight when the server starts is announced when it ends',async()=>{
  // The seed that keeps history quiet is the same seed that can swallow the news: a
  // foreground `ai-code task execute` is a run in another process, and a dashboard
  // starting under it has to report it when it lands. Both transports hang off the one
  // publish point, so the frame asserted here is also the push.
  const {root,taskId}=seeded();
  const s=new Service(root,{allowMock:true,silent:true});
  s.store.addRun({id:'inflight',taskId,role:'implementer',providerId:'worker',modelId:'worker-m',status:'running',startedAt:new Date().toISOString()});
  // A fresh lease, so the server's own reaper leaves the row alone: this is a run the
  // process holding it is still driving, not debris from a crash.
  s.store.heartbeat('inflight',taskId);
  const server=await startServer(root,{AI_CODE_ALLOW_MOCK:'1'});
  const viewer=openNotificationStream(`${server.base}/api/notifications`);
  try{
    // Longer than a tick, so a watcher that had announced the run at startup would have
    // done so by now - a live run announced as a finished one being the same defect
    // from the other side.
    await new Promise((r)=>setTimeout(r,1500));
    assert.equal(frames(viewer.text()).filter((f)=>f.type==='run-end').length,0,'a run still in flight is not a run that ended');

    s.store.updateRun('inflight',{status:'succeeded',endedAt:new Date().toISOString(),durationMs:1000});
    await untilFrame(viewer,'run-end');
    const ends=frames(viewer.text()).filter((f)=>f.type==='run-end');
    assert.equal(ends.length,1,`one run-end for one run, got ${ends.length}`);
    assert.equal(ends[0].data.run.id,'inflight');
    assert.equal(ends[0].data.task.id,taskId,'the frame names the task, which is what a notification deep-links to');
  }finally{viewer.close();server.stop()}
});

// ---------------------------------------------------------------------------
// The server's own control surface: what it is, and how it is stopped.

test('the status route reports the process, and only to a caller on loopback',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-status-'));
  const s=await startedWithToken(root);
  try{
    const r=await withHeaders(`${s.base}/api/server/status`,{host:'localhost:'+s.port});
    assert.equal(r.status,200);
    const st=JSON.parse(r.body);
    assert.equal(st.pid,s.proc.pid,'the pid is the process a Stop button would be ending');
    assert.equal(st.port,s.port,'the bound port, which is the one the dashboard is on');
    assert.equal(st.host,'127.0.0.1');
    assert.equal(st.root,root,'the root is the checkout, which is what names the database being served');
    assert.equal(typeof st.startedAt,'number');
    assert.ok(st.uptimeMs>0&&st.uptimeMs<60000,`uptimeMs read ${st.uptimeMs} just after startup`);
    // Both are empty here; the shape is the point, because the Settings card renders
    // the two numbers and a missing key would render as undefined rather than as zero.
    assert.deepEqual(st.jobs,{queued:0,running:0});
    // The status route sits behind the same gate as every other /api route, so it is
    // never a way to read the machine without pairing - and never a way to read the
    // token itself.
    assert.equal(JSON.stringify(st).includes(s.token),false,'the status route must not repeat the token');

    assert.equal((await withHeaders(`${s.base}/api/server/status`,TS_HOST)).status,401);
    assert.equal((await withHeaders(`${s.base}/api/server/status`,{...TS_HOST,authorization:`Bearer ${s.token}`})).status,200);
  }finally{s.stop()}
});

test('a loopback shutdown answers first, then takes the server down',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-shutdown-'));
  const s=await startedWithToken(root);
  // The reply arrives before the shutdown runs, which is the whole reason this is a
  // 202 rather than a 200: a client that got no answer could not tell a stop that
  // worked from a socket that was closed under it.
  const r=await withHeaders(`${s.base}/api/server/shutdown`,{host:'localhost:'+s.port},'POST');
  assert.equal(r.status,202);
  assert.deepEqual(JSON.parse(r.body),{stopping:true});

  const exited=await waitExit(s.proc,7000);
  assert.ok(exited,'the server was still running seven seconds after it was told to stop');
  assert.equal(exited.code,0,`expected a clean exit, got ${JSON.stringify(exited)}`);
  // The port is the thing that has to be free: a process that exited but left the
  // listener to a child would answer here, and the next start would find the port busy.
  assert.equal(await probe(`${s.base}/api/overview`),null,'the port is still held after the server stopped');
});

test('a phone holding a valid token cannot stop the server',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-shutdown-remote-'));
  const s=await startedWithToken(root);
  try{
    const r=await withHeaders(`${s.base}/api/server/shutdown`,{...TS_HOST,authorization:`Bearer ${s.token}`},'POST');
    // The same narrowing the terminal route applies: a valid token is permission to
    // reach the API, not to end the machine's dashboard - which on a phone in a pocket
    // is a stop nobody meant to press.
    assert.equal(r.status,403);
    assert.match(JSON.parse(r.body).error,/this machine/);
    assert.equal((await get(`${s.base}/api/overview`)).status,200,'a refused stop left the server running');
  }finally{s.stop()}
});
