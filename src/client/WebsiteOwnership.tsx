import { useEffect, useState } from 'react';
import { Button, TextField } from '@mui/material';
import { accountFetch } from './api';

export function WebsiteOwnershipConflict({ websiteId }: { websiteId: string }) {
  const [message,setMessage]=useState('');
  const [details,setDetails]=useState('');
  const [busy,setBusy]=useState(false);
  async function submit(kind: 'access' | 'dispute') {
    setBusy(true);setMessage('');
    try {
      const response=await accountFetch('/api/website-ownership/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({websiteId,kind,message:details})});
      const body=await response.json();
      setMessage(response.ok ? body.message : body.error || 'Unable to submit request.');
    } catch { setMessage('Unable to submit request. Try again.'); }
    finally { setBusy(false); }
  }
  return <section className="panel account-panel" aria-labelledby="website-ownership-title">
    <h2 id="website-ownership-title">Website already connected</h2>
    <p>This WordPress installation is connected to an existing workspace. Request an invitation to work with its team, or dispute ownership if the connection is incorrect. The current owner’s identity is private.</p>
    <p>Requests do not grant access or change ownership. Access requests are reviewed in the connected workspace’s Team settings. Disputes require platform review.</p>
    <TextField label="Explain your relationship to this website" value={details} onChange={event=>setDetails(event.target.value)} multiline fullWidth slotProps={{htmlInput:{maxLength:2000}}}/>
    <Button disabled={busy || !details.trim()} onClick={()=>void submit('access')}>Request access</Button>
    <Button disabled={busy || !details.trim()} onClick={()=>void submit('dispute')}>Dispute ownership</Button>
    {message && <p role="status">{message}</p>}
  </section>;
}
interface OwnershipRequest { id: string; kind: string; url: string; message: string; requester_email: string; }
export function WebsiteOwnershipRequests({ workspaceId }: {workspaceId: string}) {
  const [requests,setRequests]=useState<OwnershipRequest[]>([]);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    setRequests([]);setError('');
    void accountFetch('/api/website-ownership/requests').then(async response=>{
      const body=await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load website requests.');
      if(active) setRequests(body.requests);
    }).catch(reason=>{if(active) setError(String(reason.message));});
    return ()=>{active=false;};
  },[workspaceId]);
  return <section className="panel account-panel"><h2>Website requests</h2>
    <p>Review access requests and use Invite teammates below to issue an invitation after confirming the requester. Disputes require platform review; no request transfers ownership automatically.</p>
    {error && <p role="alert">{error}</p>}
    {requests.length===0 && !error && <p>No website requests.</p>}
    {requests.map(request=><article key={request.id}><h3>{request.kind==='dispute'?'Ownership dispute':'Access request'}: {request.url}</h3><p>{request.requester_email}</p><p>{request.message}</p></article>)}
  </section>;
}
