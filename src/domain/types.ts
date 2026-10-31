import type { Line, Totals } from './money.js';

export interface Customer {
  id: string;
  number: string;
  name: string;
  contactName: string;
  /** Billing contact. Demo data only uses reserved .invalid domains. */
  email: string;
  createdAt: string;
}

export interface Quote {
  id: string;
  number: string;
  customerId: string;
  issueDate: string;
  lines: Line[];
  totals: Totals;
  status: 'open' | 'accepted';
  acceptedAt?: string;
}

export interface Payment { id: string; date: string; amountCents: number; reference: string }

export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  quoteId: string;
  issueDate: string;
  dueDate: string;
  lines: Line[];
  totals: Totals;
  payments: Payment[];
  /** Test draft, never a real accounting document. */
  testDraft: true;
}

export interface ExportFile {
  id: string;
  kind: 'invoice_pdf' | 'open_items_pdf' | 'open_items_xlsx' | 'open_items_csv';
  fileName: string;
  relPath: string;
  sizeBytes: number;
  createdAt: string;
}

export type DecisionStatus = 'confirmed' | 'proposed' | 'unknown';
export interface Decision { topic: string; answer: string; status: DecisionStatus }

export interface Scope {
  goal: string;
  trigger: string;
  affectedData: string[];
  behavior: string[];
  exceptions: string[];
  assumptions: string[];
  openQuestions: string[];
  acceptanceCriteria: string[];
  decisions: Decision[];
}

export interface WorkPackage { title: string; minHours: number; maxHours: number }
export interface Evidence { path: string; quote: string }

export interface Assessment {
  commit: string;
  scopeVersion: number;
  summary: string;
  feasible: boolean;
  automatable: boolean;
  blockers: string[];
  evidence: Evidence[];
  workPackages: WorkPackage[];
  route: 'auto-implement' | 'needs-human';
  validationErrors: string[];
  createdAt: string;
}

export interface DevOffer {
  id: string;
  version: number;
  scopeVersion: number;
  assessmentCommit: string;
  ratePerHourCents: number;
  riskSurchargePct: number;
  workPackages: WorkPackage[];
  lowCents: number;
  highCents: number;
  runningCosts: string;
  status: 'open' | 'superseded' | 'accepted';
  createdAt: string;
}

export type FeatureStatus =
  | 'drafting' | 'scope_confirmed' | 'assessing' | 'offer_ready' | 'needs_human'
  | 'accepted' | 'implementing' | 'pr_open' | 'merged' | 'deployed';

export interface FeatureRequest {
  id: string;
  number: string;
  title: string;
  originalRequest: string;
  status: FeatureStatus;
  scope: Scope;
  scopeVersion: number;
  confirmedScopeVersion?: number;
  ticket?: { number: number; url: string; label: 'auto-implement' | 'needs-human' };
  assessment?: Assessment;
  offers: DevOffer[];
  orderId?: string;
  pullRequest?: { number: number; url: string; commit?: string };
  /** Review rounds requested by a human on earlier pull requests. */
  reviews?: { pr: number; notes: string; at: string }[];
  deployment?: { commit: string; deployedAt: string };
  history: { at: string; event: string }[];
  createdAt: string;
}

export interface Order {
  id: string;
  number: string;
  featureRequestId: string;
  offerId: string;
  offerVersion: number;
  scopeVersion: number;
  binding: false;
  createdAt: string;
}
