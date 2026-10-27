import { useEffect, useState } from 'react';
import { Button } from '@mui/material';
import { apiFetch } from './api';
import type { ScannerTask } from '../shared/job-scanner';
import { JobTableHeader, JobTableRow, type JobTableItem } from './JobTable';
import { navigateTo } from './navigation';
import { useWordPressPluginStatus } from './useWordPressPluginStatus';
import { useTokensExhausted } from './tokenState';
import type { WordPressStatus } from './wordpressStatusCache';

const drafts=(scan:ScannerTask)=>scan.selected.filter(item=>item.build?.state==='succeeded' && item.build.result?.state==='exists');
async function read<T>(response:Response):Promise<T>{const body=await response.json();if(!response.ok)throw new Error(body.error || 'Unable to load scan results.');return body as T;}
export function ScanHistory({open}:{open:boolean}) {
  const [scans,setScans]=useState<ScannerTask[]>([]);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [hasMore,setHasMore]=useState(false);
  const [retry,setRetry]=useState(0);
  const [jobs,setJobs]=useState<Record<number,JobTableItem>>({});
  const [statuses,setStatuses]=useState<Record<number,WordPressStatus>>({});
  const [publishing,setPublishing]=useState<number>();
  const plugin=useWordPressPluginStatus(),exhausted=useTokensExhausted();
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setLoading(true);setError('');setScans([]);setStatuses({});setJobs({});
    void (async()=>{
      try{
        const body=await read<{scans:ScannerTask[]}>(await apiFetch(`/api/scanner/history?page=${page}`,{signal:controller.signal}));
        if(controller.signal.aborted)return;
        setScans(body.scans);setHasMore(body.scans.length===5);
        const ids=[...new Set(body.scans.flatMap(scan=>drafts(scan).map(item=>item.jobId)))];
        // Status requests stay within the API batch limit. Each page contains
        // complete scan groups, independently of how many jobs they contain.
        for(let i=0;i<ids.length;i+=50){
          const live=await read<{statuses:Record<number,WordPressStatus>}>(await apiFetch('/api/wordpress/statuses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobIds:ids.slice(i,i+50)}),signal:controller.signal}));
          if(controller.signal.aborted)return;
          setStatuses(current=>({...current,...live.statuses}));
        }
        for(let i=0;i<ids.length;i+=8){
          const details=await Promise.allSettled(ids.slice(i,i+8).map(async id=>{
            const result=await read<{summary:JobTableItem;attachments:NonNullable<JobTableItem['attachments']>}>(await apiFetch(`/api/jobs/${id}`,{signal:controller.signal}));
            return {id,job:{...result.summary,attachments:result.attachments}};
          }));
          if(controller.signal.aborted)return;
          const loaded:Record<number,JobTableItem>={};
          for(const result of details)if(result.status==='fulfilled')loaded[result.value.id]=result.value.job;
          setJobs(current=>({...current,...loaded}));
          if(details.some(result=>result.status==='rejected'))setError('Some job details could not be loaded. Saved scan results are still shown.');
        }
      }catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Unable to load previous scans.');}
      finally{if(!controller.signal.aborted)setLoading(false);}
    })();
    return ()=>controller.abort();
  },[open,page,retry]);
  const publish=async(id:number)=>{
    setPublishing(id);setError('');
    try{const status=await read<WordPressStatus>(await apiFetch(`/api/jobs/${id}/wordpress/status`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'publish'})}));setStatuses(current=>({...current,[id]:status}));}
    catch(reason){setError(reason instanceof Error?reason.message:'Unable to publish draft.');}
    finally{setPublishing(undefined);}
  };
  if(!open)return null;
  return <section className='scanner-results' aria-label='Previous AI Job Scout scans'>
    {error && <p role='alert'>{error} <Button disabled={loading} onClick={()=>setRetry(value=>value+1)}>Retry</Button></p>}
    {loading && <p role='status'>Loading previous scans…</p>}
    {!loading && !error && !scans.length && <p>No scans on this page.</p>}
    {!!scans.length && <div className='table-wrap'><table className='jobs-table'>
      <caption className='visually-hidden'>Previous AI Job Scout results grouped by scan</caption>
      <colgroup><col className='readiness-column'/><col className='job-image-column'/><col className='job-name-column'/><col className='location-column'/><col className='wp-status-column'/><col className='actions-column'/></colgroup>
      <JobTableHeader refreshing={loading} disabled={loading || publishing!==undefined} onRefresh={()=>setRetry(value=>value+1)}/>
      {scans.map(scan=>{
        const pushed=drafts(scan),missed=Math.max(0,scan.candidates.length-pushed.length);
        const label=scan.stopReason==='canceled'?'Scan canceled':scan.state==='succeeded'?'Scan complete':scan.state==='failed'?'Scan stopped':'Scan in progress';
        return <tbody key={scan.id} aria-label={`${label} ${new Date(scan.createdAt).toLocaleString()}`}>
          <tr className='scan-history-subheader'><th colSpan={6} scope='rowgroup'>
            <strong>{label}</strong> · {pushed.length} {pushed.length===1?'draft':'drafts'} ready · {scan.candidates.length} strong {scan.candidates.length===1?'candidate':'candidates'} found{missed>0 && <> · {missed} {missed===1?'candidate did':'candidates did'} not produce a draft</>} · {scan.scanned} jobs checked
            <span className='scan-history-date'>{new Date(scan.createdAt).toLocaleString()}</span>
          </th></tr>
          {pushed.map(item=>{
            const status=statuses[item.jobId] || {state:'unknown' as const,label:'Unknown'};
            const job=jobs[item.jobId] || {id:item.jobId,jobName:item.title,status:'Completed',location:{city:'—',state:'—',zip:'—'}};
            return <JobTableRow key={item.buildTaskId} job={job} rating={item} wordpressStatus={publishing===item.jobId?{...status,label:'Updating…'}:status} wordpressBusy={publishing!==undefined || loading} wordpressPluginReady={plugin.ready} tokensExhausted={exhausted} onOpen={()=>navigateTo(`/jobs/${item.jobId}`)} onPublish={()=>void publish(item.jobId)} onRefresh={()=>setRetry(value=>value+1)}/>;
          })}
          {!pushed.length && <tr><td colSpan={6}>No drafts were created in this scan.</td></tr>}
        </tbody>;
      })}
    </table></div>}
    <nav className='scan-history-pagination' aria-label='Scan history pages'>
      <Button disabled={page===1 || loading || publishing!==undefined} onClick={()=>setPage(value=>value-1)}>Previous</Button>
      <span>Page {page} · Up to 5 complete scans per page</span>
      <Button disabled={!hasMore || loading || publishing!==undefined} onClick={()=>setPage(value=>value+1)}>Next</Button>
    </nav>
  </section>;
}
