import { lookup } from 'node:dns';
import { Agent, fetch as httpFetch } from 'undici';
import { publicAddress, websiteUrl } from './validation.js';

// Validation happens in the socket lookup, not in a separate DNS preflight.
// This pins each connection to the checked answer and prevents DNS rebinding.
const dispatcher = new Agent({
  connections: 4,
  connect: {
    timeout: 10_000,
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (error) { callback(error, [], 0); return; }
        if (!addresses.length || addresses.some((item) => !publicAddress(item.address))) {
          callback(new Error('WordPress must resolve only to public IP addresses.'), [], 0); return;
        }
        const compatible = options.family ? addresses.filter((item) => item.family === options.family) : addresses;
        if (!compatible.length) { callback(new Error('No compatible public address.'), [], 0); return; }
        if (options.all) callback(null, compatible);
        else callback(null, compatible[0]!.address, compatible[0]!.family);
      });
    },
  },
});

export const publicFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  websiteUrl(url.origin);
  if (url.username || url.password) throw new Error('Credentials in remote URLs are forbidden.');
  // Never forward integration credentials through a redirect, including same-host redirects.
  return await httpFetch(url, { ...init, redirect: 'error', dispatcher } as Parameters<typeof httpFetch>[1]) as unknown as Response;
};
export const closePublicFetch = (): Promise<void> => dispatcher.close();
