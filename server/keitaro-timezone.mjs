// Only a current-user profile is authoritative. Never guess from server time,
// HTTP Date, a list of users, or the timezone of an advertising account.
export function profileTimezone(raw) {
  const profile = raw?.data ?? raw;
  const tz = profile?.preferences?.timezone;
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 100) return null;
  try {
    new Intl.DateTimeFormat('en', {timeZone: tz});
    return tz;
  } catch { return null; }
}

// Send only the observed read command, never profile.update.
export const profileReadBatch = [{method: 'GET', path: '', params: {object: 'profile.show'}}];
export function batchProfileTimezone(raw) {
  if (!Array.isArray(raw) || raw.length !== 1) return null;
  const item = raw[0];
  const status = item?.status ?? item?.code;
  if (status != null && Number(status) !== 200) return null;
  let body = item?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  return profileTimezone(body);
}
