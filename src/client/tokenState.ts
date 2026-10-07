import { useSyncExternalStore } from 'react';

const exhaustedMessage = 'No job tokens available. Add tokens before trying again.';
let availableTokens: number | undefined;
let exhausted = false;
let currentError = '';
let spendVersion = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function setAvailableTokens(count: number) {
  if (availableTokens !== undefined && count < availableTokens) spendVersion += 1;
  availableTokens = count;
  exhausted = count < 1;
  if (count > 0) currentError = '';
  notify();
}

export function useAvailableTokens() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => `${availableTokens ?? ''}:${spendVersion}`, () => ':0');
}

export function useTokenBalance() {
  const snapshot = useAvailableTokens();
  const [countText, versionText] = snapshot.split(':');
  return { count: countText === '' ? undefined : Number(countText), spendVersion: Number(versionText) };
}

export function markTokensExhausted(message = exhaustedMessage) {
  exhausted = true;
  availableTokens = 0;
  currentError = message;
  window.dispatchEvent(new CustomEvent('job-token-error', { detail: message }));
  notify();
}

export function useTokensExhausted() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => exhausted, () => false);
}

export function useTokenError() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => currentError, () => '');
}

export function clearTokenError() {
  currentError = '';
  notify();
}

export function showTokenError() {
  markTokensExhausted();
}

export function tokenErrorMessage() {
  return exhaustedMessage;
}
