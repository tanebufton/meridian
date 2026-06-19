export default function StatusBadge({ status }) {
  const map = {
    UP: 'badge-up',
    DEGRADED: 'badge-degraded',
    DOWN: 'badge-down',
    UNKNOWN: 'badge-unknown',
  };
  return <span className={`badge ${map[status] || 'badge-unknown'}`}>{status || 'UNKNOWN'}</span>;
}
