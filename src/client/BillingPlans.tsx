import { Button, CircularProgress, Dialog } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { accountFetch } from './api';
interface Plan { id: string; name: string; amount: number; currency: string; tokens: number; maxTokens: number; interval: 'day' | 'week' | 'month' | 'year'; intervalCount: number; }
interface Billing { plans: Plan[]; testPlan: Plan | null; canManage: boolean; hasCustomer: boolean; subscription: { status: string; cancelAtPeriodEnd: boolean; priceId: string } | null; }
const billingPeriod = (plan: Plan) => plan.intervalCount === 1 ? plan.interval : `${plan.intervalCount} ${plan.interval}s`;
async function result<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Unable to load billing.');
  return body as T;
}
export function BillingPlans({ workspaceId }: { workspaceId: string }) {
  const [billing, setBilling] = useState<Billing>();
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<'checkout' | 'portal' | null>(null);
  const opening = useRef(false);
  const busy = pendingAction !== null;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void accountFetch('/api/billing').then(result<Billing>).then((value) => { if (active) setBilling(value); }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [workspaceId, revision]);
  const redirect = async (kind: 'checkout' | 'portal', priceId?: string) => {
    if (opening.current) return;
    opening.current = true;
    setPendingAction(kind); setError('');
    try {
      const { url } = await accountFetch(`/api/billing/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priceId }) }).then(result<{ url: string }>);
      window.location.assign(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to open billing.'); opening.current = false; setPendingAction(null); }
  };
  const checkout = new URLSearchParams(window.location.search).get('checkout');
  const availablePlans = billing ? [...billing.plans, ...(billing.testPlan ? [billing.testPlan] : [])] : [];
  return <section className='billing-plans' aria-label='Subscription plans' aria-busy={busy}>
    <Dialog open={busy} className='billing-loading-dialog' aria-labelledby='billing-loading-title' aria-describedby='billing-loading-description'>
      <div className='billing-loading-content'>
        <CircularProgress aria-hidden='true' />
        <h2 id='billing-loading-title'>{pendingAction === 'portal' ? 'Opening billing…' : 'Opening Checkout…'}</h2>
        <p id='billing-loading-description'>Please wait while we connect you to Stripe.</p>
      </div>
    </Dialog>
    {checkout === 'success' && <p className='notice' role='status'>Checkout finished. Your balance updates after payment is confirmed. <Button onClick={() => { setRevision((v) => v + 1); window.dispatchEvent(new Event('job-tokens-changed')); }}>Refresh balance</Button></p>}
    {checkout === 'canceled' && <p className='notice'>Checkout canceled. Choose a plan below to start again.</p>}
    {error && <p className='notice error' role='alert'>{error} <Button disabled={busy} onClick={() => setRevision((v) => v + 1)}>Retry</Button></p>}
    {!billing && !error && <p role='status'>Loading subscription plans…</p>}
    {billing && <>
      {!billing.canManage && <p>The workspace owner manages subscriptions and billing.</p>}
      {billing.subscription && <p>Subscription: <strong>{billing.subscription.status.replaceAll('_', ' ')}</strong>{billing.subscription.cancelAtPeriodEnd ? ' · Cancels at the end of the billing period.' : ''}</p>}
      {!billing.subscription && <p className='notice' role='status'>This workspace has no active subscription. Complete Checkout to open Jobs.</p>}
      {billing.canManage && billing.hasCustomer && <Button disabled={busy} onClick={() => void redirect('portal')}>Manage billing</Button>}
      <div className='billing-plan-grid'>{availablePlans.map((plan) => <article className='panel account-panel' key={plan.id}>
        {plan.id === billing.testPlan?.id && <p className='eyebrow'>Testing</p>}
        <h3>{plan.id === billing.testPlan?.id ? 'Free test subscription' : plan.name}</h3>
        <p className='billing-plan-price'>{new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency }).format(plan.amount / 100)}<small> / {billingPeriod(plan)}</small></p>
        <p><strong>{plan.tokens.toLocaleString()}</strong> job tokens every {billingPeriod(plan)}</p>
        <p>Unused tokens roll over, up to {plan.maxTokens.toLocaleString()} total.</p>
        {plan.id === billing.testPlan?.id && <p className='field-help'>Uses Stripe Checkout. Tokens arrive after Stripe confirms the zero-cost invoice.</p>}
        {billing.subscription?.priceId === plan.id ? <p className='notice'>Current plan</p> : !billing.subscription && billing.canManage ? <Button variant='contained' className='primary' disabled={busy} onClick={() => void redirect('checkout', plan.id)}>{plan.id === billing.testPlan?.id ? 'Start free test subscription' : 'Subscribe'}</Button> : null}
      </article>)}</div>
      <p className='field-help'>Tokens are added after Stripe confirms each subscription invoice. Plan changes are not available yet.</p>
    </>}
  </section>;
}
