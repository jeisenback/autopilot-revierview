import { Outlet, NavLink } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { Separator } from '@/components/ui/separator'

function NavItem({ to, children }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          isActive
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

export default function App() {
  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-52 shrink-0 border-r flex flex-col p-4 gap-1">
        <div className="px-3 py-2 mb-2">
          <h1 className="text-base font-semibold tracking-tight">Autopilot</h1>
          <p className="text-xs text-muted-foreground">Riverview</p>
        </div>
        <Separator className="mb-2" />
        <NavItem to="/projects">Projects</NavItem>
        <NavItem to="/approvals">Approvals</NavItem>
        <NavItem to="/members">Members</NavItem>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>

      <Toaster />
    </div>
  )
}
