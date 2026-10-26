import type { ApiHealthReport } from '../shared/api-health';

export function serviceTitanActions(report: ApiHealthReport | undefined): { name: string; endpoint: string; action: string }[] {
  return (report?.checks ?? []).filter(check => check.state === 'unavailable').map(check => {
    let action: string;
    if (check.name === 'Authentication' || check.statusCode === 401) {
      action = 'Check the Client ID, client secret, app key, tenant ID, and selected environment, then test again.';
    } else if (check.statusCode === 403) {
      action = `Ask your ServiceTitan administrator to allow read access to ${check.name.toLowerCase()} for this API application and tenant. Save the permission change, allow it to take effect, then test again.`;
    } else if (check.statusCode === 429) {
      action = 'ServiceTitan is limiting requests. Wait a few minutes, then test again.';
    } else if (check.statusCode === 404) {
      action = 'Ask your ServiceTitan administrator to confirm this API is available for your tenant and environment, then test again.';
    } else {
      action = 'Test again in a few minutes. If this check still fails, ask your ServiceTitan administrator or support team to investigate this endpoint.';
    }
    return { name: check.name, endpoint: check.endpoint, action };
  });
}
