// Shared screen building blocks: tables, forms, pop-up windows, badges, simple charts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { label, fmtDate, fmtDateTime } from '../lib/format';

export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return Promise.resolve(fnRef.current())
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => setState({ data: null, error, loading: false }));
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, deps);
  return { ...state, reload };
}

const optionCache = new Map();
// Loads drop-down choices from the server, e.g. useOptions('/structure/clients', (c) => ({ value: c.id, label: c.name }))
export function useOptions(endpoint, map) {
  const [options, setOptions] = useState(() => optionCache.get(endpoint) || []);
  useEffect(() => {
    if (!endpoint) return;
    let alive = true;
    api.get(endpoint).then((rows) => {
      const o = rows.map(map);
      optionCache.set(endpoint, o);
      if (alive) setOptions(o);
    }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);
  return options;
}
export const clearOptionCache = () => optionCache.clear();

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', children, onClose }) {
  if (!children) return null;
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div>{children}</div>
      {onClose && <button className="link" onClick={onClose} aria-label="Close">×</button>}
    </div>
  );
}

export function ErrorMsg({ error }) {
  if (!error) return null;
  return <Alert tone="error">{error.message || String(error)}</Alert>;
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

const TONES = {
  active: 'green', present: 'green', applied: 'green', done: 'green', closed: 'grey', completed: 'green', available: 'green', fit: 'green', received: 'green',
  absent: 'red', critical: 'red', unfit: 'red', high: 'orange', suspended: 'orange', maintenance: 'orange', under_investigation: 'orange', in_progress: 'blue',
  open: 'orange', pending: 'orange', conflict: 'red', rejected: 'red', failed: 'red', medium: 'yellow', low: 'blue', temporary: 'purple', central: 'blue',
  ended: 'grey', inactive: 'grey', terminated: 'grey', cancelled: 'grey', draft: 'grey', scheduled: 'blue', dispatched: 'blue', fit_with_restrictions: 'yellow',
};
export function Badge({ value, tone }) {
  if (value === null || value === undefined || value === '') return null;
  return <span className={`badge badge-${tone || TONES[value] || 'grey'}`}>{label(value)}</span>;
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="link close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ field, value, onChange, disabled }) {
  const { name, type = 'text', options = [], required, placeholder, min, step } = field;
  const id = `f-${name}`;
  const common = { id, name, disabled, required, placeholder };
  let input;
  if (type === 'select') {
    input = (
      <select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.emptyLabel || '— Select —'}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (type === 'textarea') {
    input = <textarea {...common} rows={field.rows || 3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  } else if (type === 'checkbox') {
    return (
      <label className="check">
        <input type="checkbox" id={id} checked={!!Number(value) || value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  } else if (type === 'checkboxes') {
    const set = new Set(value || []);
    return (
      <fieldset className="field">
        <legend>{field.label}</legend>
        <div className="check-row">
          {options.map((o) => (
            <label key={o.value} className="check">
              <input type="checkbox" checked={set.has(o.value)} disabled={disabled}
                onChange={(e) => { const n = new Set(set); if (e.target.checked) n.add(o.value); else n.delete(o.value); onChange([...n]); }} />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  } else {
    let v = value ?? '';
    if (type === 'datetime-local' && v) v = String(v).replace(' ', 'T').slice(0, 16);
    input = <input {...common} type={type} min={min} step={step || (type === 'number' ? 'any' : undefined)} value={v} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={`field ${field.wide ? 'field-wide' : ''}`}>
      <label htmlFor={id}>{field.label}{required && <span className="req"> *</span>}</label>
      {input}
      {field.help && <small className="muted">{field.help}</small>}
    </div>
  );
}

// A complete form: fields, error message, save/cancel buttons.
export function EntityForm({ fields, initial = {}, onSubmit, onCancel, submitLabel = 'Save', disabled }) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = {};
      for (const f of fields) if (!f.hidden && !f.readOnly) out[f.name] = values[f.name] === undefined ? null : values[f.name];
      await onSubmit(out, values);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const visible = fields.filter((f) => !f.hidden && (!f.showIf || f.showIf(values)));
  return (
    <form onSubmit={submit} className="form">
      <ErrorMsg error={error} />
      <div className="form-grid">
        {visible.map((f) => (
          <Field key={f.name} field={f} value={values[f.name]} disabled={disabled || f.readOnly}
            onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
        ))}
      </div>
      {!disabled && (
        <div className="form-actions">
          {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      )}
    </form>
  );
}

export function cell(row, col) {
  if (col.render) return col.render(row);
  const v = row[col.key];
  if (col.type === 'badge') return <Badge value={v} />;
  if (col.type === 'date') return fmtDate(v);
  if (col.type === 'datetime') return fmtDateTime(v);
  if (col.type === 'bool') return Number(v) ? 'Yes' : '';
  if (col.type === 'label') return label(v);
  return v;
}

export function Table({ columns, rows, onRowClick, empty = 'Nothing to show yet.', rowKey = (r) => r.id, rowClass }) {
  if (!rows) return <Loading />;
  if (!rows.length) return <p className="empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key || c.label} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r) ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={`${onRowClick ? 'clickable' : ''} ${rowClass ? rowClass(r) : ''}`}>
              {columns.map((c) => <td key={c.key || c.label} data-label={c.label} className={c.num ? 'num' : ''}>{cell(r, c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'tab active' : 'tab'} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label: l, value, hint, tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{l}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

// Simple horizontal bar chart
export function BarList({ items, valueKey = 'value', format = (v) => v, empty = 'No data yet.' }) {
  if (!items || !items.length) return <p className="empty">{empty}</p>;
  const max = Math.max(...items.map((i) => Number(i[valueKey]) || 0), 1);
  return (
    <ul className="barlist">
      {items.map((i) => (
        <li key={i.label}>
          <span className="bar-label" title={label(i.label)}>{label(i.label)}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(Number(i[valueKey]) / max) * 100}%` }} /></span>
          <span className="bar-value">{format(i[valueKey])}</span>
        </li>
      ))}
    </ul>
  );
}

export function Card({ title, children, actions, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && <div className="card-head">{title && <h2>{title}</h2>}{actions}</div>}
      {children}
    </section>
  );
}
