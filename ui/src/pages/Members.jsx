import { useMembers } from '@/hooks/useMembers'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

function snoozeLabel(snoozeUntil) {
  if (!snoozeUntil) return null
  const until = new Date(snoozeUntil)
  if (until <= new Date()) return null
  return `until ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function MemberRow({ member }) {
  const snoozed = snoozeLabel(member.snooze_until)
  const dailyCount = member.daily_count ?? 0
  const maxDaily = member.max_daily_notifications ?? 5

  return (
    <div className="flex items-center gap-4 py-3">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {member.name}
            {member.role === 'kid' && <span className="text-muted-foreground font-normal"> (kid)</span>}
          </span>
          <Badge variant={member.role === 'adult' ? 'default' : 'secondary'} className="text-xs">
            {member.role}
          </Badge>
          {snoozed && (
            <Badge variant="outline" className="text-xs text-yellow-600 border-yellow-400">
              Snoozed {snoozed}
            </Badge>
          )}
        </div>
      </div>
      <div className="text-xs text-muted-foreground text-right">
        <div>Notifications today: {dailyCount}/{maxDaily}</div>
        {!snoozed && <div className="text-green-600">Not snoozed</div>}
      </div>
    </div>
  )
}

export default function Members() {
  const { data: members = [], isLoading, error } = useMembers()

  if (isLoading) return <div className="text-muted-foreground text-sm">Loading…</div>
  if (error) return <div className="text-destructive text-sm">Error: {error.message}</div>

  const adults = members.filter(m => m.role === 'adult')
  const kids = members.filter(m => m.role === 'kid')

  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold mb-6">Family Members</h1>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No members registered.</p>
      ) : (
        <>
          {adults.length > 0 && (
            <>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Adults</h2>
              <div className="divide-y mb-4">
                {adults.map(m => <MemberRow key={m.id} member={m} />)}
              </div>
            </>
          )}
          {kids.length > 0 && (
            <>
              <Separator className="mb-4" />
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Kids</h2>
              <div className="divide-y">
                {kids.map(m => <MemberRow key={m.id} member={m} />)}
              </div>
            </>
          )}
        </>
      )}

      <Separator className="mt-6 mb-3" />
      <p className="text-xs text-muted-foreground">
        Notification settings managed via Discord (<code>/snooze</code> command).
      </p>
    </div>
  )
}
