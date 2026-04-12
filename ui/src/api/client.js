const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export const api = {
  getProjects:      ()           => request('/projects'),
  getProject:       (id)         => request(`/projects/${id}`),
  updateProject:    (id, body)   => request(`/projects/${id}`, { method: 'PATCH', body }),
  createProject:    (body)       => request('/projects', { method: 'POST', body }),
  deleteProject:    (id)         => request(`/projects/${id}`, { method: 'DELETE' }),
  updateTask:       (id, body)   => request(`/tasks/${id}`, { method: 'PATCH', body }),
  createTask:       (body)       => request('/tasks', { method: 'POST', body }),
  getApprovals:     ()           => request('/approvals'),
  resolveApproval:  (id, action) => request(`/approvals/${id}/resolve`, { method: 'POST', body: { action } }),
  getMembers:       ()           => request('/members'),
}
