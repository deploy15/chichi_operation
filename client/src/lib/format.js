// Turns stored values into friendly text for the screen.
export const label = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));

export const todayStr = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export const fmtDateTime = (s) => {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export const fmtNum = (n, digits = 0) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }));
export const fmtMoney = (n) => fmtNum(n, 2);

export const opts = (values) => values.map((v) => ({ value: v, label: label(v) }));

// Server date-times are stored in UTC; this converts one for a local date-time input box
export const utcToLocalInput = (s) => {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
