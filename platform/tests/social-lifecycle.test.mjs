import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOCIAL_LIFECYCLE,
  AUTH_ISSUE_REASON,
  isActiveSocial,
  lifecycleForFailure,
  lifecycleAfterValidatedCollection,
  lifecycleAfterDisconnect
} from '../../shared/social-lifecycle.mjs';

test('MVP lifecycle contains active, needs_auth and disconnected only', () => {
  assert.deepEqual(Object.values(SOCIAL_LIFECYCLE).sort(), ['active', 'disconnected', 'needs_auth']);
  assert.equal(Object.values(SOCIAL_LIFECYCLE).includes('paused'), false);
});

test('confirmed auth failures move an active social to needs_auth with a reason', () => {
  assert.deepEqual(lifecycleForFailure('provider_190'), {
    status: 'needs_auth', authIssueReason: AUTH_ISSUE_REASON.INVALID_TOKEN
  });
  assert.deepEqual(lifecycleForFailure('checkpoint'), {
    status: 'needs_auth', authIssueReason: AUTH_ISSUE_REASON.CHECKPOINT
  });
  assert.deepEqual(lifecycleForFailure('identity'), {
    status: 'needs_auth', authIssueReason: AUTH_ISSUE_REASON.WRONG_IDENTITY
  });
});

test('transient failures do not convert a social to needs_auth', () => {
  for (const code of ['proxy_failed', 'container_unavailable', 'rate_limited', 'failed', 'capacity_busy']) {
    assert.deepEqual(lifecycleForFailure(code), {status: 'active', authIssueReason: null});
  }
});

test('successful validation restores active and disconnect is explicit', () => {
  assert.deepEqual(lifecycleAfterValidatedCollection(), {status: 'active', authIssueReason: null});
  assert.deepEqual(lifecycleAfterDisconnect(), {status: 'disconnected', authIssueReason: null});
  assert.equal(isActiveSocial('active'), true);
  assert.equal(isActiveSocial('needs_auth'), false);
  assert.equal(isActiveSocial('disconnected'), false);
});
