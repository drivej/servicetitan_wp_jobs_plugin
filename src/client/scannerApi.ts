import type { ScannerTask } from '../shared/job-scanner';
import { apiFetch, apiUrl } from './api';

// Both entry points reuse the same durable request key after a failed response.
export async function startJobScan(): Promise<ScannerTask> {
  const key = `job-scanner-request:${apiUrl('/api/scanner/start')}`;
  let id: string = window.crypto.randomUUID();
  try { id = window.sessionStorage.getItem(key) || id; window.sessionStorage.setItem(key,id); } catch { /* One-shot request remains safe while mounted. */ }
  const response = await apiFetch('/api/scanner/start',{method:'POST',headers:{'Idempotency-Key':id}});
  const body = await response.json() as {scan:ScannerTask;error?:string};
  if (!response.ok) throw new Error(body.error || 'Unable to start scan.');
  try { window.sessionStorage.removeItem(key); } catch { /* Ignore unavailable storage. */ }
  return body.scan;
}
