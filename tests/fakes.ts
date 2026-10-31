import type { ChangedFile, GitHubPort, RouteLabel } from '../src/adapters/github.js';
import type { AssessorPort, ModelAssessment } from '../src/adapters/ollama.js';
import type { RunRequest, RunResult, RunnerPort } from '../src/runner/protocol.js';

export const COMMIT = 'a'.repeat(40);

export class FakeGitHub implements GitHubPort {
  head = COMMIT;
  issues = new Map<number, { title: string; body: string; label: RouteLabel }>();
  prs: { branch: string; files: ChangedFile[]; body: string }[] = [];
  files: Record<string, string> = {
    'src/tools/registry.ts': "export const KNOWN_GAPS = [\n  resolvedByTool: 'configure_payment_reminders',\n];\n",
    'src/services/testmail.ts': 'export class TestMailer {\n  static assertTestRecipient(address: string) {}\n}\n',
    'Dockerfile': 'FROM node',
  };
  async headCommit() { return this.head; }
  async listFiles() { return Object.entries(this.files).map(([path, c]) => ({ path, sha: path, size: c.length, type: 'blob' })); }
  async readBlob(sha: string) { return this.files[sha]!; }
  async upsertIssue(i: { number?: number; title: string; body: string; label: RouteLabel }) {
    const number = i.number ?? this.issues.size + 1;
    this.issues.set(number, { title: i.title, body: i.body, label: i.label });
    return { number, url: `https://github.test/issues/${number}` };
  }
  async createDraftPr(i: { branch: string; files: ChangedFile[]; body: string }) {
    this.prs.push(i);
    return { number: 100 + this.prs.length, url: `https://github.test/pull/${100 + this.prs.length}` };
  }
}

export const goodAssessment: ModelAssessment = {
  summary: 'Add a reminder rule and a run tool using the existing test mailer.',
  feasible: true,
  automatable: true,
  blockers: [],
  evidence: [
    { path: 'src/tools/registry.ts', quote: "resolvedByTool: 'configure_payment_reminders'," },
    { path: 'src/services/testmail.ts', quote: 'static assertTestRecipient(address: string) {}' },
  ],
  workPackages: [{ title: 'Reminder rule + tool', minHours: 3, maxHours: 6 }, { title: 'Tests', minHours: 1, maxHours: 2 }],
};

export class FakeAssessor implements AssessorPort {
  constructor(public next: ModelAssessment = goodAssessment) {}
  async assess() { return this.next; }
}

export class FakeRunner implements RunnerPort {
  calls: RunRequest[] = [];
  constructor(public next: RunResult) {}
  async run(req: RunRequest) { this.calls.push(req); return this.next; }
}

const ok = (name: string) => ({ name, ok: true, exitCode: 0, outputTail: '' });
export const okRun: RunResult = {
  status: 'ok',
  before: ['typecheck', 'test', 'build'].map((n) => ok(`before:${n}`)),
  after: ['typecheck', 'test', 'build'].map((n) => ok(`after:${n}`)),
  files: [
    { path: 'src/services/reminders.ts', content: 'export const x = 1;\n', existedBefore: false },
    { path: 'tests/reminders.test.ts', content: "import { it } from 'vitest';\n", existedBefore: false },
  ],
  agentLogTail: 'done',
};
