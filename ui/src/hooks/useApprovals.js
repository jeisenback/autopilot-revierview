import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

export function useApprovals() {
  return useQuery({ queryKey: ['approvals'], queryFn: api.getApprovals, refetchInterval: 10000 })
}

export function useResolveApproval() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }) => api.resolveApproval(id, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}
