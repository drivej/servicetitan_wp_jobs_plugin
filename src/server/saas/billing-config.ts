export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  prices: string[];
  development: boolean;
  maxTokens: number;
  freePrice?: string | undefined;
  testTokensEnabled?: boolean;
}
export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig | undefined {
  if (!env.STRIPE_SECRET_KEY?.trim()) return undefined;
  const secretKey = env.STRIPE_SECRET_KEY.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || '';
  if (!/^(sk|rk)_(test|live)_/.test(secretKey) || !webhookSecret.startsWith('whsec_')) throw new Error('Stripe server credentials are invalid.');
  const rawMaxTokens = env.MAX_TOKENS?.trim() || '';
  const maxTokens = Number(rawMaxTokens);
  if (!/^\d+$/.test(rawMaxTokens) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 2_147_483_647) throw new Error('MAX_TOKENS must be a positive integer up to 2147483647.');
  const prices = [1, 2, 3].map((tier) => {
    const id = env[`STRIPE_PRICE_TIER_${tier}`]?.trim() || '';
    if (!id || id.length > 200) throw new Error(`STRIPE_PRICE_TIER_${tier} must be a price ID or lookup key.`);
    return id;
  });
  if (new Set(prices).size !== 3) throw new Error('Stripe tier prices must be distinct.');
  const freePrice = env.STRIPE_PRICE_FREE?.trim() || undefined;
  if (freePrice && (freePrice.length > 200 || prices.includes(freePrice))) throw new Error('STRIPE_PRICE_FREE must be a distinct price ID or lookup key.');
  return { freePrice, testTokensEnabled: env.ENABLE_TEST_TOKENS === 'true', secretKey, webhookSecret, prices, maxTokens, development: env.NODE_ENV !== 'production' };
}
