export interface ApiHealthCheck {
  name: string;
  endpoint: string;
  state: 'available' | 'unavailable' | 'not_checked';
  message: string;
  statusCode?: number;
  durationMs?: number;
}
export interface ApiHealthReport { checkedAt: string; checks: ApiHealthCheck[]; }
