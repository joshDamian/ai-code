#!/usr/bin/env node
import {Service} from './service.mjs';
const a=process.argv.slice(2);const s=new Service(process.cwd());const out=x=>console.log(typeof x==='string'?x:JSON.stringify(x,null,2));
async function main(){const [cmd,sub,...rest]=a;if(!cmd||cmd==='help'||cmd==='--help')return out(`AI Code\n\nProject\n  init [name] [path]\n  projects\nContext\n  context init <project-id>\nTask\n  task create <project-id> <title>\n  task list\n  task show <id>\n  task plan <id>\n  task approve <id>\n  task execute <id>\n  task review <id>\n  task repair <id>\nProviders\n  provider list\n  provider add-claude\n  provider add-deepseek [model]\n  provider test <provider-id> [model-id]\n  provider enable <provider-id>\n  provider disable <provider-id>\nModels\n  model list [provider-id]\n  model enable <model-id>\n  model disable <model-id>\nRouting\n  routing show\n  routing set <json-file>\nRuns\n  runs\nAutomation\n  automation list\n  automation add <name> <trigger> <action>\n  doctor\n  dashboard`);
if(cmd==='init'){const p=s.initProject(sub||'project',rest[0]||process.cwd());s.contextInit(p.id);return out(p)}if(cmd==='projects')return out(s.store.listProjects());if(cmd==='context'&&sub==='init')return out(s.contextInit(rest[0]));if(cmd==='task'){if(sub==='create'){const t=s.createTask(rest[0],rest.slice(1).join(' '));return out(s.prepare(t.id))}if(sub==='list')return out(s.store.listTasks());if(sub==='show')return out({task:s.task(rest[0]),runs:s.store.listRuns(rest[0])});if(['plan','approve','execute','review','repair'].includes(sub)){const id=rest[0];const r=sub==='plan'?await s.plan(id):sub==='approve'?s.approve(id):sub==='execute'?await s.execute(id):sub==='review'?await s.review(id):await s.repair(id);return out(r)}}
if(cmd==='provider'){
if(sub==='list')return out({providers:s.store.listProviders(),models:s.store.listModels()});
if(sub==='add-claude'){
s.addProvider({id:'anthropic-claude-code',name:'Anthropic / Claude Code',kind:'claude-code',enabled:true,config:{routable:true,billingMode:'subscription'}});
const models=[
{id:'anthropic:claude-opus-5',name:'claude-opus-5',displayName:'Claude Opus 5',providerModelId:'claude-opus-5',invocationModelId:'claude-opus-5',capabilities:['planning','coding','review','repair'],speed:7,quality:10,contextLength:200000,inputCostPerMTok:5,outputCostPerMTok:25,billingMode:'subscription',pricingSource:'Anthropic official pricing',pricingUpdatedAt:'2026-08-24'},
{id:'anthropic:claude-opus-4-8',name:'claude-opus-4-8',displayName:'Claude Opus 4.8',providerModelId:'claude-opus-4-8',invocationModelId:'claude-opus-4-8',capabilities:['planning','coding','review','repair'],speed:6,quality:10,contextLength:200000,inputCostPerMTok:5,outputCostPerMTok:25,billingMode:'subscription',pricingSource:'Anthropic official pricing',pricingUpdatedAt:'2026-08-24'},
{id:'anthropic:claude-sonnet-5',name:'claude-sonnet-5',displayName:'Claude Sonnet 5',providerModelId:'claude-sonnet-5',invocationModelId:'claude-sonnet-5',capabilities:['planning','coding','review','repair'],speed:9,quality:9,contextLength:1000000,inputCostPerMTok:2,outputCostPerMTok:10,billingMode:'subscription',pricingSource:'Anthropic official pricing',pricingUpdatedAt:'2026-08-10'},
{id:'anthropic:claude-sonnet-4-6',name:'claude-sonnet-4-6',displayName:'Claude Sonnet 4.6',providerModelId:'claude-sonnet-4-6',invocationModelId:'claude-sonnet-4-6',capabilities:['planning','coding','review','repair'],speed:8,quality:9,contextLength:200000,inputCostPerMTok:3,outputCostPerMTok:15,billingMode:'subscription',pricingSource:'Anthropic official pricing',pricingUpdatedAt:'2026-05-12'},
{id:'anthropic:claude-haiku-4-5-20251001',name:'claude-haiku-4-5-20251001',displayName:'Claude Haiku 4.5',providerModelId:'claude-haiku-4-5-20251001',invocationModelId:'claude-haiku-4-5-20251001',capabilities:['planning','coding','review','repair'],speed:10,quality:7,contextLength:200000,inputCostPerMTok:.8,outputCostPerMTok:4,billingMode:'subscription',pricingSource:'Anthropic official pricing',pricingUpdatedAt:'2026-05-12'}
];
for(const m of models)s.addModel({...m,providerId:'anthropic-claude-code'});
return out(s.store.getProvider('anthropic-claude-code'));
}
if(sub==='add-deepseek'){
s.addProvider({id:'deepseek-claude-code',name:'DeepSeek via Claude Code',kind:'deepseek',enabled:true,config:{apiKeyEnv:'DEEPSEEK_API_KEY',effort:'max',routable:true,billingMode:'api'}});
const models=[
{id:'deepseek:deepseek-flash',name:'deepseek-flash',displayName:'DeepSeek V4.1 Flash',providerModelId:'deepseek-flash',invocationModelId:'deepseek-flash',capabilities:['planning','coding','review','repair'],speed:10,quality:8,contextLength:1000000,inputCostPerMTok:.15,outputCostPerMTok:.6,cacheReadCostPerMTok:.003,peakInputCostPerMTok:.3,peakOutputCostPerMTok:1.2,peakCacheReadCostPerMTok:.006,billingMode:'api',pricingSource:'DeepSeek official pricing',pricingUpdatedAt:'2026-09-21'},
{id:'deepseek:deepseek-v4-pro',name:'deepseek-v4-pro',displayName:'DeepSeek V4 Pro',providerModelId:'deepseek-v4-pro',invocationModelId:'deepseek-v4-pro',capabilities:['planning','coding','review','repair'],speed:7,quality:10,contextLength:1000000,inputCostPerMTok:.66,outputCostPerMTok:1.98,cacheReadCostPerMTok:.022,peakInputCostPerMTok:1.32,peakOutputCostPerMTok:3.96,peakCacheReadCostPerMTok:.044,billingMode:'api',pricingSource:'DeepSeek official pricing',pricingUpdatedAt:'2026-09-21'}
];
for(const m of models)s.addModel({...m,providerId:'deepseek-claude-code'});
return out(s.store.getProvider('deepseek-claude-code'));
}
if(sub==='test')return out(await s.testProvider(rest[0],rest[1]));
if(sub==='enable'||sub==='disable')return out(s.updateProvider(rest[0],{enabled:sub==='enable'}))
}
if(cmd==='model'){if(sub==='list')return out(s.store.listModels(rest[0]));if(sub==='enable'||sub==='disable')return out(s.updateModel(rest[0],{enabled:sub==='enable'}))}
if(cmd==='routing'&&sub==='show')return out(s.getRouting());if(cmd==='routing'&&sub==='set'){const fs=await import('node:fs');return out(s.saveRouting(JSON.parse(fs.readFileSync(rest[0],'utf8'))))}if(cmd==='runs')return out(s.store.listRuns());if(cmd==='automation'&&sub==='list')return out(s.store.listAutomations());if(cmd==='automation'&&sub==='add')return out(s.store.addAutomation({id:s.store.id(),name:rest[0],trigger:rest[1],action:rest.slice(2).join(' '),enabled:true,createdAt:new Date().toISOString()}));if(cmd==='doctor')return out(await s.doctor());if(cmd==='dashboard'){await import('./server.mjs');return}throw Error(`Unknown command: ${cmd} ${sub||''}`)}
main().catch(e=>{console.error(`AI Code: ${e.message}`);process.exitCode=1});
