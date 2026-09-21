import {execFileSync} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';
export function git(cwd,args){return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
export function ensureGit(root){return git(root,['rev-parse','--show-toplevel'])}
export function status(root){return git(root,['status','--porcelain']).split('\n').filter(x=>x && !x.trimEnd().endsWith('.ai-code')).join('\n')}
export function protectAiCode(root){const f=path.join(root,'.git','info','exclude');fs.mkdirSync(path.dirname(f),{recursive:true});let s=fs.existsSync(f)?fs.readFileSync(f,'utf8'):'';if(!s.split('\n').some(x=>x.trim()==='.ai-code/'))fs.appendFileSync(f,(s.endsWith('\n')||!s?'':'\n')+'.ai-code/\n')} 
export function head(root){return git(root,['rev-parse','HEAD'])}
export function createWorktree(root,id){ensureGit(root);const base=head(root);const baseRoot=process.env.AI_CODE_WORKTREE_ROOT||path.join(path.dirname(root),`.ai-code-worktrees-${path.basename(root)}`);const dir=path.join(baseRoot,id);const branch=`ai-code/${id}`;fs.mkdirSync(path.dirname(dir),{recursive:true});if(!fs.existsSync(dir))git(root,['worktree','add','-b',branch,dir,base]);return {dir,branch,base}}
export function diff(dir){return git(dir,['diff','--binary'])+'\n'+git(dir,['status','--short'])}
export function changedFiles(dir){const s=git(dir,['status','--porcelain']);return s?s.split('\n').filter(Boolean):[]}
