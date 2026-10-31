export interface Session {
  source?: string;
  nativeID?: string;
  nativeResume?: boolean;
  revision?: string;
  coverage?: { history: 'complete' | 'partial' | 'pending'; note?: string; importedAt?: number };
  id: string;
  title: string;
  projectID: string;
  parentID?: string;
  forkID?: string;
  directory: string;
  created: number;
  updated: number;
  activity?: { firstMessageAt: number | null; lastMessageAt: number | null; userMessages: number; untimedUserMessages: number };
  archived: boolean;
  model: string;
  provider: string;
  agent: string;
  cost: number | null;
  tokens: number | null;
  outcome?: string;
}

export interface Project {
  id: string;
  name: string;
  directory: string;
  worktrees: string[];
}

export interface SessionGraphData {
  autoImport?: boolean;
  onboarding?: boolean;
  sources?: SourceStatus[];
  importing?: boolean;
  sourceID?: string;
  sessions: Session[];
  projects: Project[];
  loadedAt: number;
  warnings: string[];
}

export interface FileChange {
  path: string;
  source: "snapshot" | "edit tool" | "file change";
  steps: number;
}

export interface SessionDetail {
  note?: string;
  id: string;
  files: FileChange[];
  tools: { name: string; count: number }[];
  locations: { directory: string; time: number }[];
  messagesScanned: number;
  snapshotSteps: number;
  partial: boolean;
  nextCursor: string | null;
  loadedAt: number;
}

export interface SessionTimeline {
  id: string;
  userMessages: { id: string; time: number }[];
  totalUserMessages: number;
  untimedUserMessages: number;
  earlierUserMessages: number;
  partial: boolean;
  note?: string;
}

export interface SourceStatus {
  id: string;
  name: string;
  available: boolean;
  selected: boolean;
  description: string;
  capabilities: { history: boolean; forks: boolean; children: boolean; files: boolean };
  sessions: number;
  lastImport?: number;
  error?: string;
}

export interface ImportStatus {
  running: boolean;
  source?: string;
  discovered: number;
  imported: number;
  unchanged: number;
  failed: number;
  errors: string[];
}

export interface GraphNode {
  session: Session;
  position: [number, number, number];
  startPosition: [number, number, number];
  color: string;
  radius: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "fork" | "child";
}

export interface Lane {
  key: string;
  label: string;
  color: string;
  kind: "worktree" | "directory";
  y: number;
  z: number;
  nodes: GraphNode[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lanes: Lane[];
  start: number;
  end: number;
}
