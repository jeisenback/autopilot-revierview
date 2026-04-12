import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DndContext, closestCorners, useSensor, useSensors, MouseSensor, TouchSensor } from '@dnd-kit/core'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { useProjects, useUpdateProjectStatus, useCreateProject } from '@/hooks/useProjects'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

const STATUSES = ['open', 'active', 'blocked', 'done']

const STATUS_LABEL = { open: 'Open', active: 'Active', blocked: 'Blocked', done: 'Done' }
const STATUS_COLOR = {
  open: 'secondary',
  active: 'default',
  blocked: 'destructive',
  done: 'outline',
}

function ProjectCard({ project }) {
  const navigate = useNavigate()
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: project.id })
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, opacity: isDragging ? 0.5 : 1 }
    : undefined

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <Card
        className="cursor-pointer hover:shadow-md transition-shadow mb-2"
        onClick={() => navigate(`/projects/${project.id}`)}
      >
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-sm font-medium leading-snug">{project.title}</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 text-xs text-muted-foreground space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            {project.task_count > 0 && <span>{project.task_count} task{project.task_count !== 1 ? 's' : ''}</span>}
            {project.total_estimated_cost > 0 && <span>${project.total_estimated_cost}</span>}
            {project.owner_name && <span>{project.owner_name}</span>}
          </div>
          {project.due_date && (
            <div>Due {project.due_date}</div>
          )}
          {project.priority === 1 && <Badge variant="destructive" className="text-xs">High</Badge>}
        </CardContent>
      </Card>
    </div>
  )
}

function KanbanColumn({ status, projects, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div className="flex-1 min-w-48">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold">{STATUS_LABEL[status]}</h2>
        <Badge variant={STATUS_COLOR[status]} className="text-xs">{projects.length}</Badge>
      </div>
      <div
        ref={setNodeRef}
        className={`min-h-32 rounded-lg p-2 transition-colors ${isOver ? 'bg-accent' : 'bg-muted/30'}`}
      >
        {projects.map(p => <ProjectCard key={p.id} project={p} />)}
        {children}
      </div>
    </div>
  )
}

function NewProjectDialog({ open, onClose }) {
  const [title, setTitle] = useState('')
  const createProject = useCreateProject()

  function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) return
    createProject.mutate({ title: title.trim() }, { onSuccess: () => { setTitle(''); onClose() } })
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <input
            className="w-full border rounded-md px-3 py-2 text-sm mt-2 focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Project title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createProject.isPending}>
              {createProject.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function Projects() {
  const { data: projects = [], isLoading, error } = useProjects()
  const updateStatus = useUpdateProjectStatus()
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 10 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>
  if (error) return <div className="text-destructive text-sm">Failed to load projects: {error.message}</div>

  const byStatus = Object.fromEntries(STATUSES.map(s => [s, []]))
  for (const p of projects) {
    const bucket = byStatus[p.status] ?? byStatus['open']
    bucket.push(p)
  }

  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    if (!STATUSES.includes(over.id)) return
    updateStatus.mutate({ id: active.id, status: over.id })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Projects</h1>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto pb-4">
          {STATUSES.map(status => (
            <KanbanColumn key={status} status={status} projects={byStatus[status]}>
              {status === 'open' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full mt-1 text-muted-foreground text-xs"
                  onClick={() => setNewProjectOpen(true)}
                >
                  + New project
                </Button>
              )}
            </KanbanColumn>
          ))}
        </div>
      </DndContext>
      <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
    </div>
  )
}
