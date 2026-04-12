import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useProject, useUpdateTask, useCreateTask, useDeleteProject } from '@/hooks/useProjects'
import { useResolveApproval } from '@/hooks/useApprovals'
import { useMembers } from '@/hooks/useMembers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { useQueryClient } from '@tanstack/react-query'

const STATUS_CYCLE = { todo: 'in_progress', in_progress: 'done', done: 'todo' }
const STATUS_COLOR = {
  todo: 'secondary',
  in_progress: 'default',
  done: 'outline',
  blocked: 'destructive',
  awaiting_approval: 'outline',
  skipped: 'outline',
}

function TaskRow({ task, projectId, members }) {
  const updateTask = useUpdateTask()
  const resolveApproval = useResolveApproval()
  const qc = useQueryClient()

  function cycleStatus() {
    const next = STATUS_CYCLE[task.status]
    if (!next) return
    updateTask.mutate({ id: task.id, projectId, status: next }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', projectId] }),
    })
  }

  function handleAssign(memberId) {
    updateTask.mutate({ id: task.id, projectId, assigned_to: memberId === 'unassigned' ? null : Number(memberId) }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', projectId] }),
    })
  }

  function handleResolve(action) {
    // find approval id — task must have awaiting_approval status
    resolveApproval.mutate({ id: task.approval_id, action })
  }

  const isApprovalPending = task.status === 'awaiting_approval'

  return (
    <div className="flex items-center gap-3 py-3">
      {isApprovalPending ? (
        <Badge variant="outline" className="text-xs shrink-0">⧖ Pending</Badge>
      ) : (
        <button onClick={cycleStatus} className="shrink-0">
          <Badge variant={STATUS_COLOR[task.status] || 'secondary'} className="text-xs cursor-pointer">
            {task.status}
          </Badge>
        </button>
      )}

      <span className="flex-1 text-sm">{task.title}</span>

      {task.estimated_cost > 0 && (
        <span className="text-xs text-muted-foreground shrink-0">~${task.estimated_cost}</span>
      )}

      {isApprovalPending && task.approval_id && (
        <div className="flex gap-1 shrink-0">
          <Button size="sm" variant="outline" className="h-7 text-xs"
            onClick={() => handleResolve('approved')} disabled={resolveApproval.isPending}>
            Approve
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs text-destructive"
            onClick={() => handleResolve('denied')} disabled={resolveApproval.isPending}>
            Deny
          </Button>
        </div>
      )}

      <Select value={task.assigned_to ? String(task.assigned_to) : 'unassigned'} onValueChange={handleAssign}>
        <SelectTrigger className="h-7 w-32 text-xs shrink-0">
          <SelectValue placeholder="Unassigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">Unassigned</SelectItem>
          {(members || []).map(m => (
            <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function AddTaskDialog({ open, onClose, projectId, members }) {
  const [title, setTitle] = useState('')
  const [assignedTo, setAssignedTo] = useState('unassigned')
  const createTask = useCreateTask()

  function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) return
    createTask.mutate({
      project_id: Number(projectId),
      title: title.trim(),
      assigned_to: assignedTo === 'unassigned' ? undefined : Number(assignedTo),
    }, {
      onSuccess: () => { setTitle(''); setAssignedTo('unassigned'); onClose() }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add task</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-2">
          <input
            className="w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Task title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
          <Select value={assignedTo} onValueChange={setAssignedTo}>
            <SelectTrigger className="text-sm">
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {(members || []).map(m => (
                <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createTask.isPending}>
              {createTask.isPending ? 'Adding…' : 'Add task'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function ProjectDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: project, isLoading, error } = useProject(id)
  const { data: members } = useMembers()
  const deleteProject = useDeleteProject()
  const [addTaskOpen, setAddTaskOpen] = useState(false)

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>
  if (error) return <div className="text-destructive text-sm">Error: {error.message}</div>
  if (!project) return <div className="text-muted-foreground text-sm">Project not found.</div>

  function handleDelete() {
    deleteProject.mutate(id, { onSuccess: () => navigate('/projects') })
  }

  const totalCost = project.tasks?.reduce((sum, t) => sum + (t.estimated_cost || 0), 0) || 0

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <button
            onClick={() => navigate('/projects')}
            className="text-sm text-muted-foreground hover:text-foreground mb-1 flex items-center gap-1"
          >
            ← Projects
          </button>
          <h1 className="text-xl font-semibold">{project.title}</h1>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
            {project.owner_name && <span>Owner: {project.owner_name}</span>}
            {totalCost > 0 && <span>Est. ${totalCost}</span>}
            {project.due_date && <span>Due: {project.due_date}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="text-destructive">Delete</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete project?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will mark the project as done. Tasks will remain in the database.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <Separator className="mb-4" />

      {/* Tasks */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Tasks</h2>
        <Button size="sm" variant="outline" onClick={() => setAddTaskOpen(true)}>+ Add task</Button>
      </div>

      {(!project.tasks || project.tasks.length === 0) ? (
        <p className="text-sm text-muted-foreground">No tasks yet.</p>
      ) : (
        <div className="divide-y">
          {project.tasks.map(task => (
            <TaskRow key={task.id} task={task} projectId={id} members={members} />
          ))}
        </div>
      )}

      <AddTaskDialog
        open={addTaskOpen}
        onClose={() => setAddTaskOpen(false)}
        projectId={id}
        members={members}
      />
    </div>
  )
}
