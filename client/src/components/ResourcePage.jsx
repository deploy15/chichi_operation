// A standard list screen with search, filters and add/edit pop-ups for one kind of record.
import { useState } from 'react';
import { api, qs } from '../lib/api';
import { EntityForm, ErrorMsg, Field, Modal, Table, useLoad, clearOptionCache } from './ui';

export default function ResourcePage({
  endpoint, columns, fields, canManage, canDelete, filters = [], search = true, noun = 'record',
  newDefaults = {}, onRowClick, toForm = (r) => r, extraFilters = {}, rowActions, emptyText, beforeTable,
}) {
  const [q, setQ] = useState('');
  const [filterValues, setFilterValues] = useState({});
  const [editing, setEditing] = useState(null); // null | {} (new) | row
  const [deleteError, setDeleteError] = useState(null);
  const params = { q, ...filterValues, ...extraFilters };
  const list = useLoad(() => api.get(`${endpoint}${qs(params)}`), [endpoint, JSON.stringify(params)]);

  const save = async (data) => {
    if (editing.id) await api.put(`${endpoint}/${editing.id}`, data);
    else await api.post(endpoint, data);
    clearOptionCache();
    setEditing(null);
    list.reload();
  };
  const remove = async () => {
    if (!window.confirm(`Delete this ${noun}? This cannot be undone.`)) return;
    try {
      await api.del(`${endpoint}/${editing.id}`);
      clearOptionCache();
      setEditing(null);
      list.reload();
    } catch (e) {
      setDeleteError(e);
    }
  };

  const cols = rowActions ? [...columns, { key: '_actions', label: '', render: (r) => <span onClick={(e) => e.stopPropagation()}>{rowActions(r, list.reload)}</span> }] : columns;

  return (
    <div>
      <div className="toolbar">
        {search && <input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />}
        {filters.map((f) => (
          <div key={f.name} className="toolbar-filter">
            <Field field={{ ...f, required: false, emptyLabel: `All ${f.label.toLowerCase()}` }} value={filterValues[f.name]}
              onChange={(v) => setFilterValues((s) => ({ ...s, [f.name]: v }))} />
          </div>
        ))}
        <div className="spacer" />
        {canManage && <button className="btn" onClick={() => setEditing({ ...newDefaults })}>+ Add {noun}</button>}
      </div>
      {beforeTable}
      <ErrorMsg error={list.error} />
      <Table columns={cols} rows={list.data} empty={emptyText}
        onRowClick={onRowClick || (canManage ? (r) => { setDeleteError(null); setEditing(r); } : undefined)} />
      {editing && (
        <Modal title={editing.id ? `Edit ${noun}` : `New ${noun}`} onClose={() => setEditing(null)} wide={fields.length > 6}>
          <EntityForm fields={fields} initial={editing.id ? toForm(editing) : editing} onSubmit={save} onCancel={() => setEditing(null)} />
          {editing.id && canDelete && (
            <div className="danger-zone">
              <ErrorMsg error={deleteError} />
              <button className="btn btn-danger-ghost" onClick={remove}>Delete {noun}</button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
