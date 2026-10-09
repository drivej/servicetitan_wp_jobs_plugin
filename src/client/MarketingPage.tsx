import { useEffect, useState } from 'react';

interface Plan {
  name: string;
  amount: number;
  currency: string;
  tokens: number;
  maxTokens: number;
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
}

const period = (plan: Plan) => plan.intervalCount === 1 ? plan.interval : `${plan.intervalCount} ${plan.interval}s`;
const money = (amount: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);

export function MarketingPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [pricingError, setPricingError] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch('/api/public/plans').then(async (response) => {
      if (!response.ok) throw new Error('Pricing unavailable');
      return response.json() as Promise<{ plans: Plan[] }>;
    }).then((body) => { if (active) setPlans(body.plans); }).catch(() => { if (active) setPricingError(true); });
    return () => { active = false; };
  }, []);

  return <main className="marketing-page">
    <header className="marketing-nav">
      <a className="marketing-brand" href="/" aria-label="Job Showcase for ServiceTitan home"><span className="brand-mark">J</span> Job Showcase for ServiceTitan</a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a><a className="nav-signin" href="/auth/google">Sign in <span aria-hidden="true">↗</span></a></nav>
    </header>

    <section className="marketing-hero">
      <div className="hero-copy">
        <p className="marketing-eyebrow"><span className="live-dot" /> BUILT FOR SERVICE TITAN + WORDPRESS</p>
        <h1>Your best work deserves to be <em>seen.</em></h1>
        <p className="hero-description">Turn completed ServiceTitan jobs into polished, local WordPress stories. Less copy-and-paste. More proof of the work you do.</p>
        <div className="hero-actions"><a className="marketing-cta" href="/auth/google">Get started <span aria-hidden="true">→</span></a><a className="text-link" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a></div>
        <div className="hero-proof"><div className="proof-avatars" aria-hidden="true"><span>ST</span><span>WP</span><span>AI</span></div><p>From completed job to publish-ready story<br/><strong>in one connected workflow.</strong></p></div>
      </div>
      <div className="hero-visual" aria-label="Illustration of local service stories moving from ServiceTitan into WordPress">
        <div className="visual-orbit orbit-one"/><div className="visual-orbit orbit-two"/>
        <div className="job-card visual-card">
          <div className="job-card-top"><span className="tiny-label">RECENTLY COMPLETED</span><span className="status-pill"><i/> Complete</span></div>
          <div className="job-house">⌂</div>
          <p className="job-type">HVAC · REPLACEMENT</p><h3>Comfort, restored.</h3><p className="job-location">North Park, San Diego <span>·</span> 92104</p>
          <div className="card-rule"/><div className="job-meta"><span>Job #<b>10482</b></span><span>Published <b className="published">↗ WordPress</b></span></div>
        </div>
        <div className="floating-note note-top"><span className="note-icon">✦</span><span><b>Local SEO ready</b><small>Service + location content</small></span></div>
        <div className="floating-note note-bottom"><span className="note-check">✓</span><span><b>One less thing to chase</b><small>From job record to live post</small></span></div>
        <span className="visual-caption">GOOD WORK, OUT IN THE WORLD.</span>
      </div>
    </section>

    <section className="marketing-strip" aria-label="Product highlights"><span>MADE FOR LOCAL SERVICE BUSINESSES</span><i/> <b>ServiceTitan jobs</b><i/> <b>WordPress publishing</b><i/> <b>AI-assisted copy</b></section>

    <section className="value-section" id="how-it-works">
      <div className="section-heading"><p className="marketing-eyebrow">A BETTER WAY TO SHOW THE WORK</p><h2>From the field to <em>found online.</em></h2><p>Your completed jobs already tell the story. Bring that proof to the place customers are searching.</p></div>
      <div className="value-grid">
        <article className="value-card"><span className="feature-number">01</span><div className="feature-icon icon-calendar">▦</div><h3>Find the right jobs, fast.</h3><p>Browse completed work by date and ZIP code. Pick the projects that deserve a place on your site.</p></article>
        <article className="value-card"><span className="feature-number">02</span><div className="feature-icon icon-spark">✳</div><h3>Make every job a story.</h3><p>Build polished service pages with AI-assisted copy, project details, and a local-search focus.</p></article>
        <article className="value-card"><span className="feature-number">03</span><div className="feature-icon icon-arrow">↗</div><h3>Publish without the busywork.</h3><p>Send the finished post to WordPress, keep its status in view, and update it when the story changes.</p></article>
      </div>
    </section>

    <section className="process-section"><div className="process-copy"><p className="marketing-eyebrow">SIMPLE BY DESIGN</p><h2>Good work in.<br/><em>Great stories out.</em></h2><p>Keep your team in the tools they already know. Choose a job, shape the story, and publish it to WordPress when it is ready.</p><a className="inline-link" href="/help">Explore the setup guide <span>→</span></a></div><div className="process-flow"><div className="flow-node"><span className="flow-symbol titan-symbol">T</span><span><b>ServiceTitan</b><small>Choose completed jobs</small></span><span className="flow-check">✓</span></div><div className="flow-connector"><i/><i/><i/></div><div className="flow-node"><span className="flow-symbol copy-symbol">✦</span><span><b>Job story</b><small>Review details + copy</small></span><span className="flow-check">✓</span></div><div className="flow-connector"><i/><i/><i/></div><div className="flow-node"><span className="flow-symbol wp-symbol">W</span><span><b>Your WordPress site</b><small>Publish when it is ready</small></span><span className="flow-check">✓</span></div><p className="flow-footnote">You stay in control at every step.</p></div></section>

    <section className="pricing-section" id="pricing"><div className="pricing-head"><div><p className="marketing-eyebrow">STRAIGHTFORWARD SUBSCRIPTION</p><h2>Clear pricing.<br/><em>Useful work.</em></h2></div><p>Every plan is a recurring subscription with a set number of job tokens. Choose what fits your publishing pace.</p></div>
      {plans && plans.length > 0 ? <div className="public-plan-grid">{plans.map((plan, index) => <article className={`public-plan${index === 1 ? ' featured-plan' : ''}`} key={`${plan.name}-${plan.amount}`}>
        {index === 1 && <span className="plan-badge">MOST POPULAR</span>}<h3>{plan.name}</h3><p className="plan-price">{money(plan.amount, plan.currency)}<small> / {period(plan)}</small></p><p className="plan-token-count"><strong>{plan.tokens.toLocaleString()}</strong> job tokens <span>per {period(plan)}</span></p><div className="plan-divider"/><ul><li>Build, publish, or refresh job stories</li><li>Unused tokens roll over</li><li>Balance capped at {plan.maxTokens.toLocaleString()} tokens</li></ul><a className={index === 1 ? 'marketing-cta' : 'plan-cta'} href="/auth/google">Choose {plan.name} <span>→</span></a>
      </article>)}</div> : <div className="pricing-state">{pricingError ? <><strong>We couldn’t load live pricing just now.</strong><span>Sign in to view the current plans before choosing one.</span></> : <><span className="pricing-loader"/><span>Loading current plans…</span></>}</div>}
      <p className="pricing-footnote">No charge until you choose a plan and confirm payment at checkout. Generate Copy, Build, and Update each use one token. Publishing a draft and checking or changing a post’s status are free. Taxes, if applicable, are shown at checkout.</p>
    </section>

    <section className="closing-cta"><div><p className="marketing-eyebrow">YOUR NEXT GREAT PROJECT STORY</p><h2>Let the work speak<br/><em>for itself.</em></h2></div><a className="marketing-cta" href="/auth/google">Get started with Google <span>→</span></a></section>
    <footer className="marketing-footer"><a className="marketing-brand" href="/"><span className="brand-mark">J</span> Job Showcase for ServiceTitan</a><span>Turn completed work into a local story.</span><div><a href="/help">Setup guide</a><a href="#pricing">Pricing</a><a href="/auth/google">Sign in</a></div></footer>
  </main>;
}
