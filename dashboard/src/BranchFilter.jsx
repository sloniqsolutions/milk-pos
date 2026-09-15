import React, { useEffect, useState } from 'react';

/**
 * "All branches, or this one" — shared by the dashboard's own screens.
 *
 * Written once because three screens need it and a fourth will. Hides itself
 * when there is only one branch to choose between, so a single-shop install is
 * not asked a question with one answer.
 */
export default function BranchFilter({ value, onChange }) {
  const [branches, setBranches] = useState([]);

  useEffect(() => {
    fetch('/api/branches', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : []))
      // Without the list the filter simply does not appear; the screen still
      // loads, showing every branch.
      .catch(() => [])
      .then(rows => setBranches(Array.isArray(rows) ? rows : []));
  }, []);

  if (branches.length < 2) return null;

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        padding: '7px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600,
        cursor: 'pointer', fontFamily: 'inherit',
        background: value ? '#1B4C82' : '#FFFFFF',
        color: value ? '#FFFFFF' : '#374151',
        border: `1px solid ${value ? '#1B4C82' : '#D1D5DB'}`,
      }}
    >
      <option value="">All branches</option>
      {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );
}
