// The wire contract: every shape that crosses between the server and a client.
// Server modules and web modules both reference this file from JSDoc, and
// `npm run typecheck` checks the files that opt in with `// @ts-check`.

import type { SDKMessage, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export type { SDKMessage, PermissionMode };

export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: string;
  /** The check a new task in this project starts with. */
  check_command: string | null;
}

export interface Provider {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  config: { apiKeyEnv?: string; billingMode?: string; autoCompactWindow?: number; [k: string]: unknown };
}

export interface Model {
  id: string;
  provider_id: string;
  name: string;
  display_name: string | null;
  provider_model_id: string | null;
  invocation_model_id: string | null;
  enabled: boolean;
  context_length: number | null;
  input_cost_per_mtok: number | null;
  output_cost_per_mtok: number | null;
  cache_read_cost_per_mtok: number | null;
  cache_write_cost_per_mtok: number | null;
  billing_mode: string | null;
}

/** A unit of work: a branch in its own worktree, cut from a base branch, landed by a person. */
export type TaskState = 'active' | 'merged' | 'closed';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  base_branch: string;
  base_commit: string;
  branch: string;
  worktree: string;
  state: TaskState;
  merge_commit: string | null;
  merged_at: string | null;
  /** What done means for this task, in the person's words. */
  done: string | null;
  /** The shell command Bench runs in the worktree to check the work. */
  check_command: string | null;
  /** The last run's result: 'running', 'passed' or 'failed'. Null before the first. */
  check_status: CheckStatus | null;
  /** The working tree the last run checked, from git write-tree. */
  check_tree: string | null;
  /** The end of the last run's output. */
  check_output: string | null;
  check_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CheckStatus = 'running' | 'passed' | 'failed';

/** idle: waiting on the person. running: a turn is in flight. waiting: blocked on an approval. */
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface Session {
  id: string;
  project_id: string;
  /** Null for a session in the project's own checkout. */
  task_id: string | null;
  title: string;
  cwd: string;
  provider_id: string;
  model_id: string | null;
  permission_mode: PermissionMode;
  effort: string | null;
  /** Claude Code's own session id, which `resume` takes. Null before the first turn. */
  claude_session_id: string | null;
  status: SessionStatus;
  error: string | null;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** A persisted transcript entry. `kind` is the SDK message type, or `user` for what the person sent. */
export interface SessionEvent {
  id: number;
  session_id: string;
  kind: string;
  data: any;
  created_at: string;
}

/** A tool call waiting on a person: a permission prompt, a question, or a plan to approve. */
export interface Approval {
  id: string;
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  title: string | null;
  reason: string | null;
  created_at: string;
}

export interface ApprovalAnswer {
  allow: boolean;
  /** Deny reason the agent is told. */
  message?: string;
  /** AskUserQuestion: question text to chosen label(s). */
  answers?: Record<string, string>;
  /** ExitPlanMode: the mode to continue in. */
  mode?: PermissionMode;
  /** Keep allowing this kind of call for the rest of the session. */
  always?: boolean;
}

export interface GitBranch {
  name: string;
  /** Present only on the remote, so choosing it creates a local tracking branch. */
  remoteOnly: boolean;
  current: boolean;
}

export interface GitState {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: string[];
  conflicted: string[];
  branches: GitBranch[];
  hasRemote: boolean;
}

export interface TaskGit {
  ahead: number;
  behind: number;
  dirty: string[];
  conflicted: string[];
  files: number;
  added: number;
  removed: number;
  /** The base branch already contains this task's commits. */
  merged: boolean;
  canMerge: { ok: boolean; reason: string | null; conflicts: string[] };
}

/** One thing Bench is holding on the machine, rolled up by what owns it. */
export interface MetricProcess {
  kind: 'claude' | 'terminal' | 'server' | 'other';
  sessionId: string | null;
  taskId: string | null;
  projectId: string | null;
  label: string;
  /** The project or context the process belongs to, for the row's second line. */
  sub: string;
  /** How many processes this row covers - a session with children is more than one. */
  count: number;
  pid: number | null;
  rssKb: number;
  pcpu: number;
  etimeMs: number | null;
}

export interface MetricStorage {
  name: string;
  path: string;
  note: string;
  /** Null while the size is still being measured off the request path. */
  bytes: number | null;
}

/** What Bench is costing the machine, as one snapshot. */
export interface Metrics {
  at: number;
  host: { hostname: string; platform: string; cpus: number; loadavg: number[]; uptimeMs: number; memTotal: number; memFree: number; diskPath: string; diskTotal: number | null; diskFree: number | null };
  machine: { memTotal: number; memFree: number; diskTotal: number | null; diskFree: number | null; diskPath: string };
  bench: { memCurrent: number; memPeak: number | null; memMax: number | null; pids: number | null; procs: number; source: 'cgroup' | 'rss' };
  procs: MetricProcess[];
  storage: { entries: MetricStorage[]; diskPath: string; diskTotal: number | null; diskFree: number | null };
}

/** Server to client, over /api/ws. */
export type ServerMessage =
  | { type: 'hello'; sessions: Session[]; approvals: Approval[] }
  | { type: 'session'; session: Session }
  | { type: 'session-removed'; id: string }
  | { type: 'task'; task: Task }
  | { type: 'event'; event: SessionEvent }
  | { type: 'delta'; session_id: string; text: string; thinking?: boolean }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval-done'; id: string; session_id: string }
  | { type: 'suggestion'; session_id: string; text: string }
  | { type: 'git'; project_id: string }
  | { type: 'pong' };

/** Client to server, over /api/ws. */
export type ClientMessage = { type: 'ping' };
