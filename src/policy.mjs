import fs from 'node:fs';import path from 'node:path';
const defaults={
  planner:{strategy:'quality',preferred:[],fallback:[],quality:1,cost:0.2,speed:0.1,effort:'high'},
  implementer:{strategy:'balanced',preferred:[],fallback:[],quality:0.5,cost:0.2,speed:1,effort:'medium'},
  reviewer:{strategy:'quality',preferred:[],fallback:[],quality:1,cost:0.1,speed:0.3,effort:'high'},
  repair:{strategy:'speed',preferred:[],fallback:[],quality:0.2,cost:0.4,speed:1,effort:'medium'}
};
function normalize(p){
  const map={'anthropic-claude-code:claude-opus':'anthropic:claude-opus-5','anthropic-claude-code:claude-sonnet':'anthropic:claude-sonnet-5','deepseek-claude-code:deepseek-deepseek-flash[1m]':'deepseek:deepseek-flash','deepseek-claude-code:deepseek-deepseek-flash':'deepseek:deepseek-flash'};
  const out={...p};
  for(const role of Object.keys(out)){for(const key of ['preferred','fallback'])out[role]={...out[role],[key]:(out[role]?.[key]||[]).map(x=>map[x]||x)}}
  return out;
}
export function loadPolicies(root){const f=path.join(root,'.ai-code','routing.json');if(!fs.existsSync(f)){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(defaults,null,2));return structuredClone(defaults)}try{return normalize({...defaults,...JSON.parse(fs.readFileSync(f,'utf8'))})}catch{return structuredClone(defaults)}}
export function savePolicies(root,p){const merged=normalize({...defaults,...p});const f=path.join(root,'.ai-code','routing.json');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(merged,null,2));return merged}
export {defaults};
