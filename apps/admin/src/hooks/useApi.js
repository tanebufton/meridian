import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// Read CSRF token from cookie
function getCsrfToken() {
  const match = document.cookie.match(/csrf_token=([^;]+)/);
  return match ? match[1] : '';
}

export async function apiFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...options.headers };

  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    headers['X-CSRF-Token'] = getCsrfToken();
    if (options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
  }

  const res = await fetch(url, { ...options, headers, credentials: 'same-origin' });

  if (res.status === 401 && window.location.pathname !== '/login') {
    // Session expired — go to the login page
    window.location.href = '/login';
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch('/api/admin/auth/me'),
    retry: false,
  });
}

export function useGroups() {
  return useQuery({ queryKey: ['admin-groups'], queryFn: () => apiFetch('/api/admin/groups') });
}

export function useTargets() {
  return useQuery({ queryKey: ['admin-targets'], queryFn: () => apiFetch('/api/admin/targets') });
}

export function useUsers() {
  return useQuery({ queryKey: ['admin-users'], queryFn: () => apiFetch('/api/admin/users') });
}

export function useSettings() {
  return useQuery({ queryKey: ['admin-settings'], queryFn: () => apiFetch('/api/admin/settings') });
}

export function useNotificationChannels() {
  return useQuery({ queryKey: ['admin-notifications'], queryFn: () => apiFetch('/api/admin/notifications') });
}

// Generic mutation helper
export function useMutate(queryKeysToInvalidate = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ url, method, body }) => apiFetch(url, { method, body }),
    onSuccess: () => {
      queryKeysToInvalidate.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
  });
}

export function useIncidents(status = 'all', limit = 100) {
  return useQuery({
    queryKey: ['admin-incidents', status, limit],
    queryFn: () => apiFetch(`/api/admin/incidents?status=${status}&limit=${limit}`),
    refetchInterval: 30_000,
  });
}

// Just the number of open incidents, for the sidebar badge
export function useOpenIncidentCount() {
  return useQuery({
    queryKey: ['admin-incidents', 'open', 500],
    queryFn: () => apiFetch('/api/admin/incidents?status=open&limit=500'),
    refetchInterval: 30_000,
    select: (rows) => rows.filter((i) => !i.ack_at).length,
  });
}

export function useMaintenance() {
  return useQuery({
    queryKey: ['admin-maintenance'],
    queryFn: () => apiFetch('/api/admin/maintenance'),
    refetchInterval: 30_000,
  });
}

export function useAudit(limit = 100) {
  return useQuery({ queryKey: ['admin-audit', limit], queryFn: () => apiFetch(`/api/admin/audit?limit=${limit}`) });
}

export function useTwoFactor() {
  return useQuery({ queryKey: ['admin-2fa'], queryFn: () => apiFetch('/api/admin/auth/2fa') });
}
