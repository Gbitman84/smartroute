// Invite-only membership and personal referral links.
// - A new user can join only through an admin's magic link: ?invite=<token>.
// - Anyone else who signs in gets "user doesn't exist".
// - Every member has referral codes (refs) for the public Registration page:
//   "<email name>-<suffix>" and "<short name>-<suffix>" (same random suffix), plus custom ones from the superadmin.
// firestore.rules enforce all of this; the code here only drives the flow.
import { access } from './firebase-config.js';

const INVITE_KEY = 'smartroute.invite';
const RANDOM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const randomStr = (n, chars = RANDOM) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => chars[b % chars.length]).join('');

export const isSuperEmail = (email) => String(email || '').toLowerCase() === access.superadmin;

// ---------------------------------------------------------------- magic link
// Keep ?invite=… across the Google sign-in (popup or redirect) and drop it from the address bar.
export function captureInvite() {
  const url = new URL(location.href);
  const token = url.searchParams.get('invite');
  if (token && /^[A-Za-z0-9]{16,40}$/.test(token)) {
    try { sessionStorage.setItem(INVITE_KEY, token); } catch { /* ignore */ }
  }
  if (url.searchParams.has('invite')) {
    url.searchParams.delete('invite');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  }
  return pendingInvite();
}
export function pendingInvite() { try { return sessionStorage.getItem(INVITE_KEY); } catch { return null; } }
export function clearInvite() { try { sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ } }

// Decide whether this signed-in Google account may use SmartRoute.
// → { state: 'ok' | 'joined' | 'disabled' | 'none' | 'badInvite' | 'error', member, inviter, error }
export async function ensureMember(db, user) {
  const superUser = isSuperEmail(user.email);
  let member;
  try { member = await db.getMember(); }
  catch (error) { return superUser ? { state: 'ok', member: null } : { state: 'error', error }; }

  if (member) return member.disabled && !superUser ? { state: 'disabled', member } : { state: 'ok', member };

  const base = { uid: user.uid, role: 'user', disabled: false, name: user.name || '', email: user.email || '', joinedAt: Date.now(), refSuffix: randomStr(6) };
  if (superUser) {
    member = { ...base, invitedBy: 'superadmin' };
    try { await db.createMember(member); } catch { member = null; } // e.g. rules not deployed yet – retried later
    return { state: 'ok', member };
  }

  const token = pendingInvite();
  if (!token) return { state: 'none' };
  const invite = await db.getInvite(token).catch(() => null);
  if (!invite?.active) { clearInvite(); return { state: 'badInvite' }; }
  member = { ...base, invitedBy: invite.owner, inviteToken: token };
  try { await db.createMember(member); }
  catch (error) { return { state: 'error', error }; }
  clearInvite();
  return { state: 'joined', member, inviter: invite.ownerName || '' };
}

// ---------------------------------------------------------------- referral codes
const slug = (s, max = 30) => String(s || '').toLowerCase().replace(/[^a-z0-9._]/g, '').replace(/^[._]+|[._]+$/g, '').slice(0, max);
export const emailRefName = (email) => slug(String(email || '').split('@')[0]);
// Google first name when it is written in Latin letters ("Gil Bitman" → "gil"); Hebrew names → '' (only the email ref is offered).
export const nameRefName = (fullName) => {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z]{2,20}$/.test(first) ? first.toLowerCase() : '';
};
export const refId = (name, suffix) => `${name}-${suffix}`;
export const registrationUrl = (ref) => `${access.siteUrl}Registration?ref=${encodeURIComponent(ref)}`;
