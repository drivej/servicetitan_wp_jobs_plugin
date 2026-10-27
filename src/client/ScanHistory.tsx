import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import { apiFetch } from './api';
import type { ScannerTask } from '../shared/job-scanner';

export function ScanHistory({open,onClose,onSelect}:{open:boolean;onClose:()=>void;onSelect:(id:string)=>void}) {
  const [scans,setScans]=useState<ScannerTask[]>([]);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [hasMore,setHasMore]=useState(false);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{if(open){setScans([]);setPage(1);}},[open]);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setLoading(true);setError('');
    void (async()=>{
      try{
        const response=await apiFetch(`/api/scanner/history?page=${page}`,{signal:controller.signal});
        const body=await response.json() as {scans:ScannerTask[];error?:string};
        if(!response.ok)throw new Error(body.error || 'Unable to load previous scans.');
        if(controller.signal.aborted)return;
        setScans(current=>page===1?body.scans:[...current,...body.scans.filter(scan=>!current.some(item=>item.id===scan.id))]);setHasMore(body.scans.length===20);
      }catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Unable to load previous scans.');}
      finally{if(!controller.signal.aborted)setLoading(false);}
    })();
    return ()=>controller.abort();
  },[open,page,retry]);
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth='sm' aria-labelledby='scan-history-title'>
    <DialogTitle id='scan-history-title'>Previous AI Job Scout scans</DialogTitle>
    <DialogContent>
      <p className='field-help'>Viewing results is free and does not restart a scan or change your search.</p>
      {scans.map(scan=>{
        const drafts=scan.selected.filter(item=>item.build?.state==='succeeded' && item.build.result?.state==='exists').length;
        const state=scan.stopReason==='canceled'?'Canceled':scan.state==='succeeded'?'Complete':scan.state==='failed'?'Stopped':'In progress';
        const end=scan.dateRange ? new Date(Date.parse(scan.dateRange.endDateExclusive)-86400000).toISOString().slice(0,10) : '';
        return <Button key={scan.id} variant='outlined' fullWidth onClick={()=>onSelect(scan.id)} sx={{display:'block',textAlign:'left',textTransform:'none',mb:1.5}}>
          <strong>{new Date(scan.createdAt).toLocaleString()} · {state}</strong><br/>
          {drafts} {drafts===1?'draft':'drafts'} created · {scan.scanned} jobs checked<br/>
          {scan.dateRange ? `${scan.dateRange.startDate.slice(0,10)} to ${end}` : 'All dates'} · {scan.zip ? `ZIP ${scan.zip}` : 'All ZIP codes'}
        </Button>;
      })}
      {loading && <p role='status'>Loading previous scans…</p>}
      {error && <p role='alert'>{error} <Button onClick={()=>setRetry(value=>value+1)}>Retry</Button></p>}
      {!loading && !error && !scans.length && <p>No previous scans yet.</p>}
      {hasMore && !error && <Button disabled={loading} onClick={()=>setPage(value=>value+1)}>Load more</Button>}
    </DialogContent>
    <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
  </Dialog>;
}
