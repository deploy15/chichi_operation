// Talks to the Node.js server. Adds the sign-in token and turns errors into readable messages.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.offline = status === 0;
  }
}

export async function request(method, path, body) {
  const token = localStorage.getItem('token');
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'No connection to the server. You appear to be offline.');
  }
  if (res.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new Event('auth-expired'));
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

export const qs = (obj) => {
  const s = new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Downloads a protected file (needs the sign-in token, so a plain link will not work)
export async function openFile(path, fileName) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
  if (!res.ok) throw new ApiError(res.status, 'Could not open the file');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'file';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
