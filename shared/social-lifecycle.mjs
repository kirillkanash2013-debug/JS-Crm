export const SOCIAL_LIFECYCLE = Object.freeze({
  ACTIVE: 'active',
  NEEDS_AUTH: 'needs_auth',
  DISCONNECTED: 'disconnected'
});

export const AUTH_ISSUE_REASON = Object.freeze({
  SELFIE: 'selfie',
  CHECKPOINT: 'checkpoint',
  VERIFICATION_REQUIRED: 'verification_required',
  EXPIRED_SESSION: 'expired_session',
  INVALID_TOKEN: 'invalid_token',
  WRONG_IDENTITY: 'wrong_identity',
  UNKNOWN_AUTH_ERROR: 'unknown_auth_error'
});

const STATUSES = new Set(Object.values(SOCIAL_LIFECYCLE));
const AUTH_REASONS = new Set(Object.values(AUTH_ISSUE_REASON));

export function normalizeLifecycleStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return STATUSES.has(status) ? status : SOCIAL_LIFECYCLE.ACTIVE;
}

export function normalizeAuthIssueReason(value) {
  if (value == null || value === '') return null;
  const reason = String(value).trim().toLowerCase();
  return AUTH_REASONS.has(reason) ? reason : AUTH_ISSUE_REASON.UNKNOWN_AUTH_ERROR;
}

export function isActiveSocial(value) {
  return normalizeLifecycleStatus(value) === SOCIAL_LIFECYCLE.ACTIVE;
}

// Only confirmed user-action/auth problems move a social out of the active set.
// Transient transport/provider failures deliberately remain `active`.
export function lifecycleForFailure(code, current = SOCIAL_LIFECYCLE.ACTIVE) {
  const status = normalizeLifecycleStatus(current);
  if (status === SOCIAL_LIFECYCLE.DISCONNECTED) return {status, authIssueReason: null};

  const c = String(code || '').trim().toLowerCase();
  const map = new Map([
    ['selfie', AUTH_ISSUE_REASON.SELFIE],
    ['checkpoint', AUTH_ISSUE_REASON.CHECKPOINT],
    ['verification_required', AUTH_ISSUE_REASON.VERIFICATION_REQUIRED],
    ['expired_session', AUTH_ISSUE_REASON.EXPIRED_SESSION],
    ['invalid_token', AUTH_ISSUE_REASON.INVALID_TOKEN],
    ['provider_190', AUTH_ISSUE_REASON.INVALID_TOKEN],
    ['provider_102', AUTH_ISSUE_REASON.INVALID_TOKEN],
    ['identity', AUTH_ISSUE_REASON.WRONG_IDENTITY],
    ['wrong_identity', AUTH_ISSUE_REASON.WRONG_IDENTITY],
    ['needs_auth', AUTH_ISSUE_REASON.UNKNOWN_AUTH_ERROR]
  ]);
  const authIssueReason = map.get(c);
  if (!authIssueReason) return {status, authIssueReason: null};
  return {status: SOCIAL_LIFECYCLE.NEEDS_AUTH, authIssueReason};
}

export function lifecycleAfterValidatedCollection() {
  return {status: SOCIAL_LIFECYCLE.ACTIVE, authIssueReason: null};
}

export function lifecycleAfterDisconnect() {
  return {status: SOCIAL_LIFECYCLE.DISCONNECTED, authIssueReason: null};
}
