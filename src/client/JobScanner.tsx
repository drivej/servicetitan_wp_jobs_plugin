import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type { JobFilters } from './jobsSearch';
import { startJobScan } from './scannerApi';
import { JobTableHeader, JobTableRow, type JobTableItem } from './JobTable';
import { navigateTo } from './navigation';
import { Button, CircularProgress, IconButton, TextField } from '@mui/material';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { ScannerTask } from '../shared/job-scanner';
import type { WordPressStatus } from './wordpressStatusCache';
import { apiFetch } from './api';
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
export interface JobScannerHandle { start(filters:JobFilters):Promise<void>; select(id:string):void; }
export function JobScanner({searchFilters,controlRef,onShow,visible=true}: {searchFilters?:JobFilters;controlRef?:Ref<JobScannerHandle>;onShow?:()=>void;visible?:boolean} = {}) {
  const [scan,setScan] = useState<ScannerTask | null>();
  const [selectedScanId,setSelectedScanId] = useState('');
  const [startedScanId,setStartedScanId] = useState('');
  const starting = useRef(false);
  const [zip,setZip] = useState('');
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [canceling,setCanceling] = useState(false);
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
  const visibleScan = !searchFilters || Boolean(scan && (isActive || scan.id===startedScanId));
  const pushed = scan?.selected.filter(item=>item.build?.state==='succeeded' && item.build.result?.state==='exists') || [];
  const pushedIds = pushed.map(item=>item.jobId).join(',');
  const draftsNotCreated = scan && !isActive ? Math.max(0, scan.candidates.length - pushed.length) : 0;
  useEffect(()=>{
    const controller=new AbortController();
    const ids=pushedIds ? pushedIds.split(',').map(Number) : [];
    setJobs(current=>Object.fromEntries(Object.entries(current).filter(([id])=>ids.includes(Number(id)))));setDetailsError('');
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
        const body = await read<{scan:ScannerTask|null}>(await apiFetch(selectedScanId ? `/api/scanner/${selectedScanId}` : '/api/scanner/latest',{signal:controller.signal}));
        if (current !== generation.current || controller.signal.aborted) return;
        setScan(body.scan); setError('');
        const signature = JSON.stringify([body.scan?.state,body.scan?.scanFeeCharged,body.scan?.currentJob?.stage,body.scan?.selected.map(item=>item.build?.state)]);
        if (signature !== progress.current) { progress.current=signature; window.dispatchEvent(new Event('job-tokens-changed')); }
        if (body.scan?.selected.length && !activeScan(body.scan)) {
          const live = await read<{statuses:Record<number,WordPressStatus>}>(await apiFetch('/api/wordpress/statuses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobIds:body.scan.selected.map(item=>item.jobId)}),signal:controller.signal}));
          if (!controller.signal.aborted) setStatuses(live.statuses);
        }
      } catch (reason) { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Unable to load scan.'); setScan(current => current === undefined ? null : current); } }
      finally { if (!controller.signal.aborted && (isActive || scan === undefined)) timer=setTimeout(()=>void load(),2000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  },[isActive,scan === undefined,selectedScanId]);
  const start = async (filters=searchFilters) => {
    if(isActive){onShow?.();return;}
    if(starting.current || busy || !plugin.ready)return;
    const scanZip=filters?.zip ?? zip;
    if (scanZip.trim() && !/^\d{5}(?:-\d{4})?$/.test(scanZip.trim())) { setError('Enter a five-digit ZIP code, optionally followed by a four-digit extension.'); return; }
    if (exhausted) { showTokenError(); return; }
    starting.current=true;
    if (!await confirmTokenSpend('job_scan',true)) {starting.current=false;return;}
    onShow?.();
    setBusy(true); setError(''); setStatuses({});
    try {
      const next=await startJobScan(scanZip,filters);setSelectedScanId(next.id);setStartedScanId(next.id);setScan(next);
    } catch(reason) { setError(reason instanceof Error ? reason.message : 'Unable to start scan.'); }
    finally {starting.current=false;setBusy(false);}
  };
  useImperativeHandle(controlRef,()=>({start,select:(id:string)=>{setStatuses({});setScan(undefined);setSelectedScanId(id);setStartedScanId(id);onShow?.();}}));
  const cancelScan = async()=>{
    if(!scan || canceling)return;
    setCanceling(true);setError('');
    try{
      const body=await read<{scan:ScannerTask}>(await apiFetch(`/api/scanner/${scan.id}/cancel`,{method:'POST'}));setScan(body.scan);
    }catch(reason){setError(reason instanceof Error?reason.message:'Unable to cancel the scan.');}
    finally{setCanceling(false);}
  };
  const publish = async (jobId:number) => {
    setPublishing(jobId); setError('');
    try {
      const result = await read<WordPressStatus>(await apiFetch(`/api/jobs/${jobId}/wordpress/status`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'publish'})}));
      setStatuses(current=>({...current,[jobId]:result}));
    } catch(reason) { setError(reason instanceof Error ? reason.message : 'Unable to publish draft.'); }
    finally {setPublishing(undefined);}
  };
  const scanActions=<div className='job-scout-actions'>
      <Button variant='contained' disabled={busy || isActive || !plugin.ready || scan === undefined} onClick={()=>void start()}>{busy?'Starting…':isActive?'Scan in progress':searchFilters?'Start AI Job Scout':'Find My Next Great Posts'}</Button>
      <IconButton component='a' href='/help/job-scanner' aria-label='How AI Job Scout works' title='How AI Job Scout works'><InfoOutlinedIcon/></IconButton>
    </div>;
  return <section className='app-page scanner-page' style={searchFilters?{display:'contents'}:undefined}>
    {!searchFilters && <PageHeader eyebrow='AI Job Scout' title='Job Scanner' className='scanner-page-header' actions={scanActions}/>}
    {!searchFilters && <TextField label='ZIP code' placeholder='All ZIP codes' value={zip} onChange={event=>setZip(event.target.value)} disabled={busy || isActive} size='small' helperText='Optional. Only jobs at matching service locations will be evaluated.' sx={{maxWidth:360}}/>}
    {!plugin.loading && !plugin.ready && <p className='notice'>Verify the WordPress plugin in Settings before scanning.</p>}
    {error && <p className='notice error' role='alert'>{error}</p>}
    {visible && visibleScan && scan && <div className='scanner-summary'>
      <div className='scanner-progress-actions'>
      <div role='status'>
      {scan ? <p><strong>{scan.stopReason==='canceled'?'Scan canceled':scan.cancelRequested?'Canceling scan…':isActive?'Finding your next great posts…':scan.state==='failed'?'Scan stopped':'Scan complete'}</strong> · {isActive ? `${pushed.length}/5 drafts ready` : `${pushed.length} ${pushed.length===1?'draft':'drafts'} ready`} · {scan.candidates.length} strong candidates found{draftsNotCreated > 0 && <> · {draftsNotCreated} {draftsNotCreated===1?'candidate did':'candidates did'} not produce a draft</>} · {scan.scanned} jobs checked</p> : <p>Prepare up to 5 WordPress drafts, one at a time. If a candidate fails, the scanner looks for another.</p>}
      </div>
      {isActive && <Button color='error' variant='outlined' title='Queued work will stop. A draft already building may finish; completed drafts and their token charges remain.' disabled={canceling || Boolean(scan.cancelRequested)} onClick={()=>void cancelScan()}>{canceling || scan.cancelRequested?'Canceling…':'Cancel Scan'}</Button>}
      </div>
      {scan?.error && <p className='notice error'>{scan.error}</p>}
      {scan?.stopReason==='limits' && <p className='field-help'>Search limit reached.</p>}
      {scan && !isActive && !pushed.length && scan.state==='succeeded' && <p>No drafts were created. {scan.stopReason==='canceled'?'Completed work has been preserved.':'No available jobs could be built in this scan.'}</p>}
    </div>}
    {visible && visibleScan && (pushed.length > 0 || isActive) && <section className='scanner-results' aria-label='Your WordPress drafts'>
      {detailsError && <p className='notice' role='status'>{detailsError} <Button onClick={()=>setRefreshVersion(value=>value+1)}>Retry details</Button></p>}
      <div className='table-wrap'><table className='jobs-table'>
        <caption className='visually-hidden'>Job Scanner progress and completed WordPress drafts</caption>
        <colgroup><col className='readiness-column'/><col className='job-image-column'/><col className='job-name-column'/><col className='location-column'/><col className='wp-status-column'/><col className='actions-column'/></colgroup>
        <JobTableHeader refreshing={refreshing} disabled={refreshing || publishing!==undefined} onRefresh={()=>void refreshStatuses()}/>
        <tbody>{pushed.map(item=>{
          const status=statuses[item.jobId] || item.build!.result!;
          const job=jobs[item.jobId] || {id:item.jobId,jobName:item.title,status:'Completed',location:{city:'—',state:'—',zip:'—'}};
          return <JobTableRow key={item.jobId} job={job} rating={item} wordpressStatus={publishing===item.jobId?{...status,label:'Updating…'}:status}
            wordpressBusy={publishing!==undefined || refreshing} wordpressPluginReady={plugin.ready} tokensExhausted={exhausted}
            onOpen={()=>navigateTo(`/jobs/${item.jobId}`)} onPublish={()=>void publish(item.jobId)} onRefresh={()=>void refreshStatuses(item.jobId)}/>;
        })}
        {isActive && <tr className='job-row scanner-processing-row' aria-busy='true'>
          <td className='readiness-cell' aria-label='Processing'>…</td>
          <td className='job-image-cell'><div className='scanner-processing-art'><CircularProgress size={28} aria-label={scan?.currentJob?.stage==='drafting'?'Building WordPress draft':'Checking next job'}/></div></td>
          <td className='job-name-cell'><div className='job-name'>{scan?.currentJob?.title || 'Getting your scan ready'}</div>
            <div className='job-row-metadata'>{scan?.currentJob?.jobId && <span>#{scan.currentJob.jobId}</span>}{scan?.currentJob?.score!==undefined && <span>{scan.currentJob.score}/100</span>}</div>
            <span className='scanner-stage'>{scan?.cancelRequested?'Finishing the current job safely…':scan?.currentJob?.stage==='drafting'?'Building and pushing your WordPress draft…':scan?.currentJob?.stage==='rating'?'Evaluating this job with AI…':scan?.currentJob?.stage==='checking'?'Checking job details and attachments…':scan?.state==='queued'?'Waiting to start…':'Looking for your next strong job…'}</span>
          </td>
          <td className='location-cell' data-label='Location'>—</td>
          <td className='wp-status-cell' data-label='WordPress'>{scan?.currentJob?.stage==='drafting'?'Preparing draft':'Checking'}</td>
          <td className='actions-cell' data-label='Token cost'><span className='field-help'>{scan?.currentJob?.stage==='drafting'?'1 token per draft':'1 token per scan'}</span></td>
        </tr>}
        </tbody>
      </table></div>
    </section>}
    {tokenSpendDialog}
  </section>;
}
