import type { BuildTask } from './build-queue.js';
export interface SeoRating { score: number; reason: string; }
export interface ScannerCandidate extends SeoRating { jobId: number; title: string; }
export interface ScannerSelection extends ScannerCandidate { buildTaskId: string; build?: BuildTask; }
export interface ScannerTask {
  id: string;
  state: 'queued' | 'running' | 'drafting' | 'succeeded' | 'failed';
  createdAt: string;
  scanned: number;
  rated: number;
  candidates: ScannerCandidate[];
  selected: ScannerSelection[];
  stopReason?: 'ten_candidates' | 'exhausted' | 'limits';
  error?: string;
}
export const SCANNER_MIN_SCORE = 70;
export const SCANNER_MAX_JOBS = 500;
export const SCANNER_MAX_RATINGS = 40;
