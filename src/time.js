// Appointment times are stored as local wall-clock strings ("YYYY-MM-DDTHH:MM")
// in the app's TIMEZONE. This converts one to a UTC Date for reminder scheduling.
const TIMEZONE = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function wallTimeInZone(utcDate, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate);
  const get = (t) => parts.find((p) => p.type === t).value;
  // hour12:false can report midnight as "24:00" of the previous day
  const hour = get('hour') === '24' ? 0 : Number(get('hour'));
  let ms = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  if (get('hour') === '24') ms += 24 * 3600 * 1000;
  return ms;
}

function localToUtc(localStr, timeZone = TIMEZONE) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(localStr)) {
    throw new Error('Expected local time formatted as YYYY-MM-DDTHH:MM');
  }
  const target = Date.parse(localStr.slice(0, 16) + ':00Z'); // wall time treated as UTC
  // Iterate: adjust a UTC guess until its wall time in `timeZone` matches.
  let guess = new Date(target);
  for (let i = 0; i < 3; i++) {
    const diff = target - wallTimeInZone(guess, timeZone);
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

function nowLocalString(timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('weekday')}, ${get('year')}-${get('month')}-${get('day')} ${get('hour') % 24}:${get('minute')}`;
}

module.exports = { localToUtc, nowLocalString, TIMEZONE };
