import { useQuery } from '@tanstack/react-query';

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export function useSummary() {
  return useQuery({
    queryKey: ['summary'],
    queryFn: () => apiFetch('/api/v1/summary'),
    refetchInterval: 60_000,
  });
}

export function useGroups() {
  return useQuery({
    queryKey: ['groups'],
    queryFn: () => apiFetch('/api/v1/groups'),
    refetchInterval: 60_000,
  });
}

export function useTarget(id) {
  return useQuery({
    queryKey: ['target', id],
    queryFn: () => apiFetch(`/api/v1/targets/${id}`),
    refetchInterval: 60_000,
  });
}

export function useTargetResults(id, range) {
  return useQuery({
    queryKey: ['results', id, range],
    queryFn: () => apiFetch(`/api/v1/targets/${id}/results?range=${range}`),
    refetchInterval: 60_000,
  });
}

export function useTargetUptime(id) {
  return useQuery({
    queryKey: ['uptime', id],
    queryFn: () => apiFetch(`/api/v1/targets/${id}/uptime`),
    refetchInterval: 60_000,
  });
}

export function useTraceroute(id) {
  return useQuery({
    queryKey: ['traceroute', id],
    queryFn: () => apiFetch(`/api/v1/targets/${id}/traceroute`),
    staleTime: 60_000,
  });
}

export function useTracerouteHistory(id) {
  return useQuery({
    queryKey: ['traceroute-history', id],
    queryFn: () => apiFetch(`/api/v1/targets/${id}/traceroute/history`),
    staleTime: 300_000,
  });
}


// All of a group's sparkline series in a single request
export function useGroupResults(id, range = '12h') {
  return useQuery({
    queryKey: ['group-results', id, range],
    queryFn: () => apiFetch(`/api/v1/groups/${id}/results?range=${range}`),
    refetchInterval: 60_000,
  });
}

export function useIncidents(days = 30) {
  return useQuery({
    queryKey: ['incidents', days],
    queryFn: () => apiFetch(`/api/v1/incidents?days=${days}`),
    refetchInterval: 60_000,
  });
}

export function useTargetIncidents(id) {
  return useQuery({
    queryKey: ['target-incidents', id],
    queryFn: () => apiFetch(`/api/v1/targets/${id}/incidents`),
    refetchInterval: 60_000,
  });
}

export function useAvailability(id, days = 90) {
  return useQuery({
    queryKey: ['availability', id, days],
    queryFn: () => apiFetch(`/api/v1/targets/${id}/availability?days=${days}`),
    staleTime: 300_000,
  });
}
