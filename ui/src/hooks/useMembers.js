import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

export function useMembers() {
  return useQuery({ queryKey: ['members'], queryFn: api.getMembers })
}
