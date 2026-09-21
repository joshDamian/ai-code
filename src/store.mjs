import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export class Store {
  constructor(root=process.cwd()) {
    this.root=root; this.dir=path.join(root,'.ai-code'); fs.mkdirSync(this.dir,{recursive:true});
    this.db=new DatabaseSync(path.join(this.dir,'ai-code.db'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,language TEXT,framework TEXT,commands TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL,plan TEXT,context TEXT,review TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,worktree TEXT,branch TEXT,base_commit TEXT);
      CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,enabled INTEGER NOT NULL,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,name TEXT NOT NULL,capabilities TEXT NOT NULL,speed REAL,cost REAL,quality REAL,context_length INTEGER,input_cost_per_mtok REAL,output_cost_per_mtok REAL,cache_read_cost_per_mtok REAL,cache_write_cost_per_mtok REAL,pricing_source TEXT,pricing_updated_at TEXT,billing_mode TEXT,enabled INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT,role TEXT,provider_id TEXT,model_id TEXT,status TEXT,started_at TEXT,ended_at TEXT,error TEXT,fallback_from TEXT,tokens INTEGER DEFAULT 0,cost REAL DEFAULT 0,duration_ms INTEGER DEFAULT 0,session_id TEXT,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,cache_read_tokens INTEGER DEFAULT 0,cache_write_tokens INTEGER DEFAULT 0,cost_basis TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,type TEXT,data TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY,name TEXT,trigger TEXT,action TEXT,enabled INTEGER,created_at TEXT);
    `);
    for(const [t,cols] of Object.entries({
      models:[['provider_model_id','TEXT'],['invocation_model_id','TEXT'],['display_name','TEXT'],['input_cost_per_mtok','REAL'],['output_cost_per_mtok','REAL'],['cache_read_cost_per_mtok','REAL'],['cache_write_cost_per_mtok','REAL'],['peak_input_cost_per_mtok','REAL'],['peak_output_cost_per_mtok','REAL'],['peak_cache_read_cost_per_mtok','REAL'],['peak_cache_write_cost_per_mtok','REAL'],['pricing_source','TEXT'],['pricing_updated_at','TEXT'],['billing_mode','TEXT'],['enabled','INTEGER DEFAULT 1']],
      runs:[['input_tokens','INTEGER DEFAULT 0'],['output_tokens','INTEGER DEFAULT 0'],['cache_read_tokens','INTEGER DEFAULT 0'],['cache_write_tokens','INTEGER DEFAULT 0'],['cost_basis','TEXT']]
    })) for(const [c,type] of cols)this.ensureColumn(t,c,type);
    if(!this.listProviders().length)this.seed(); this.migrateLegacyModels();
  }
  ensureColumn(table,column,type){try{this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)}catch{}}
  migrateLegacyModels(){
    const map={
      'claude-sonnet':['anthropic-claude-code','anthropic:claude-sonnet-5','claude-sonnet-5','claude-sonnet-5'],
      'claude-opus':['anthropic-claude-code','anthropic:claude-opus-5','claude-opus-5','claude-opus-5'],
      'deepseek-deepseek-flash[1m]':['deepseek-claude-code','deepseek:deepseek-flash','deepseek-flash','deepseek-flash'],
      'deepseek-deepseek-flash':['deepseek-claude-code','deepseek:deepseek-flash','deepseek-flash','deepseek-flash']
    };
    for(const [old,[provider,id,providerModel,invocation]] of Object.entries(map)){
      const m=this.db.prepare('SELECT * FROM models WHERE id=?').get(old);
      if(!m)continue;
      const exists=this.db.prepare('SELECT id FROM models WHERE id=?').get(id);
      if(exists){this.db.prepare('DELETE FROM models WHERE id=?').run(old);continue}
      this.db.prepare('UPDATE models SET id=?,provider_id=?,name=?,display_name=?,provider_model_id=?,invocation_model_id=? WHERE id=?').run(id,provider,providerModel,providerModel,providerModel,invocation,old);
    }
  }
  id(){return crypto.randomUUID()}
  seed(){this.addProvider({id:'mock',name:'Mock (tests only)',kind:'mock',enabled:true,config:{routable:false}});this.addModel({id:'mock-strong',providerId:'mock',name:'Mock Strong',capabilities:['planning','coding','review','repair'],speed:7,cost:0,quality:10,contextLength:100000,billingMode:'test',pricingSource:'AI Code test provider'});}
  addProject(p){this.db.prepare('INSERT OR REPLACE INTO projects VALUES(?,?,?,?,?,?,?)').run(p.id,p.name,p.path,p.createdAt,p.language,p.framework,JSON.stringify(p.commands||{}));return this.getProject(p.id)}
  getProject(id){const r=this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);return r&&this.mapProject(r)}
  getProjectByPath(p){const r=this.db.prepare('SELECT * FROM projects WHERE path=?').get(p);return r&&this.mapProject(r)}
  listProjects(){return this.db.prepare('SELECT * FROM projects ORDER BY name').all().map(r=>this.mapProject(r))}
  mapProject(r){return {...r,commands:JSON.parse(r.commands)}}
  addTask(t){this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(t.id,t.projectId,t.title,t.state,t.plan??null,t.context??null,t.review??null,t.createdAt,t.updatedAt,null,null,null);return this.getTask(t.id)}
  getTask(id){return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)}
  listTasks(pid){const q=pid?'SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC':'SELECT * FROM tasks ORDER BY updated_at DESC';return this.db.prepare(q).all(...(pid?[pid]:[]))}
  updateTask(id,p){const t=this.getTask(id);const n={...t,...p,updated_at:new Date().toISOString()};this.db.prepare('UPDATE tasks SET state=?,plan=?,context=?,review=?,updated_at=?,worktree=?,branch=?,base_commit=? WHERE id=?').run(n.state,n.plan??null,n.context??null,n.review??null,n.updated_at,n.worktree??null,n.branch??null,n.base_commit??null,id);return this.getTask(id)}
  addProvider(p){this.db.prepare('INSERT OR REPLACE INTO providers VALUES(?,?,?,?,?)').run(p.id,p.name,p.kind,p.enabled?1:0,JSON.stringify(p.config||{}));return this.getProvider(p.id)}
  getProvider(id){const r=this.db.prepare('SELECT * FROM providers WHERE id=?').get(id);return r&&{...r,enabled:!!r.enabled,config:JSON.parse(r.config)}}
  listProviders(){return this.db.prepare('SELECT * FROM providers ORDER BY name').all().map(r=>({...r,enabled:!!r.enabled,config:JSON.parse(r.config)}))}
  updateProvider(id,p){const x=this.getProvider(id);if(!x)throw Error('Provider not found');const n={...x,...p};this.db.prepare('UPDATE providers SET name=?,kind=?,enabled=?,config=? WHERE id=?').run(n.name,n.kind,n.enabled?1:0,JSON.stringify(n.config||{}),id);return this.getProvider(id)}
  addModel(m){const now=new Date().toISOString();this.db.prepare(`INSERT OR REPLACE INTO models(id,provider_id,name,capabilities,speed,cost,quality,context_length,provider_model_id,invocation_model_id,display_name,input_cost_per_mtok,output_cost_per_mtok,cache_read_cost_per_mtok,cache_write_cost_per_mtok,peak_input_cost_per_mtok,peak_output_cost_per_mtok,peak_cache_read_cost_per_mtok,peak_cache_write_cost_per_mtok,pricing_source,pricing_updated_at,billing_mode,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(m.id,m.providerId,m.name,JSON.stringify(m.capabilities),m.speed??5,m.cost??0,m.quality??5,m.contextLength??null,m.providerModelId??m.provider_model_id??m.name,m.invocationModelId??m.invocation_model_id??m.name,m.displayName??m.display_name??m.name,m.inputCostPerMTok??null,m.outputCostPerMTok??null,m.cacheReadCostPerMTok??null,m.cacheWriteCostPerMTok??null,m.peakInputCostPerMTok??null,m.peakOutputCostPerMTok??null,m.peakCacheReadCostPerMTok??null,m.peakCacheWriteCostPerMTok??null,m.pricingSource??null,m.pricingUpdatedAt??now,m.billingMode??'unknown',m.enabled===false?0:1)}
  updateModel(id,p){const m=this.getModel(id);if(!m)throw Error('Model not found');const n={...m,...p};this.addModel({...n,id,providerId:m.provider_id,providerId:m.provider_id,capabilities:n.capabilities||m.capabilities}) ;return this.getModel(id)}
  getModel(id){const r=this.db.prepare('SELECT * FROM models WHERE id=?').get(id);return r&&this.mapModel(r)}
  listModels(pid){const q=pid?'SELECT * FROM models WHERE provider_id=? ORDER BY name':'SELECT * FROM models ORDER BY provider_id,name';return this.db.prepare(q).all(...(pid?[pid]:[])).map(r=>this.mapModel(r))}
  mapModel(r){return {...r,enabled:!!r.enabled,capabilities:JSON.parse(r.capabilities),providerModelId:r.provider_model_id||r.name,invocationModelId:r.invocation_model_id||r.name,displayName:r.display_name||r.name,inputCostPerMTok:r.input_cost_per_mtok,outputCostPerMTok:r.output_cost_per_mtok,cacheReadCostPerMTok:r.cache_read_cost_per_mtok,cacheWriteCostPerMTok:r.cache_write_cost_per_mtok,peakInputCostPerMTok:r.peak_input_cost_per_mtok,peakOutputCostPerMTok:r.peak_output_cost_per_mtok,peakCacheReadCostPerMTok:r.peak_cache_read_cost_per_mtok,peakCacheWriteCostPerMTok:r.peak_cache_write_cost_per_mtok,pricingSource:r.pricing_source,pricingUpdatedAt:r.pricing_updated_at,billingMode:r.billing_mode}}
  addRun(r){this.db.prepare('INSERT INTO runs(id,task_id,role,provider_id,model_id,status,started_at,ended_at,error,fallback_from,tokens,cost,duration_ms,session_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_basis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.taskId??null,r.role,r.providerId,r.modelId,r.status,r.startedAt,null,null,r.fallbackFrom??null,0,0,0,null,0,0,0,0,null);return r}
  updateRun(id,p){const r=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);const n={...r,...p};this.db.prepare('UPDATE runs SET status=?,ended_at=?,error=?,fallback_from=?,tokens=?,cost=?,duration_ms=?,session_id=?,input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost_basis=? WHERE id=?').run(n.status,n.ended_at??null,n.error??null,n.fallback_from??null,n.tokens??0,n.cost??0,n.duration_ms??0,n.session_id??null,n.input_tokens??0,n.output_tokens??0,n.cache_read_tokens??0,n.cache_write_tokens??0,n.cost_basis??null,id);return n}
  listRuns(tid){const q=tid?'SELECT * FROM runs WHERE task_id=? ORDER BY started_at':'SELECT * FROM runs ORDER BY started_at DESC';return this.db.prepare(q).all(...(tid?[tid]:[]))}
  addEvent(e){this.db.prepare('INSERT INTO events(run_id,type,data,created_at) VALUES(?,?,?,?)').run(e.runId,e.type,JSON.stringify(e.data??null),new Date().toISOString())}
  listEvents(id,afterId=0){return this.db.prepare('SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id').all(id,afterId).map(x=>({...x,data:JSON.parse(x.data)}))}
  listTaskEvents(taskId,afterId=0){return this.db.prepare(`SELECT e.* FROM events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=? AND e.id>? ORDER BY e.id`).all(taskId,afterId).map(x=>({...x,data:JSON.parse(x.data)}))}
  addAutomation(a){this.db.prepare('INSERT OR REPLACE INTO automations VALUES(?,?,?,?,?,?)').run(a.id,a.name,a.trigger,a.action,a.enabled?1:0,a.createdAt);return a}
  updateAutomation(id,p){const a=this.db.prepare('SELECT * FROM automations WHERE id=?').get(id);if(!a)throw Error('Automation not found');const n={...a,...p};this.db.prepare('UPDATE automations SET name=?,trigger=?,action=?,enabled=? WHERE id=?').run(n.name,n.trigger,n.enabled?1:0,id);return n}
  listAutomations(){return this.db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all().map(x=>({...x,enabled:!!x.enabled}))}
}
