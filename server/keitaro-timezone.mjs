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
