import { JobTableHeader, JobTableRow, type JobTableItem } from './JobTable';
import { navigateTo } from './navigation';
import { Button, LinearProgress } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import type { ScannerTask } from '../shared/job-scanner';
import type { WordPressStatus } from './wordpressStatusCache';
import { apiFetch, apiUrl } from './api';
import { PageHeader } from './PageHeader';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import { useTokenSpendConfirmation } from './TokenSpendConfirmation';
import { showTokenError, useTokensExhausted } from './tokenState';
const activeScan = (scan?: ScannerTask | null) => Boolean(scan && (['queued','running','drafting'].includes(scan.state) || scan.selected.some(item => item.build && ['queued','running'].includes(item.build.state))));
async function read<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || 'Job Scanner request failed.');
  return body;
}
export function JobScanner() {
  const [scan,setScan] = useState<ScannerTask | null>();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [publishing,setPublishing] = useState<number>();
  const [jobs,setJobs] = useState<Record<number,JobTableItem>>({});
  const [detailsError,setDetailsError] = useState('');
  const [refreshing,setRefreshing] = useState(false);
  const [refreshVersion,setRefreshVersion] = useState(0);
  const [statuses,setStatuses] = useState<Record<number,WordPressStatus>>({});
  const exhausted = useTokensExhausted();
  const plugin = useWordPressPluginStatus();
  const { confirmTokenSpend, tokenSpendDialog } = useTokenSpendConfirmation();
  const generation = useRef(0);
  const progress = useRef('');
  const isActive = activeScan(scan);
  const pushed = scan?.selected.filter(item=>item.build?.state==='succeeded' && item.build.result?.state==='exists') || [];
  const pushedIds = pushed.map(item=>item.jobId).join(',');
  useEffect(()=>{
    const controller=new AbortController();
    setJobs({});setDetailsError('');
    const ids=pushedIds ? pushedIds.split(',').map(Number) : [];
    void Promise.allSettled(ids.map(async id=>{
      const details=await read<{summary:JobTableItem;attachments:NonNullable<JobTableItem['attachments']>}>(await apiFetch(`/api/jobs/${id}`,{signal:controller.signal}));
      return {id,job:{...details.summary,attachments:details.attachments}};
    })).then(results=>{
      if(controller.signal.aborted)return;
      const loaded:Record<number,JobTableItem>={};
      for(const result of results)if(result.status==='fulfilled')loaded[result.value.id]=result.value.job;
      setJobs(loaded);
      if(results.some(result=>result.status==='rejected'))setDetailsError('Some ServiceTitan details could not be loaded. Your WordPress draft results are still shown below.');
    });
    return ()=>controller.abort();
  },[scan?.id,pushedIds,refreshVersion]);
  const refreshStatuses = async (jobId?:number) => {
    setRefreshing(true);setError('');
    try {
      const ids=jobId ? [jobId] : pushed.map(item=>item.jobId);
      if(!ids.length)return;
      const body=await read<{statuses:Record<number,WordPressStatus>}>(await apiFetch('/api/wordpress/statuses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobIds:ids})}));
      setStatuses(current=>({...current,...body.statuses}));
    }catch(reason){setError(reason instanceof Error?reason.message:'Unable to refresh WordPress statuses.');}
    finally{setRefreshing(false);}
  };

  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const current = ++generation.current;
    const load = async () => {
      try {
        if (document.hidden) return;
        const body = await read<{scan:ScannerTask|null}>(await apiFetch('/api/scanner/latest',{signal:controller.signal}));
        if (current !== generation.current || controller.signal.aborted) return;
        setScan(body.scan); setError('');
        const signature = JSON.stringify([body.scan?.state,body.scan?.selected.map(item=>item.build?.state)]);
        if (signature !== progress.current) { progress.current=signature; window.dispatchEvent(new Event('job-tokens-changed')); }
        if (body.scan?.selected.length && !activeScan(body.scan)) {
          const live = await read<{statuses:Record<number,WordPressStatus>}>(await apiFetch('/api/wordpress/statuses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobIds:body.scan.selected.map(item=>item.jobId)}),signal:controller.signal}));
          if (!controller.signal.aborted) setStatuses(live.statuses);
        }
      } catch (reason) { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Unable to load scan.'); setScan(current => current === undefined ? null : current); } }
      finally { if (!controller.signal.aborted && (isActive || scan === undefined)) timer=setTimeout(()=>void load(),5000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  },[isActive,scan === undefined]);
  const start = async () => {
    if (exhausted) { showTokenError(); return; }
    if (!await confirmTokenSpend('job_scan')) return;
    setBusy(true); setError(''); setStatuses({});
    const key = `job-scanner-request:${apiUrl('/api/scanner/start')}`;
    let id: string = window.crypto.randomUUID();
    try { id = window.sessionStorage.getItem(key) || id; window.sessionStorage.setItem(key,id); } catch { /* One-shot request remains safe while mounted. */ }
    try {
      const body=await read<{scan:ScannerTask}>(await apiFetch('/api/scanner/start',{method:'POST',headers:{'Idempotency-Key':id}}));
      setScan(body.scan);
      try { window.sessionStorage.removeItem(key); } catch { /* Ignore unavailable storage. */ }
    } catch(reason) { setError(reason instanceof Error ? reason.message : 'Unable to start scan.'); }
    finally {setBusy(false);}
  };
  const publish = async (jobId:number) => {
    setPublishing(jobId); setError('');
    try {
      const result = await read<WordPressStatus>(await apiFetch(`/api/jobs/${jobId}/wordpress/status`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'publish'})}));
      setStatuses(current=>({...current,[jobId]:result}));
    } catch(reason) { setError(reason instanceof Error ? reason.message : 'Unable to publish draft.'); }
    finally {setPublishing(undefined);}
  };
  return <main className='app-page'>
    <PageHeader eyebrow='Find your next project post' title='Job Scanner' description='Review recent completed jobs, rate their source content, and prepare the strongest opportunities as WordPress drafts.' />
    <section className='panel scanner-panel'>
      <h2>Find strong content automatically</h2>
      <p>Starting with the newest jobs by creation date (completed jobs only), skip jobs already in WordPress and collect up to 10 candidates rated 70/100 or higher. The best five become drafts for your review.</p>
      <p><strong>1 token per scan + 1 token per draft created (up to 6 total).</strong> Publishing is free. If your balance runs out, fewer drafts may be created.</p>
      <p className='field-help'>Ratings measure the evidence available for a useful local-service post, not predicted search rankings. Each scan is limited to 500 jobs, 40 AI ratings, and about 10 minutes; it may finish sooner. Images are checked when building drafts.</p>
      <Button variant='contained' disabled={busy || isActive || !plugin.ready || scan === undefined} onClick={()=>void start()}>{busy ? 'Starting…' : isActive ? 'Scan in progress' : 'Scan and prepare drafts'}</Button>
      {!plugin.loading && !plugin.ready && <p className='notice'>Verify the WordPress plugin in Settings before scanning.</p>}
      {error && <p className='notice error' role='alert'>{error}</p>}
      {scan && <div className='scanner-progress' aria-live='polite'>
        <p><strong>{scan.state === 'queued' ? 'Queued — scanning will begin shortly' : scan.state === 'running' ? 'Scanning newest completed jobs' : scan.state === 'drafting' ? 'Preparing WordPress drafts' : scan.state === 'failed' ? 'Scan could not finish' : 'Scan complete'}</strong> · {scan.scanned} jobs checked · {scan.rated} AI ratings · {scan.candidates.length} strong candidates</p>
        {isActive && <LinearProgress aria-label='Job Scanner progress' />}
        {scan.stopReason === 'limits' && <p>Scan limits reached. Results cover the jobs scanned so far; more jobs may remain.</p>}
        {scan.stopReason === 'exhausted' && <p>No more jobs were returned by ServiceTitan.</p>}
        {scan.error && <p className='notice error'>{scan.error}</p>}
        {!isActive && !scan.selected.length && scan.state === 'succeeded' && <p>No jobs met the content threshold. The scan cost one token; no draft tokens were charged.</p>}
      </div>}
    </section>
    {pushed.length > 0 && <section className='scanner-results' aria-labelledby='scanner-pushed-heading'>
      <h2 id='scanner-pushed-heading'>Jobs pushed to WordPress</h2>
      <p>{pushed.length} {pushed.length===1?'job was':'jobs were'} sent to WordPress as {pushed.length===1?'a draft':'drafts'}. Review each job before publishing.</p>
      {detailsError && <p className='notice' role='status'>{detailsError} <Button onClick={()=>setRefreshVersion(value=>value+1)}>Retry details</Button></p>}
      <div className='table-wrap'><table className='jobs-table'>
        <caption className='visually-hidden'>Jobs successfully pushed by this scan</caption>
        <colgroup><col className='readiness-column'/><col className='job-image-column'/><col className='job-name-column'/><col className='location-column'/><col className='wp-status-column'/><col className='actions-column'/></colgroup>
        <JobTableHeader refreshing={refreshing} disabled={refreshing || publishing!==undefined} onRefresh={()=>void refreshStatuses()}/>
        <tbody>{pushed.map(item=>{
          const status=statuses[item.jobId] || item.build!.result!;
          const job=jobs[item.jobId] || {id:item.jobId,jobName:item.title,status:'Completed',location:{city:'—',state:'—',zip:'—'}};
          return <JobTableRow key={item.jobId} job={job} rating={item} wordpressStatus={publishing===item.jobId?{...status,label:'Updating…'}:status}
            wordpressBusy={publishing!==undefined || refreshing} wordpressPluginReady={plugin.ready} tokensExhausted={exhausted}
            onOpen={()=>navigateTo(`/jobs/${item.jobId}`)} onPublish={()=>void publish(item.jobId)} onRefresh={()=>void refreshStatuses(item.jobId)}/>;
        })}</tbody>
      </table></div>
    </section>}
    {!!scan?.selected.some(item=>item.build?.state!=='succeeded') && <section className='panel scanner-result' aria-label='Draft progress and failures'>
      <h2>{isActive?'Preparing more drafts':'Jobs not pushed'}</h2>
      <ul>{scan.selected.filter(item=>item.build?.state!=='succeeded').map(item=><li key={item.jobId}>
        <a href={`/jobs/${item.jobId}`}>{item.title} · #{item.jobId}</a> · {item.score}/100 · {item.build?.state==='failed'?'Draft failed':item.build?.state==='running'?'Building draft…':'Draft queued'}
        {item.build?.error && <p className='notice error'>{item.build.error}</p>}
      </li>)}</ul>
    </section>}
    {tokenSpendDialog}
  </main>;
}
