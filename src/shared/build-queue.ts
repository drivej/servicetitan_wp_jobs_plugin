import type { WordPressPostStatus } from '../server/wordpress.js';
export interface BuildTask {
  id: string;
  jobId: number;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  error?: string;
  result?: WordPressPostStatus;
}
