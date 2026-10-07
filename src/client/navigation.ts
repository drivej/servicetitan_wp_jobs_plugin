import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

const navigationEvent = 'workspace-navigation-start';

export function navigateTo(url: string): void {
  window.dispatchEvent(new Event(navigationEvent));
  window.location.assign(url);
}

export function useNavigationLoading(): boolean {
  const [navigating, setNavigating] = useState(false);
  useEffect(() => {
    const start = () => flushSync(() => setNavigating(true));
    const restore = () => setNavigating(false);
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      if (link.getAttribute('href')?.startsWith('#')) return;
      const url = new URL(link.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search && (url.hash || window.location.hash))) return;
      start();
    };
    const submit = (event: SubmitEvent) => {
      const form = event.target;
      if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.method !== 'get' || (form.target && form.target !== '_self')) return;
      if (new URL(form.action).origin === window.location.origin) start();
    };
    document.addEventListener('click', click);
    document.addEventListener('submit', submit);
    window.addEventListener(navigationEvent, start);
    // Browser Back can restore the outgoing page with its loading state intact.
    window.addEventListener('pageshow', restore);
    return () => {
      document.removeEventListener('click', click);
      document.removeEventListener('submit', submit);
      window.removeEventListener(navigationEvent, start);
      window.removeEventListener('pageshow', restore);
    };
  }, []);
  return navigating;
}
