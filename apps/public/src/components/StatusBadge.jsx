import { STATUS_LABEL } from '../lib';

const CLASS = {
  UP: 'badge-up', DEGRADED: 'badge-degraded', DOWN: 'badge-down', MAINTENANCE: 'badge-maint', UNKNOWN: 'badge-unknown',
};

export default function StatusBadge({ status }) {
  const s = status || 'UNKNOWN';
  return <span className={`badge ${CLASS[s] || 'badge-unknown'}`}>{(STATUS_LABEL[s] || s).toUpperCase()}</span>;
}
