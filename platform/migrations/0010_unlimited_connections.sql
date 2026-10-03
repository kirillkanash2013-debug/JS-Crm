-- Remove account-count quotas for existing clients; retain all subscriptions/data.
-- 0 means unlimited. Work concurrency remains controlled by GlobalAdmission.
UPDATE tenants SET social_limit=0;
