export function AppNavigation({ current, jobsHref = '/' }: { current: 'jobs' | 'plugin' | 'guide' | undefined; jobsHref?: string }) {
  return (
    <nav className="app-nav" aria-label="Application">
      <a href={jobsHref} aria-current={current === 'jobs' ? 'page' : undefined}>Jobs</a>
      <a href="/wordpress-plugin" aria-current={current === 'plugin' ? 'page' : undefined}>Plugin</a>
      <a href="/wordpress-integration" aria-current={current === 'guide' ? 'page' : undefined}>Help</a>
    </nav>
  );
}
