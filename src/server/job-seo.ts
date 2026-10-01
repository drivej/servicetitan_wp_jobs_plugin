export interface SafeJobSeoDetails {
  issue?: string;
  action?: string;
}

export function extractSafeSeoDetails(summary: string | undefined): SafeJobSeoDetails {
  const text = (summary || '').toLowerCase();
  const issue = firstMatch(text, [
    [/(?:clog|stoppage|blocked|backup)/, 'a blocked or slow drain'],
    [/(?:no hot water|not heating|cold water)/, 'a hot-water performance issue'],
    [/(?:leak|leaking|drip)/, 'a plumbing leak'],
    [/(?:low pressure|water pressure)/, 'a water-pressure issue'],
  ]);
  const action = firstMatch(text, [
    [/(?:replac|new unit)/, 'component replacement'],
    [/(?:repair|repaired|fix|fixed)/, 'targeted repairs'],
    [/(?:flush|maintenance|tune.?up|service)/, 'preventive maintenance'],
    [/(?:install|installation)/, 'professional installation'],
    [/(?:inspect|diagnos|evaluat)/, 'professional diagnosis'],
  ]);

  return {
    ...(issue ? { issue } : {}),
    ...(action ? { action } : {}),
  };
}

export function normalizeServiceName(value: string): string {
  const withoutDuration = value.replace(/\s*\([^)]*(?:hr|hour|min)[^)]*\)\s*/gi, ' ').trim();
  if (/stoppage|clog|drain/i.test(withoutDuration)) return 'Drain Clearing';
  return withoutDuration || 'Home Service';
}

export function serviceGuidance(serviceName: string): string {
  const service = serviceName.trim().toLowerCase();
  if (service.includes('tankless') && service.includes('water heater')) {
    return 'Professional tankless water heater service helps restore dependable hot water and identify performance concerns before they become larger problems.';
  }
  if (service.includes('water heater')) {
    return 'Professional water heater service supports reliable hot water, efficient operation, and early identification of developing equipment problems.';
  }
  if (service.includes('drain')) {
    return 'Professional drain service addresses flow problems while helping identify conditions that may cause recurring blockages.';
  }
  if (service.includes('toilet')) {
    return 'Professional toilet service can resolve leaks, flushing problems, and other issues that waste water or disrupt daily use.';
  }
  if (service.includes('faucet')) {
    return 'Professional faucet service can correct leaks and performance problems while helping prevent unnecessary water waste.';
  }
  const alreadyNamesService = /\bservices?$/.test(service);
  const servicePhrase = alreadyNamesService ? service : `${service} service`;
  const verb = service.endsWith('services') ? 'help' : 'helps';
  return `Professional ${servicePhrase} ${verb} address the immediate concern and identify related maintenance needs.`;
}

function firstMatch(text: string, rules: Array<[RegExp, string]>): string | undefined {
  return rules.find(([pattern]) => pattern.test(text))?.[1];
}
