import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import net from 'node:net';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';

// The supervisor holds the port while the dashboard is down, so most of these
// assertions are about *which* of two processes answered: the marker header is the
// only thing that tells them apart when both are reachable on the same host and port.
const MARKER='x-ai-code-supervisor';

// A port nobody is holding. Hardcoded ones are how a suite goes green against a
// stranger's server.
function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>res(port))})})}

// One request, and `null` when nothing answered. A refused connection is one of the
// answers here - "the port is free" is what the supervisor decides on - so it is
// resolved rather than thrown. The Host is set explicitly, because the loopback check
// that guards both control routes reads it and `127.0.0.1:port` is what a browser on
// this machine sends.
function tryGet(url,{host,method='GET'}={}){
  return new Promise((res)=>{
    const u=new URL(url);
    const req=http.request({hostname:u.hostname,port:u.port,path:u.pathname+u.search,method,headers:{host:host||u.host}},r=>{
      let b='';r.on('data',c=>b+=c);r.on('end',()=>res({status:r.statusCode,body:b,headers:r.headers}));
    });
    req.on('error',()=>res(null));
    req.end();
  });
}

// Polls until `fn` answers something truthy, or gives up. Every wait in this file is a
// state change in another process, which no fixed sleep can prove happened.
async function until(fn,ms=20000){const deadline=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>deadline)return null;await new Promise(r=>setTimeout(r,50))}}
function waitExit(proc,ms=7000){if(proc.exitCode!==null||proc.signalCode)return Promise.resolve({code:proc.exitCode,signal:proc.signalCode});return new Promise((res)=>{const t=setTimeout(()=>res(null),ms);proc.once('close',(code,signal)=>{clearTimeout(t);res({code,signal})})})}

// The supervisor, spawned the way the installer's LaunchAgent spawns it: this checkout
// as its install root, a fixture as the server's own root. `passive` is for the test
// that starts it beside a running server, where waiting for the stopped page would
// wait for something that is never supposed to appear.
async function startSupervisor(root,port,{passive=false,...extra}={}){
  port=port||await freePort();
  const logDir=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-sup-log-'));
  // AI_CODE_SUPERVISOR_PLIST is pointed at a file that is not there, so the server the
  // supervisor starts reports no installed supervisor rather than reading the one this
  // machine happens to have. The child inherits this environment, which is what carries
  // the override across.
  const proc=spawn(process.execPath,['src/supervisor.mjs',process.cwd()],{cwd:process.cwd(),env:{...process.env,AI_CODE_ROOT:root,PORT:String(port),AI_CODE_SUPERVISOR_TICK_MS:'150',AI_CODE_LOG_DIR:logDir,AI_CODE_SUPERVISOR_PLIST:path.join(root,'supervisor.plist'),...extra},stdio:['ignore','pipe','pipe']});
  const base=`http://127.0.0.1:${port}`;
  let out='';let stderr='';let exited=null;
  proc.stdout.on('data',(c)=>{out+=c});proc.stderr.on('data',(c)=>{stderr+=c});
  proc.on('exit',(code)=>{if(!exited)exited={code}});
  const why=()=>`supervisor on :${port}\n${out}\n${stderr}`;
  const ready=await until(()=>{if(exited)throw new Error(`the supervisor exited (${exited.code}) before it bound\n${why()}`);return out.includes(`watching :${port}`)},15000);
  if(!ready){proc.kill('SIGKILL');throw new Error(`the supervisor never started\n${why()}`)}
  if(!passive){
    // Bound and serving, which is a later fact than "the process is up": the first
    // tick is what binds, and the page is what proves it did.
    const serving=await until(async()=>{const r=await tryGet(base+'/');return r?.headers[MARKER]==='1'?r:null},15000);
    if(!serving){proc.kill('SIGKILL');throw new Error(`the stopped page was never served\n${why()}`)}
  }
  return {proc,base,port,root,logDir,out:()=>out,stderr:()=>stderr,stop:async()=>{proc.kill('SIGTERM');await waitExit(proc)}};
}

test('the supervisor serves the stopped page, and marks every answer it makes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-sup-page-'));
  const s=await startSupervisor(root);
  try{
    const page=await tryGet(s.base+'/');
    assert.equal(page.status,200);
    assert.match(page.headers['content-type'],/text\/html/);
    // The marker is the whole mechanism. Without it a 404 from this process is
    // indistinguishable from a 404 from the dashboard, and the dashboard's own poll
    // would read "the server is up" off a page that says it is down.
    assert.equal(page.headers[MARKER],'1');
    assert.equal(page.headers['cache-control'],'no-store','a cached stopped page outlives the state it describes');
    assert.match(page.body,/Start server/);

    const overview=await tryGet(s.base+'/api/overview');
    assert.equal(overview.status,404);
    assert.equal(overview.headers[MARKER],'1');

    const status=JSON.parse((await tryGet(s.base+'/api/supervisor/status')).body);
    assert.equal(status.state,'holding');
    assert.equal(status.port,s.port);
    assert.equal(status.root,root,'the root the server will be given is the one this process was given');

    // The same narrowing the server puts on its own stop route: a page that reached
    // this over the network does not get to start a process on this machine.
    const remote=await tryGet(s.base+'/api/supervisor/start',{method:'POST',host:'workstation.tailnet-abc.ts.net'});
    assert.equal(remote.status,403);
    assert.equal(remote.headers[MARKER],'1');

    // And a refused start is not a started server: the port is still this process's.
    assert.equal((await tryGet(s.base+'/')).headers[MARKER],'1');
  }finally{await s.stop()}
});

test('a start hands the port to a real server, and a stop hands it back',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-sup-cycle-'));
  const s=await startSupervisor(root);
  try{
    const start=await tryGet(s.base+'/api/supervisor/start',{method:'POST'});
    // 202 because handing the port over is not the same as having a server on it: the
    // child has not been spawned when this is answered.
    assert.equal(start.status,202);
    assert.equal(JSON.parse(start.body).starting,true);

    // A 200 with no marker, on the same port: the handover happened.
    const up=await until(async()=>{const r=await tryGet(s.base+'/api/overview');return r?.status===200&&!r.headers[MARKER]?r:null});
    assert.ok(up,'the server never took the port it was started on');
    assert.ok(Array.isArray(JSON.parse(up.body).projects),'the dashboard answered, not the stopped page');

    const status=JSON.parse((await tryGet(s.base+'/api/server/status')).body);
    assert.equal(status.port,s.port,'the server bound the port the supervisor released');
    assert.equal(status.root,root,'the server was given the fixture as its root');

    // The call the dashboard's Stop button makes.
    assert.equal((await tryGet(s.base+'/api/server/shutdown',{method:'POST'})).status,202);

    // The stopped page comes back on its own. Nothing tells the supervisor the server
    // stopped - it is passive while a server runs, and takes the port back when the
    // port is free, which is the only signal there is.
    const back=await until(async()=>{const r=await tryGet(s.base+'/');return r?.status===200&&r.headers[MARKER]==='1'?r:null});
    assert.ok(back,'the supervisor did not take the port back after the server stopped');
  }finally{await s.stop()}
});

test('a supervisor beside a running server stays out of the way, then takes the port when it goes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicode-sup-passive-'));
  const port=await freePort();
  // The server this test does not own: started the way a person starts one, on a port
  // the supervisor is then pointed at.
  const server=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),env:{...process.env,AI_CODE_ROOT:root,PORT:String(port)},stdio:['ignore','ignore','pipe']});
  let stderr='';server.stderr.on('data',(c)=>{stderr+=c});
  const base=`http://127.0.0.1:${port}`;
  const served=await until(async()=>{const r=await tryGet(base+'/api/overview');return r?.status===200?r:null});
  assert.ok(served,`the server never answered on :${port}\n${stderr}`);
  const s=await startSupervisor(root,port,{passive:true});
  try{
    // Several ticks later: the supervisor probes the port every tick, and a probe that
    // decided to bind anyway would have taken it from a server that is still running.
    await new Promise((r)=>setTimeout(r,600));
    const still=await tryGet(base+'/api/overview');
    assert.equal(still.status,200);
    assert.equal(still.headers[MARKER],undefined,'the supervisor bound a port a live server was holding');
    // The supervisor answers nothing here - it is not listening - so its own status
    // route is a 404 from the dashboard, which is also how the CLI tells the two apart.
    assert.equal((await tryGet(base+'/api/supervisor/status')).status,404);

    // The server goes, and the port becomes the supervisor's - which is the state a
    // Start button needs, and the reason it keeps probing at all.
    server.kill('SIGTERM');
    assert.ok(await waitExit(server),'the server did not stop');
    const held=await until(async()=>{const r=await tryGet(base+'/');return r?.headers[MARKER]==='1'?r:null});
    assert.ok(held,'the supervisor never took the port after the server stopped');
    assert.equal(held.status,200);
  }finally{await s.stop()}
});
