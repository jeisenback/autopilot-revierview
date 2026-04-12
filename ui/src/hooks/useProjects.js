import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: api.getProjects, refetchInterval: 10000 })
}

export function useProject(id) {
  return useQuery({ queryKey: ['projects', id], queryFn: () => api.getProject(id) })
}

export function useUpdateProjectStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }) => api.updateProject(id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body) => api.createProject(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => api.deleteProject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useUpdateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }) => api.updateTask(id, body),
    onSuccess: (_, { projectId }) => {
      qc.invalidateQueries({ queryKey: ['projects', projectId] })
    },
  })
}

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body) => api.createTask(body),
    onSuccess: (_, { project_id }) => {
      qc.invalidateQueries({ queryKey: ['projects', String(project_id)] })
    },
  })
}
