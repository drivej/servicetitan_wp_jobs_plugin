export function AppNavigation({ current, jobsHref = '/' }: { current: 'jobs' | 'plugin' | 'guide'; jobsHref?: string }) {
  return (
    <nav className="app-nav" aria-label="Application">
      <a href={jobsHref} aria-current={current === 'jobs' ? 'page' : undefined}>Jobs</a>
      <a href="/wordpress-plugin" aria-current={current === 'plugin' ? 'page' : undefined}>WordPress plugin</a>
      <a href="/wordpress-integration" aria-current={current === 'guide' ? 'page' : undefined}>WordPress integration</a>
    </nav>
  );
}
