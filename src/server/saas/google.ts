import * as oidc from 'openid-client';
import type { SaaSConfig } from './config.js';
import type { Identity } from './store.js';
import { HttpError } from './validation.js';

export interface GoogleLogin {
  authorization(state: string, nonce: string, verifier: string): Promise<string>;
  exchange(url: URL, state: string, nonce: string, verifier: string): Promise<Identity>;
}
export class GoogleOIDC implements GoogleLogin {
  private configuration: Promise<oidc.Configuration> | undefined;
  constructor(private readonly settings: Pick<SaaSConfig, 'origin' | 'googleClientId' | 'googleClientSecret'>) {}
  private config(): Promise<oidc.Configuration> {
    this.configuration ??= oidc.discovery(new URL('https://accounts.google.com'), this.settings.googleClientId,
      this.settings.googleClientSecret, undefined, { timeout: 15, execute: [oidc.enableNonRepudiationChecks] })
      .catch((error: unknown) => { this.configuration = undefined; throw error; });
    return this.configuration;
  }
  async authorization(state: string, nonce: string, verifier: string): Promise<string> {
    return oidc.buildAuthorizationUrl(await this.config(), {
      redirect_uri: `${this.settings.origin}/auth/google/callback`, scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
    }).toString();
  }
  async exchange(url: URL, state: string, nonce: string, verifier: string): Promise<Identity> {
    const tokens = await oidc.authorizationCodeGrant(await this.config(), url, {
      expectedState: state, expectedNonce: nonce, pkceCodeVerifier: verifier, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255
      || typeof claims.email !== 'string' || claims.email_verified !== true) {
      throw new HttpError('A verified Google email is required.', 403);
    }
    return { subject: claims.sub, email: claims.email,
      name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : claims.email,
      ...(typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? { avatarUrl: claims.picture } : {}) };
  }
}
