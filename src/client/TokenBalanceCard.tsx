import { useId } from 'react';

function GoldCoins() {
  const gold = useId();
  return (
    <svg viewBox='0 0 220 180' fill='none' aria-hidden='true' focusable='false'>
      <defs>
        <linearGradient id={gold} x1='70' y1='35' x2='158' y2='145' gradientUnits='userSpaceOnUse'>
          <stop stopColor='#fff0a4' />
          <stop offset='.46' stopColor='#edbd4d' />
          <stop offset='1' stopColor='#c88a21' />
        </linearGradient>
      </defs>
      <ellipse cx='116' cy='153' rx='76' ry='13' fill='#745518' opacity='.1' />
      {[0, 1, 2].map((level) => (
        <g key={level} transform={`translate(0 ${-level * 13})`}>
          <path d='M91 125v13c0 12 24 21 53 21s53-9 53-21v-13' fill='#bf841e' stroke='#aa731c' strokeWidth='2' />
          <path d='M105 135v11m16-7v12m19-10v12m20-13v11m19-17v11' stroke='#e9b647' strokeWidth='3' />
          <ellipse cx='144' cy='125' rx='53' ry='21' fill={`url(#${gold})`} stroke='#d49c31' strokeWidth='2' />
          <ellipse cx='144' cy='125' rx='40' ry='14' stroke='#fff0ae' strokeWidth='2' />
        </g>
      ))}
      <circle cx='77' cy='91' r='53' fill='#af7519' />
      <circle cx='73' cy='86' r='53' fill={`url(#${gold})`} stroke='#d09a2c' strokeWidth='2' />
      <circle cx='73' cy='86' r='43' stroke='#fff3b9' strokeWidth='3' />
      <circle cx='73' cy='86' r='37' stroke='#c98c24' strokeWidth='1.5' strokeDasharray='2 5' />
      <path d='m78 59-22 32h17l-5 23 23-34H74l4-21Z' fill='#946018' />
      <path d='m170 30 3 9 9 3-9 3-3 9-3-9-9-3 9-3 3-9ZM31 15l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z' fill='#c89b35' />
    </svg>
  );
}

export function TokenBalanceCard({ tokens }: { tokens: number }) {
  const empty = tokens <= 0;
  const balance = tokens.toLocaleString();
  const titleId = useId();
  return (
    <section className={`token-balance-card${empty ? ' token-balance-card-empty' : ''}${balance.length > 8 ? ' token-balance-card-large' : ''}`} aria-labelledby={titleId}>
      <div className='token-balance-content'>
        <div className='token-balance-heading'>
          <h2 id={titleId}>Your token balance</h2>
          <span className='token-balance-badge'>{empty ? 'Refill needed' : 'Ready to use'}</span>
        </div>
        <p className='token-balance-amount' aria-live='polite' aria-atomic='true'>
          <strong>{balance}</strong>
          <span>job {tokens === 1 ? 'token' : 'tokens'} available</span>
        </p>
        <p className='token-balance-message'>{empty ? 'Your token reserve is empty.' : 'Ready for your next great post.'}</p>
        <p className='token-balance-description'>{empty
          ? 'Add tokens below to get back to publishing, rebuilding posts, and creating AI descriptions.'
          : 'Put your tokens to work turning completed jobs into your next great posts.'}</p>
      </div>
      <div className='token-balance-art' aria-hidden='true'>
        {empty ? <svg viewBox='0 0 160 160' fill='none' focusable='false'>
          <circle cx='80' cy='80' r='72' fill='#fae3c1' />
          <path d='M70 42c4.5-8 15.5-8 20 0l39 67c4.5 8-1 18-10 18H41c-9 0-14.5-10-10-18l39-67Z' fill='#f6c276' stroke='#a35b20' strokeWidth='3' />
          <path d='M80 65v25' stroke='#743d19' strokeWidth='7' strokeLinecap='round' />
          <circle cx='80' cy='105' r='4' fill='#743d19' />
        </svg> : <GoldCoins />}
      </div>
      <p className='token-balance-note'>1 token per successful action. Failed requests never spend tokens.</p>
    </section>
  );
}
