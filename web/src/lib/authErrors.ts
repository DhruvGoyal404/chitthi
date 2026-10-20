import type { Provider } from './types.js';

export const providerName = (p: string | null): string => (p === 'google' ? 'Google' : p === 'github' ? 'GitHub' : 'the provider');

/** Calm, specific words for the ?error= codes the API's OAuth callback redirects with. */
export function signInError(code: string | null, provider: string | null): string | undefined {
  if (!code) return undefined;
  const name = providerName(provider);
  switch (code) {
    case 'cancelled': return 'Sign-in was cancelled. You can try again whenever you like.';
    case 'state_mismatch':
    case 'state_invalid': return 'That sign-in link expired or was opened in a different browser. Please start again.';
    case 'email_unverified': return `Your ${name} email address isn't verified. Verify it with ${name}, then try again.`;
    case 'account_exists': return `An account already uses this email. Sign in the way you did before, then link ${name} from the Account page.`;
    case 'account_disabled': return 'This account has been deleted.';
    case 'signup_expired': return 'That sign-in took too long and expired. Please start again.';
    default: return `We couldn't confirm your sign-in with ${name}. Please try again.`;
  }
}

/** The same, for linking a provider from the Account page. */
export function linkError(code: string | null, provider: string | null): string | undefined {
  if (!code) return undefined;
  const name = providerName(provider);
  switch (code) {
    case 'identity_in_use': return `That ${name} account is already linked to a different Chitthi account.`;
    case 'provider_already_linked': return `This account already has a ${name} sign-in linked.`;
    case 'account_exists': return `That ${name} email belongs to a different Chitthi account.`;
    case 'link_session_changed': return 'You were signed out while linking. Please try again.';
    default: return signInError(code, provider);
  }
}

export const PROVIDERS: Provider[] = ['google', 'github'];
