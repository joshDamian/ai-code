import {execFileSync} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';
// 10 MiB, matching the buffer the test command already sets. Node's 1 MiB default
// was reachable in theory before this and is reachable in practice now that a diff
// is something a person asks for by name rather than a string a reviewer skims.
export function git(cwd,args){return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:10*1024*1024}).trim()}
export function ensureGit(root){return git(root,['rev-parse','--show-toplevel'])}
// The other half of ensureGit: a folder that is not a repository yet becomes one.
// `-q` because git's own "Initialized empty Git repository" line is written to
// stdout, and every helper here returns its caller's stdout.
export function gitInit(root){return git(root,['init','-q'])}
// Whether this repository has a commit. `head` throws in one that does not, which is
// the difference between a repository a worktree can be cut from and a bare init.
export function hasCommits(root){try{return !!head(root)}catch{return false}}
export function status(root){return git(root,['status','--porcelain']).split('\n').filter(x=>x && !x.trimEnd().endsWith('.ai-code')).join('\n')}
export function protectAiCode(root){const f=path.join(root,'.git','info','exclude');fs.mkdirSync(path.dirname(f),{recursive:true});let s=fs.existsSync(f)?fs.readFileSync(f,'utf8'):'';if(!s.split('\n').some(x=>x.trim()==='.ai-code/'))fs.appendFileSync(f,(s.endsWith('\n')||!s?'':'\n')+'.ai-code/\n')}
export function head(root){return git(root,['rev-parse','HEAD'])}
// Where every worktree cut from this repository lives, a task's and a plan's alike.
export function worktreeRoot(root){return process.env.AI_CODE_WORKTREE_ROOT||path.join(path.dirname(root),`.ai-code-worktrees-${path.basename(root)}`)}
// `at` pins the commit the branch is cut from: the attempts of one comparison all
// start from the same one, whatever lands on the main branch while they are created.
export function createWorktree(root,id,at=null){ensureGit(root);const base=at||head(root);const dir=path.join(worktreeRoot(root),id);const branch=`ai-code/${id}`;fs.mkdirSync(path.dirname(dir),{recursive:true});if(!fs.existsSync(dir))git(root,['worktree','add','-b',branch,dir,base]);linkDeps(root,dir);return {dir,branch,base}}
// The planner's disposable copy of the repository. It sits beside the task's own
// worktree under a `plan-` name, detached rather than on a branch: nothing made in
// it is ever kept, so a branch would be one more ref to clean up for no reader.
//
// It has to show the planner what the planner used to see, which is the live tree
// with its uncommitted work - the plan-base gate and the read set both assume that.
// So HEAD is checked out and the checkout's dirty and untracked files are copied
// over it. A path that is dirty because it was deleted is deleted here too. A
// collapsed `?? dir/` entry is skipped, because the untracked enumeration names
// every file inside it.
//
// Reused rather than recreated when it already exists: a refine plans again in the
// copy the first plan left, scratch files included. The forced checkout is what
// brings its tracked files back to today's HEAD, so a refine still plans against
// the tree as it is now.
export const PLAN_WORKTREE_PREFIX='plan-';
export function planWorktreeDir(root,id){return path.join(worktreeRoot(root),`${PLAN_WORKTREE_PREFIX}${id}`)}
export function createPlanWorktree(root,id){
  ensureGit(root);
  const base=head(root);
  const dir=planWorktreeDir(root,id);
  fs.mkdirSync(path.dirname(dir),{recursive:true});
  if(fs.existsSync(dir))git(dir,['checkout','--force','--quiet','--detach',base]);
  else git(root,['worktree','add','--quiet','--detach',dir,base]);
  for(const p of dirtyAndUntracked(root)){
    const from=path.join(root,p);const to=path.join(dir,p);
    let st=null;try{st=fs.lstatSync(from)}catch{}
    if(!st){fs.rmSync(to,{recursive:true,force:true});continue}
    if(st.isDirectory())continue;
    fs.mkdirSync(path.dirname(to),{recursive:true});
    fs.rmSync(to,{force:true});
    fs.cpSync(from,to,{verbatimSymlinks:true});
  }
  linkDeps(root,dir);
  return {dir,base};
}
// Safe to call for a task that never had one. A directory git no longer tracks is
// removed by hand and the registration pruned, so a half-deleted copy cannot make
// the next `worktree add` for the same task fail.
export function removePlanWorktree(root,id){
  const dir=planWorktreeDir(root,id);
  if(!fs.existsSync(dir))return false;
  try{git(root,['worktree','remove','--force',dir])}
  catch{fs.rmSync(dir,{recursive:true,force:true});try{git(root,['worktree','prune'])}catch{}}
  return true;
}
// The task ids that have a planning copy on disk, for the startup sweep.
export function planWorktreeIds(root){
  try{return fs.readdirSync(worktreeRoot(root)).filter((n)=>n.startsWith(PLAN_WORKTREE_PREFIX)).map((n)=>n.slice(PLAN_WORKTREE_PREFIX.length))}catch{return []}
}
// A worktree shares the repo's package.json but not its node_modules (gitignored).
// Without this, every test step and every implementer that imports a dependency
// fails on ERR_MODULE_NOT_FOUND. A symlink is instant and always in sync.
//
// The link must also be invisible to git. A project's `node_modules/` ignore rule
// matches directories only, and a symlink is not one, so the link showed up as an
// untracked file and port committed it: a dangling absolute path in kron, novara and
// ai-code branches, and in novara's history. `/node_modules` in the repository's own
// exclude file matches the link too, and that file is never part of a diff. It is
// written before the link, so no moment exists in which the link is unignored.
function linkDeps(root,dir){const nm=path.join(root,'node_modules');const target=path.join(dir,'node_modules');if(fs.existsSync(nm)&&!fs.existsSync(target)){excludeLine(root,'/node_modules');try{fs.symlinkSync(nm,target,'junction')}catch{/* race or permission — the install step will catch it */}}}
// Appends one pattern to the repository's .git/info/exclude unless it is there. The
// exclude file lives in the common git directory, so every worktree reads it.
export function excludeLine(root,line){const f=path.join(root,'.git','info','exclude');try{fs.mkdirSync(path.dirname(f),{recursive:true});const s=fs.existsSync(f)?fs.readFileSync(f,'utf8'):'';if(s.split('\n').some((x)=>x.trim()===line))return;fs.appendFileSync(f,(s.endsWith('\n')||!s?'':'\n')+line+'\n')}catch{/* a .git file (a worktree root) has no info dir to write; nothing to protect here */}}
// Against a ref, not against the index. `git diff` alone compares the worktree to
// the index, so staging or committing the work makes it empty - which hands the
// reviewer a blank page, and a blank page is a PASS. Against a ref it reads the
// same before and after a materialize, and survives the worktree being removed.
export function diffAgainst(dir,ref){return git(dir,['diff','--no-color',ref])}
// What a range of commits carries, for the work a branch holds in several commits
// rather than in the one a port wrote. Read from the repository rather than from a
// worktree, because the branch outlives the directory it was cut into.
export function diffBetween(root,from,to){return git(root,['diff','--no-color',from,to])}
// The same diff, narrowed to named paths. What one agent's turn changed, told apart
// from the work its predecessors left in the same worktree: a repair is verified
// against its own part of the tree, and handing it the whole diff again is what made
// the review that followed a repair a second review of everything. An untracked path
// carries no diff at all, which is why the caller keeps the status lines - they are
// the only thing that names a file the turn created.
export function diffPaths(dir,ref,paths){return paths.length?git(dir,['diff','--no-color',ref,'--',...paths]):''}
// The content of every path the worktree has changed, keyed by path. The dirty set
// alone cannot say whether anything moved between two moments: the files a repair is
// sent to fix are dirty before it starts, so a name list that reads the same
// afterwards is exactly the state a repair that did nothing leaves behind. Hashes
// rather than mtimes, because an editor rewrite that changes nothing is not a change.
//
// One `hash-object` for the whole set rather than one per file: a repair is bracketed
// by two of these, and a worktree with a hundred dirty paths would otherwise pay two
// hundred process spawns for a fact a single call answers.
// NULL when git will not hash the set at all - a submodule path, a file removed
// underneath the call - because one unhashable path fails the batch for every path
// in it. The caller reads null as "not measured" and falls back to what it did
// before there was a delta, rather than failing a repair that has already run.
export function worktreeHashes(dir){
const paths=dirtyPaths(dir);
if(!paths.length)return{};
try{const shas=git(dir,['hash-object','--',...paths]).split('\n');
return Object.fromEntries(paths.map((p,i)=>[p,shas[i]]))}catch{return null}}
// The difference between two of those, either way: a path the agent edited or
// created, and one it reverted to HEAD. Both are it having done something, and both
// belong in the delta a review of that turn reads.
export function changedPaths(before,after){return[...new Set([...Object.keys(before),...Object.keys(after)])].filter((p)=>before[p]!==after[p]).sort()}
// The porcelain tail that used to be appended to the diff. Kept separate because
// it is not a diff: it is the only thing that names an untracked file at all,
// since no diff carries one's contents.
// Not through git(), which trims: an unstaged modification is reported as
// ` M path`, and the leading space is the entire difference between "you edited
// this" and "you staged this". Trimming it rewrites the first entry's meaning.
export function statusPaths(dir){const s=execFileSync('git',['status','--short'],{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']});return s.trim()?s.trimEnd().split('\n'):[]}
export function changedFiles(dir){const s=git(dir,['status','--porcelain']);return s?s.split('\n').filter(Boolean):[]}
// Files git does not track but does not ignore either: what a commit of the
// worktree would add. Bare paths, so it does not go through the porcelain line
// form, which quotes a name containing a space.
export function untracked(dir){const s=git(dir,['ls-files','--others','--exclude-standard']);return s?s.split('\n').filter(Boolean):[]}
// Bare paths, one per dirty entry, for comparing one snapshot of the tree with
// another. changedFiles above returns porcelain lines, which cannot be compared
// as a set. The -z form cannot go through git() either: an unstaged modification
// begins with a space, and git() trims. A rename or copy carries its source as
// the next NUL-terminated entry with no status prefix at all, so pair-skipping
// keeps the destination - the path that exists now.
export function dirtyPaths(root){const s=execFileSync('git',['status','--porcelain','-z'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});const parts=s.split('\0').filter(Boolean);const out=[];for(let i=0;i<parts.length;i++){const line=parts[i];const p=line.slice(3);
// -z lists a rename as destination then source, both NUL-terminated, with the
// status prefix only on the destination - and in the opposite order to the line
// form, which reads `old -> new`. So the path is read before the source is
// skipped; skipping first and reading after keeps the path that no longer exists.
if(/^[RC]/.test(line))i++;
if(p&&!p.includes('.ai-code'))out.push(p)}return out}
// The dirty set widened with the per-file untracked enumeration. porcelain
// collapses an entirely-untracked directory to one `?? dir/` entry, so a
// before/after comparison built on it alone reads the same string before and
// after a write into one. The ls-files enumeration lists one path per file,
// which is what makes a new file inside an already-dirty directory visible.
// The `.ai-code` filter matches dirtyPaths' own, and --exclude-standard is
// what keeps ignored directories (node_modules) out of the widened half.
export function dirtyAndUntracked(root) {
  return [...new Set([...dirtyPaths(root), ...untracked(root).filter((p) => !p.includes('.ai-code'))])];
}
// The paths that differ between two commits. What tells a file whose uncommitted
// content was committed from one whose uncommitted content is still missing.
export function changedBetween(root,from,to){if(from===to)return[];const s=git(root,['diff','--name-only',from,to]);return s?s.split('\n').filter(Boolean):[]}
// The change one commit carries, against its parent. What a port left behind when the
// worktree that made it is gone: the directory is removed once the work is on the
// branch, and reading the change off the commit is what keeps a screen showing the work
// rather than an empty pane that reads as the work being lost. A commit with no parent
// has nothing to compare against and reports empty rather than failing.
export function commitDiff(root,commit){try{return git(root,['diff','--no-color',`${commit}^`,commit])}catch{return ''}}
// The checked-out branch, or null when HEAD is detached. symbolic-ref fails there,
// where --abbrev-ref would return the literal string "HEAD" and hand the caller a
// target branch by that name.
export function currentBranch(root){try{return git(root,['symbolic-ref','--short','HEAD'])}catch{return null}}
// A ref that resolves, or null. The existence test: a plan base can stop resolving
// (rebase, gc, a deleted branch) and every caller of this is a read-only report
// that must degrade rather than throw.
export function revParse(root,ref){try{return git(root,['rev-parse','--verify','--quiet',`${ref}^{commit}`])}catch{return null}}
// Whether `a` can reach `b`. This is the fast-forward test, and it is not the same
// question as `base_commit === targetTip`: a worktree reused after a replan sits
// on an older commit than the base_commit that was rewritten underneath it, and
// moving a branch on the equality answer rewinds the target.
//
// merge-base --is-ancestor answers with its exit code, so unlike every other
// helper here a false answer arrives as an exception rather than an empty string.
export function isAncestor(root,a,b){try{execFileSync('git',['merge-base','--is-ancestor',a,b],{cwd:root,stdio:['ignore','pipe','pipe']});return true}catch{return false}}
// Where two branches diverged. Computed rather than taken from base_commit, so it
// stays true for a task whose worktree predates a replan.
export function mergeBase(root,a,b){try{return git(root,['merge-base',a,b])}catch{return null}}
// The commit on `ref` whose message carries `marker`, or null. A commit AI Code made
// for a task says which task in its message, and that is the only record that
// survives the work being merged: once the work is in the target, the branch tip and
// the fork point are the same commit, so neither one says whether this task ever
// published anything. Fixed strings because a task id is data, not a pattern.
export function findCommit(root,ref,marker){try{return git(root,['rev-list','-1','--fixed-strings','--grep',marker,ref])||null}catch{return null}}
export function branches(root){const s=git(root,['for-each-ref','--format=%(refname:short)','refs/heads']);return s?s.split('\n').filter(Boolean):[]}
// Branches checked out in any worktree, this repository's or another's. git branch
// -f refuses to move one of these, so a port that means to land on the target has
// to know before it tries.
export function checkedOut(root){return git(root,['worktree','list','--porcelain']).split('\n').filter((l)=>l.startsWith('branch refs/heads/')).map((l)=>l.slice('branch refs/heads/'.length))}
// The merge performed in the object store: no worktree, no index, nothing left on
// disk to clean up and nothing to collide with on a retry. A conflict is the
// non-zero exit rather than a failure, and its stdout is the answer - a tree line
// then one entry per conflicted path, mode, oid, stage, tab, path, where stage 2
// is ours and 3 is theirs. Deduped because a content conflict lists all three.
export function mergeTree(root,a,b){
try{return{clean:true,tree:git(root,['merge-tree','--write-tree',a,b]).split('\n')[0],conflicts:[]}}
catch(e){const out=String(e.stdout||'');const lines=out.split('\n');const conflicts=[...new Set(lines.slice(1).map((l)=>{const m=l.match(/^\d{6} [0-9a-f]+ \d\t(.+)$/);return m?m[1]:null}).filter(Boolean))];return{clean:false,tree:lines[0]||null,conflicts}}}
// A commit for a merge that was never checked out anywhere. Without this the only
// way to turn a merge-tree result into something a branch can point at is to
// materialize it in a worktree - which is the directory and cleanup this avoids.
export function commitTree(root,tree,parents,msg){return git(root,['commit-tree',tree,...parents.flatMap((p)=>['-p',p]),'-m',msg])}
export function setBranch(root,name,ref){return git(root,['branch','-f',name,ref])}
// Publishes the worktree - untracked files included, which no diff carries. Only
// called once the caller has established there is something to commit: `git
// commit` with an empty index exits non-zero, and git() does not catch.
export function commitAll(dir,msg){git(dir,['add','-A']);git(dir,['commit','-m',msg]);return head(dir)}
// The first commit of a folder `git init` has just made, and the one commit the rest
// of the workflow cannot do without: `createWorktree` cuts from HEAD, and a repository
// with no commits has no HEAD to cut from.
//
// The identity is supplied only when git has none of its own - `git config user.email`
// reads local, then global, then system, and exits non-zero when none of them sets one.
// A person's own name is what a commit of their work should carry, so this is not a
// default: it is what lets a machine with no git config at all still get a repository
// rather than a dead end at the first task.
export function commitInitial(dir,msg){
git(dir,['add','-A']);
const named=hasIdentity(dir);
git(dir,[...(named?[]:['-c','user.email=ai-code@localhost','-c','user.name=AI Code']),'commit','-m',msg]);
return head(dir)}
function hasIdentity(dir){try{return !!git(dir,['config','user.email'])}catch{return false}}
export function removeWorktree(root,dir){return git(root,['worktree','remove','--force',dir])}
// The commit that first put a task's work into the destination. A fast-forward makes
// that the task's own commit, because nothing separate was written to carry it; a merge
// makes it the merge commit, which is the one a `git log` of the destination shows and
// the one a revert or a bisect would point at. So the merge is looked for first and the
// task's commit is the answer when there is none - naming the newest commit on the path
// instead would name whatever landed after it.
export function landingCommit(root,taskTip,targetTip){
if(!taskTip||!targetTip)return null;
try{
const merges=git(root,['rev-list','--merges','--ancestry-path',`${taskTip}..${targetTip}`]).split('\n').filter(Boolean);
return merges.length?merges[merges.length-1]:taskTip}catch{return null}}
// A commit as a surface has to name it: the short hash a person types, the full one a
// tool takes, and the subject line that makes it recognisable. One place, so every
// surface names the same commit the same way.
export function commitRef(root,ref){
if(!ref)return null;
try{const [sha,...rest]=git(root,['log','-1','--format=%H%n%s',ref]).trim().split('\n');return {sha,short:sha.slice(0,7),subject:rest.join(' ')||''}}catch{return null}}
