// Small formatting helpers shared by admin pages

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtAgo(ts) {
  if (!ts) return '—';
  return `${fmtDuration(Math.floor(Date.now() / 1000) - ts)} ago`;
}

export const fmtDateTime = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '—');

// <input type="datetime-local"> works in local time without a zone
export function toLocalInput(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000);

export const PROBE_TYPES = [
  { value: 'icmp', label: 'ICMP (ping)', hint: 'Hostname or IPv4/IPv6 address', example: '8.8.8.8' },
  { value: 'icmp6', label: 'ICMPv6 (ping, IPv6 only)', hint: 'Hostname or IPv6 address', example: '2606:4700:4700::1111' },
  { value: 'dns', label: 'DNS resolution', hint: 'Hostname to resolve', example: 'example.com' },
  { value: 'tcp', label: 'TCP port', hint: 'host:port — IPv6 as [addr]:port', example: 'example.com:443' },
  { value: 'http', label: 'HTTP(S) request', hint: 'Full URL. 2xx/3xx = up, anything else = down', example: 'https://example.com/health' },
];
