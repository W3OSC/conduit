/**
 * Calendar page — @schedule-x calendar with event detail slide-over
 * and a Meeting Notes sidebar (Gemini AI smart notes).
 *
 * Layout:
 *   ┌────────────────────┬──────────────────┐
 *   │  Schedule-X grid   │  Meeting Notes   │
 *   │                    │  sidebar (280px) │
 *   │  [Event detail     │                  │
 *   │   slide-over]      │  Scrollable list │
 *   └────────────────────┴──────────────────┘
 *
 * All calendar modifications go through the outbox for approval.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ScheduleXCalendar, useNextCalendarApp } from '@schedule-x/react';
import { createViewMonthGrid, createViewWeek, createViewDay, createViewMonthAgenda } from '@schedule-x/calendar';
import '@schedule-x/theme-default/dist/index.css';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Plus, Edit2, Trash2, CheckCircle2, XCircle, Clock, MapPin,
  Users, ExternalLink, Video, Loader2, CalendarDays, RefreshCw,
  FileText, Search,
} from 'lucide-react';
import { api, type CalendarEvent, type CalendarActionParams, type GoogleCalendarInfo, type MeetNote } from '@/lib/api';
import { Skeleton } from '@/components/shared/Skeleton';
import { cn, formatDate, timeAgo } from '@/lib/utils';
import { toast } from '@/store';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAttendees(raw: string | null): Array<{ email: string; name: string; responseStatus: string }> {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function parseNoteAttendees(raw: string | null): Array<{ email?: string; name?: string; displayName?: string }> {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

const RSVP_CONFIG: Record<string, { label: string; class: string }> = {
  accepted:   { label: 'Accepted',   class: 'chip-emerald' },
  declined:   { label: 'Declined',   class: 'chip-red' },
  tentative:  { label: 'Tentative',  class: 'chip-amber' },
  needsAction:{ label: 'Pending',    class: 'chip-zinc' },
};

// ─── Meeting Notes sidebar ────────────────────────────────────────────────────

function NoteCard({
  note,
  highlighted,
  onClick,
}: {
  note: MeetNote;
  highlighted: boolean;
  onClick: () => void;
}) {
  const attendees = parseNoteAttendees(note.attendees);
  const attendeeNames = attendees
    .map((a) => a.displayName || a.name || a.email || '')
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');

  const summaryPreview = note.summary
    ? note.summary.slice(0, 160).replace(/\n+/g, ' ').trim()
    : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left p-3 rounded-xl border transition-all',
        highlighted
          ? 'border-primary/30 bg-primary/8'
          : 'border-border/40 bg-secondary/20 hover:bg-secondary/40',
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className={cn('text-xs font-semibold leading-snug flex-1', highlighted && 'text-primary')}>
          {note.title || 'Meeting notes'}
        </p>
        {note.docsUrl && (
          <a
            href={note.docsUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex-shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-primary transition-colors"
            title="Open in Google Docs"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
      {note.meetingDate && (
        <p className="text-[10px] text-muted-foreground/60 mb-1">
          {timeAgo(note.meetingDate)}
        </p>
      )}
      {attendeeNames && (
        <p className="text-[10px] text-muted-foreground/50 mb-1.5 truncate">
          {attendeeNames}{attendees.length > 3 ? ` +${attendees.length - 3} more` : ''}
        </p>
      )}
      {summaryPreview && (
        <p className="text-[11px] text-foreground/60 leading-relaxed line-clamp-2">
          {summaryPreview}
        </p>
      )}
    </button>
  );
}

function MeetingNoteDetail({
  note,
  onClose,
}: {
  note: MeetNote;
  onClose: () => void;
}) {
  const attendees = parseNoteAttendees(note.attendees);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/50 flex-shrink-0">
        <p className="text-xs font-semibold truncate flex-1">{note.title || 'Meeting notes'}</p>
        <button onClick={onClose} className="btn-ghost p-1 ml-1 flex-shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {note.meetingDate && (
          <p className="text-[10px] text-muted-foreground">
            {formatDate(note.meetingDate, 'EEEE, MMMM d, yyyy · HH:mm')}
          </p>
        )}
        {attendees.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1">Participants</p>
            <p className="text-xs text-muted-foreground/70">
              {attendees.map((a) => a.displayName || a.name || a.email || '').filter(Boolean).join(', ')}
            </p>
          </div>
        )}
        {note.summary ? (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1.5">Notes</p>
            <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{note.summary}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/50 text-center py-4">No content available</p>
        )}
        {note.docsUrl && (
          <a
            href={note.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary text-xs w-full justify-center"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in Google Docs
          </a>
        )}
      </div>
    </div>
  );
}

function MeetingNotesSidebar({
  selectedEventId,
  calendarConnected,
}: {
  selectedEventId: string | null;
  calendarConnected: boolean;
}) {
  const [search, setSearch] = useState('');
  const [selectedNote, setSelectedNote] = useState<MeetNote | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['meet-notes', search],
    queryFn: () => api.meetNotes({ limit: 30, q: search || undefined }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const notes = data?.notes ?? [];

  // Highlight notes matched to the selected calendar event
  const highlightedNoteId = useMemo(() => {
    if (!selectedEventId) return null;
    const match = notes.find((n) => n.calendarEventId === selectedEventId);
    return match?.id ?? null;
  }, [notes, selectedEventId]);

  // When a calendar event is selected and has a note, auto-open it
  useMemo(() => {
    if (!selectedEventId) return;
    const match = notes.find((n) => n.calendarEventId === selectedEventId);
    if (match && selectedNote?.id !== match.id) setSelectedNote(match);
  }, [selectedEventId, notes]);

  if (selectedNote) {
    return (
      <MeetingNoteDetail
        note={selectedNote}
        onClose={() => setSelectedNote(null)}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border/50 flex-shrink-0">
        <div className="flex items-center gap-1.5 mb-2">
          <FileText className="w-3.5 h-3.5 text-primary/70" />
          <p className="text-xs font-semibold">Meeting Notes</p>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50 pointer-events-none" />
          <input
            className="w-full bg-secondary/60 border border-border/40 rounded-lg pl-7 pr-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground/40"
            placeholder="Search notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Notes list */}
      <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-1.5">
        {!calendarConnected ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground/50 text-center px-3">
            <FileText className="w-7 h-7 opacity-20" />
            <p className="text-xs">Connect Google to see meeting notes</p>
          </div>
        ) : isLoading ? (
          <div className="space-y-2 p-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5 p-3 rounded-xl border border-border/30">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/3" />
                <Skeleton className="h-2.5 w-full" />
                <Skeleton className="h-2.5 w-4/5" />
              </div>
            ))}
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground/50 text-center px-3">
            <FileText className="w-7 h-7 opacity-20" />
            <p className="text-xs">
              {search ? 'No notes match your search' : 'No meeting notes yet'}
            </p>
            {!search && (
              <p className="text-[10px] opacity-70">
                Gemini smart notes appear here after meetings
              </p>
            )}
          </div>
        ) : (
          notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              highlighted={note.id === highlightedNoteId}
              onClick={() => setSelectedNote(note)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Event Popup (Google Calendar-style) ──────────────────────────────────────

function EventPopup({
  event,
  calendars,
  position,
  onClose,
  onOpenDetail,
}: {
  event: CalendarEvent;
  calendars: GoogleCalendarInfo[];
  position: { x: number; y: number };
  onClose: () => void;
  onOpenDetail: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const calInfo = calendars.find((c) => c.id === event.calendarId);
  const color = calInfo?.backgroundColor || '#f59e0b';

  const startDate = formatDate(event.startTime, event.allDay ? 'EEEE, MMMM d' : 'EEEE, MMMM d · HH:mm');
  const endTime   = event.endTime && !event.allDay ? formatDate(event.endTime, 'HH:mm') : null;

  // Close on outside click or Escape.
  // The listener is deferred by one frame so the mousedown that opened the
  // popup doesn't immediately re-trigger the outside-click close logic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  // Clamp popup to viewport so it never gets cut off
  const POPUP_W = 320;
  const POPUP_H = 280; // approximate
  const GAP = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = position.x + GAP;
  let top  = position.y;
  if (left + POPUP_W > vw - GAP) left = position.x - POPUP_W - GAP;
  if (left < GAP) left = GAP;
  if (top + POPUP_H > vh - GAP) top = vh - POPUP_H - GAP;
  if (top < GAP) top = GAP;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.95, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -4 }}
      transition={{ duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
      className="fixed z-50 w-80 rounded-2xl border border-border bg-card shadow-2xl shadow-black/40 flex flex-col overflow-hidden"
      style={{ left, top }}
    >
      {/* Coloured header bar */}
      <div className="flex items-start justify-between px-4 py-3.5 gap-2" style={{ background: `${color}22`, borderBottom: `1px solid ${color}33` }}>
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5" style={{ background: color }} />
          <p className="text-sm font-semibold leading-snug break-words min-w-0">{event.title || '(no title)'}</p>
        </div>
        <button onClick={onClose} className="btn-ghost p-1 flex-shrink-0 -mt-0.5 -mr-1">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-2.5 text-sm">
        {/* Time */}
        <div className="flex items-center gap-2.5 text-muted-foreground">
          <Clock className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="text-xs">
            {startDate}{endTime ? ` – ${endTime}` : ''}{event.allDay ? ' · All day' : ''}
          </span>
        </div>

        {/* Location */}
        {event.location && (
          <div className="flex items-center gap-2.5 text-muted-foreground">
            <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="text-xs truncate">{event.location}</span>
          </div>
        )}

        {/* Meet link */}
        {event.meetLink && (
          <a
            href={event.meetLink}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/8 px-2.5 py-1.5 text-xs text-emerald-400 hover:bg-emerald-500/15 transition-colors"
          >
            <Video className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="flex-1">Join Google Meet</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        )}

        {/* Description snippet */}
        {event.description && (
          <p className="text-xs text-foreground/70 leading-relaxed line-clamp-3 bg-secondary/40 rounded-lg px-2.5 py-2">
            {event.description}
          </p>
        )}

        {/* Calendar name */}
        <p className="text-[11px] text-muted-foreground/50">{calInfo?.summary || event.calendarId}</p>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/50 bg-secondary/20">
        {event.htmlLink ? (
          <a href={event.htmlLink} target="_blank" rel="noreferrer" className="text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
            <ExternalLink className="w-3 h-3" /> Google Calendar
          </a>
        ) : <span />}
        <button
          onClick={onOpenDetail}
          className="text-[11px] text-primary hover:text-primary/80 transition-colors font-medium flex items-center gap-1"
        >
          Open details →
        </button>
      </div>
    </motion.div>
  );
}

// ─── Event Detail Panel ────────────────────────────────────────────────────────

function EventDetail({
  event,
  calendars,
  onClose,
}: {
  event: CalendarEvent;
  calendars: GoogleCalendarInfo[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const calInfo = calendars.find((c) => c.id === event.calendarId);
  const attendees = parseAttendees(event.attendees);
  const startDate = formatDate(event.startTime, event.allDay ? 'EEEE, MMMM d, yyyy' : 'EEEE, MMMM d, yyyy · HH:mm');
  const endDate = event.endTime ? formatDate(event.endTime, event.allDay ? 'MMM d' : 'HH:mm') : '';

  // Fetch associated meeting note (if any)
  const { data: notesData } = useQuery({
    queryKey: ['meet-notes-event', event.eventId],
    queryFn: () => api.meetNotes({ limit: 5 }),
    staleTime: 60_000,
    select: (d) => d.notes.find((n) => n.calendarEventId === event.eventId) ?? null,
    enabled: !!event.meetLink, // only for video meetings
  });
  const linkedNote = notesData ?? null;

  const rsvpMutation = useMutation({
    mutationFn: (status: 'accepted' | 'declined' | 'tentative') =>
      api.calendarAction({ action: 'rsvp', calendarId: event.calendarId, eventId: event.eventId, rsvpStatus: status }),
    onSuccess: () => { toast({ title: 'RSVP queued for approval', variant: 'success' }); qc.invalidateQueries({ queryKey: ['calendar-events'] }); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.calendarAction({ action: 'delete', calendarId: event.calendarId, eventId: event.eventId }),
    onSuccess: () => { toast({ title: 'Delete queued for approval', variant: 'success' }); qc.invalidateQueries({ queryKey: ['calendar-events'] }); onClose(); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="w-full bg-card flex flex-col h-full"
    >
      {/* Header */}
      <div className="flex items-start justify-between px-5 py-4 border-b border-border gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <div className="w-3 h-3 rounded-full flex-shrink-0 mt-0.5" style={{ background: calInfo?.backgroundColor || '#f59e0b' }} />
          <h3 className="text-sm font-semibold break-words min-w-0">{event.title || '(no title)'}</h3>
        </div>
        <button onClick={onClose} className="btn-ghost p-1.5 flex-shrink-0"><X className="w-4 h-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Time */}
        <div className="flex items-start gap-3">
          <Clock className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="text-foreground">{startDate}</p>
            {endDate && !event.allDay && <p className="text-muted-foreground text-xs">Ends {endDate}</p>}
            {event.allDay && <p className="text-muted-foreground text-xs">All day</p>}
          </div>
        </div>

        {/* Location */}
        {event.location && (
          <div className="flex items-start gap-3">
            <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <p className="text-sm text-foreground">{event.location}</p>
          </div>
        )}

        {/* Meet link */}
        {event.meetLink && (
          <a href={event.meetLink} target="_blank" rel="noreferrer"
            className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2.5 text-sm text-emerald-400 hover:bg-emerald-500/15 transition-colors"
          >
            <Video className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1">Join Google Meet</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}

        {/* Calendar */}
        <div className="text-xs text-muted-foreground">{calInfo?.summary || event.calendarId}</div>

        {/* Description */}
        {event.description && (
          <div className="text-sm text-foreground/80 leading-relaxed bg-secondary/40 rounded-xl px-3 py-2.5 whitespace-pre-wrap">
            {event.description}
          </div>
        )}

        {/* Organizer */}
        {event.organizerEmail && (
          <div className="text-xs text-muted-foreground">
            Organized by {event.organizerName ? `${event.organizerName} (${event.organizerEmail})` : event.organizerEmail}
          </div>
        )}

        {/* Attendees */}
        {attendees.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">{attendees.length} attendee{attendees.length !== 1 ? 's' : ''}</p>
            </div>
            <div className="space-y-1.5">
              {attendees.map((a, i) => {
                const cfg = RSVP_CONFIG[a.responseStatus] || RSVP_CONFIG.needsAction;
                return (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{a.name || a.email}</p>
                      {a.name && <p className="text-[10px] text-muted-foreground truncate">{a.email}</p>}
                    </div>
                    <span className={cn('chip text-[10px] flex-shrink-0', cfg.class)}>{cfg.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Meeting Notes section — only for events with a Meet link */}
        {event.meetLink && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Meeting Notes</p>
            </div>
            {linkedNote ? (
              <div className="rounded-xl border border-border/40 bg-secondary/20 p-3 space-y-2">
                <p className="text-xs font-semibold">{linkedNote.title || 'Meeting notes'}</p>
                {linkedNote.summary && (
                  <p className="text-[11px] text-foreground/70 leading-relaxed line-clamp-4">
                    {linkedNote.summary}
                  </p>
                )}
                {linkedNote.docsUrl && (
                  <a
                    href={linkedNote.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[11px] text-primary/70 hover:text-primary transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open full notes in Google Docs
                  </a>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/50 bg-secondary/20 rounded-xl px-3 py-2">
                No notes available for this meeting yet
              </p>
            )}
          </div>
        )}

        {/* RSVP */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Your Response</p>
          <div className="flex gap-2">
            {(['accepted', 'tentative', 'declined'] as const).map((status) => (
              <button
                key={status}
                onClick={() => rsvpMutation.mutate(status)}
                disabled={rsvpMutation.isPending}
                className={cn(
                  'flex-1 py-1.5 rounded-xl border text-xs font-medium transition-all',
                  status === 'accepted'  ? 'border-emerald-500/25 bg-emerald-500/8  text-emerald-400 hover:bg-emerald-500/20' :
                  status === 'tentative' ? 'border-amber-500/25  bg-amber-500/8   text-amber-400  hover:bg-amber-500/20' :
                                          'border-red-500/25     bg-red-500/8      text-red-400    hover:bg-red-500/20',
                )}
              >
                {status === 'accepted' ? '✓ Yes' : status === 'tentative' ? '? Maybe' : '✕ No'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div className="px-5 py-3 border-t border-border space-y-2 flex-shrink-0">
        {event.htmlLink && (
          <a href={event.htmlLink} target="_blank" rel="noreferrer" className="btn-secondary text-xs w-full justify-center">
            <ExternalLink className="w-3.5 h-3.5" /> Open in Google Calendar
          </a>
        )}
        {confirmDelete ? (
          <div className="flex gap-2">
            <button onClick={() => setConfirmDelete(false)} className="btn-secondary text-xs flex-1">Cancel</button>
            <button onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending} className="btn-danger text-xs flex-1">
              {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Confirm Delete
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="btn-danger text-xs w-full justify-center">
            <Trash2 className="w-3.5 h-3.5" /> Delete Event
          </button>
        )}
      </div>
    </motion.div>
  );
}

// ─── Create Event Modal ────────────────────────────────────────────────────────

function CreateEventModal({ calendars, onClose, defaultStart }: { calendars: GoogleCalendarInfo[]; onClose: () => void; defaultStart?: string }) {
  const qc = useQueryClient();
  const primaryCal = calendars.find((c) => c.primary)?.id || calendars[0]?.id || 'primary';

  const [calendarId, setCalendarId] = useState(primaryCal);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [start, setStart] = useState(defaultStart || new Date().toISOString().slice(0, 16));
  const [end, setEnd] = useState(() => {
    const d = new Date(defaultStart || Date.now());
    d.setHours(d.getHours() + 1);
    return d.toISOString().slice(0, 16);
  });
  const [attendees, setAttendees] = useState('');
  const [allDay, setAllDay] = useState(false);

  const create = useMutation({
    mutationFn: () => api.calendarAction({
      action: 'create',
      calendarId,
      title, description, location,
      start: allDay ? start.slice(0, 10) : new Date(start).toISOString(),
      end:   allDay ? end.slice(0, 10)   : new Date(end).toISOString(),
      allDay,
      attendees: attendees.split(',').map((a) => a.trim()).filter(Boolean),
    }),
    onSuccess: () => {
      toast({ title: 'Event creation queued for approval', variant: 'success' });
      qc.invalidateQueries({ queryKey: ['calendar-events'] });
      onClose();
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        className="card-warm w-full max-w-lg overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold">Create Event</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title" className="input-warm text-sm" autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Start</label>
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="input-warm text-sm" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">End</label>
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="input-warm text-sm" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} id="allday" className="accent-primary" />
            <label htmlFor="allday" className="text-xs text-muted-foreground">All day</label>
          </div>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" className="input-warm text-sm" />
          <input value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="Attendees (comma-separated emails)" className="input-warm text-sm" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" rows={3} className="input-warm text-sm resize-none" />
          {calendars.length > 1 && (
            <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className="input-warm text-sm">
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.summary}</option>)}
            </select>
          )}
        </div>
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-border">
          <p className="text-xs text-muted-foreground">Goes to outbox for approval</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary text-xs">Cancel</button>
            <button onClick={() => create.mutate()} disabled={!title || create.isPending} className="btn-primary text-xs">
              {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Create Event
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function Calendar() {
  const qc = useQueryClient();
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [popupEvent, setPopupEvent] = useState<CalendarEvent | null>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [createOpen, setCreateOpen] = useState(false);
  const lastClickPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const calendarWrapperRef = useRef<HTMLDivElement>(null);
  const calendarScrollRef = useRef<HTMLDivElement>(null);
  // Measured grid height — starts at 624 (12h × 52px) and updates on resize
  const [gridHeight, setGridHeight] = useState(624);

  const { data: statusData } = useQuery({ queryKey: ['calendar-status'], queryFn: api.calendarStatus, refetchInterval: 30000 });
  const { data: calendarsData } = useQuery({ queryKey: ['calendar-list'], queryFn: api.calendarList, staleTime: 60000 });
  const { data: eventsData, isLoading } = useQuery({
    queryKey: ['calendar-events'],
    queryFn: () => api.calendarEvents({ from: new Date(Date.now() - 30 * 86400000).toISOString(), to: new Date(Date.now() + 90 * 86400000).toISOString(), limit: 500 }),
    refetchInterval: 60000,
  });

  const calendars = calendarsData?.calendars || [];
  const events = eventsData?.events || [];

  // Use the primary calendar's timezone from Google, falling back to the
  // browser's local timezone. This ensures events display at the correct wall-
  // clock time matching what the user sees in Google Calendar.
  const T = globalThis.Temporal;
  const calendarTz = useMemo(() => {
    const primary = calendars.find((c) => c.primary);
    const tz = primary?.timeZone || T.Now.timeZoneId();
    // Validate the timezone identifier is recognised; fall back if not.
    // (Temporal.TimeZone was removed from the final spec — use Intl to validate)
    try { T.Now.zonedDateTimeISO(tz); return tz; }
    catch { return T.Now.timeZoneId(); }
  }, [calendars]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncMutation = useMutation({
    mutationFn: api.calendarSync,
    onSuccess: () => { toast({ title: 'Calendar sync started' }); qc.invalidateQueries({ queryKey: ['calendar-events'] }); },
  });

  // Convert CalendarEvent[] to schedule-x format.
  // Schedule-x v4 requires Temporal.ZonedDateTime for timed events and
  // Temporal.PlainDate for all-day events — plain strings are not accepted.
  // We must use globalThis.Temporal (installed by temporal-polyfill/global in
  // main.tsx) so our objects share the same class as schedule-x's internal
  // instanceof checks.
  const toSxDateTime = (iso: string) =>
    T.Instant.from(iso).toZonedDateTimeISO(calendarTz);
  const toSxDate = (iso: string) =>
    T.PlainDate.from(iso.slice(0, 10));

  const sxEvents = useMemo(() => events.flatMap((e) => {
    try {
      const start = e.allDay ? toSxDate(e.startTime) : toSxDateTime(e.startTime);
      const endRaw = e.endTime || e.startTime;
      const end = e.allDay ? toSxDate(endRaw) : toSxDateTime(endRaw);
      return [{
        id: e.eventId,
        title: e.title || '(no title)',
        start,
        end,
        calendarId: e.calendarId,
        description: e.description || '',
        location: e.location || '',
        _event: e,
      }];
    } catch {
      // Skip events with unparseable dates rather than crashing the whole view
      return [];
    }
  }), [events]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable refs so calendar callbacks always see current values without
  // needing to re-initialize the calendar app (which would lose view state).
  const eventsRef = useRef(events);
  const setPopupEventRef = useRef(setPopupEvent);
  const setPopupPosRef = useRef(setPopupPos);
  const setSelectedEventRef = useRef(setSelectedEvent);
  useEffect(() => { eventsRef.current = events; }, [events]);

  const calendar = useNextCalendarApp({
    views: [createViewMonthGrid(), createViewWeek(), createViewDay(), createViewMonthAgenda()],
    dayBoundaries: { start: '08:00', end: '20:00' },
    weekOptions: { gridHeight },
    timezone: calendarTz,
    events: sxEvents,
    callbacks: {
      onEventClick: (event, e) => {
        const raw = eventsRef.current.find((ev) => ev.eventId === event.id);
        if (raw) {
          const me = e as MouseEvent;
          setPopupPosRef.current({ x: me.clientX ?? lastClickPos.current.x, y: me.clientY ?? lastClickPos.current.y });
          setPopupEventRef.current(raw);
          setSelectedEventRef.current(null);
        }
      },
    },
    calendars: Object.fromEntries(
      calendars.map((c) => {
        const color = c.backgroundColor || '#f59e0b';
        const container = `${color}33`;
        return [c.id, {
          colorName: c.id,
          lightColors: { main: color, container, onContainer: '#ffffff' },
          darkColors:  { main: color, container, onContainer: '#ffffff' },
        }];
      })
    ),
  });

  // schedule-x initializes once — push events imperatively whenever they change
  // or when a fresh calendar instance is created (page re-visit).
  useEffect(() => {
    if (calendar) calendar.events.set(sxEvents);
  }, [calendar, sxEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dynamically compute gridHeight so the 08:00–20:00 window fills the container
  // exactly with no scrolling. We measure the actual schedule-x chrome elements
  // (calendar header + week-header) rather than using a hardcoded constant, so
  // it's correct regardless of font size or future theme changes.
  useEffect(() => {
    const container = calendarScrollRef.current;
    if (!container) return;

    const applyGridHeight = () => {
      const totalHeight = container.clientHeight;
      // Measure the non-grid chrome rendered inside the wrapper
      const calHeader  = container.querySelector('.sx__calendar-header') as HTMLElement | null;
      const weekHeader = container.querySelector('.sx__week-header')     as HTMLElement | null;
      const overhead   = (calHeader?.offsetHeight ?? 58) + (weekHeader?.offsetHeight ?? 72);
      const gh = Math.max(totalHeight - overhead, 200);
      setGridHeight(gh);
      const wo = (calendar as any)?.$app?.config?.weekOptions;
      if (wo) wo.value = { ...wo.value, gridHeight: gh };
    };

    // Run once immediately, then on every resize
    applyGridHeight();
    const ro = new ResizeObserver(applyGridHeight);
    ro.observe(container);
    return () => ro.disconnect();
  }, [calendar]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!statusData?.connected) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-3.5rem)] gap-4 text-muted-foreground">
        <div className="w-20 h-20 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center">
          <CalendarDays className="w-10 h-10 opacity-20" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">Calendar not connected</p>
          <p className="text-xs opacity-60 mt-1">Add your Google credentials in Services → Email & Calendar</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden">
      {/* Main calendar area */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-card/40 flex-shrink-0">
          <button onClick={() => setCreateOpen(true)} className="btn-primary text-xs">
            <Plus className="w-3.5 h-3.5" /> New Event
          </button>
          <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} className="btn-secondary text-xs">
            <RefreshCw className={cn('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')} />
          </button>
          <div className="flex-1" />
          <p className="text-xs text-muted-foreground">
            {events.length} events · All modifications go through outbox
          </p>
        </div>

        {/* Calendar grid — fills remaining space exactly, no scrolling needed */}
        <div ref={calendarScrollRef} className="flex-1 overflow-hidden min-h-0">
          <div ref={calendarWrapperRef} className="sx-calendar-wrapper h-full">
            {isLoading ? (
              <div className="p-6 grid grid-cols-7 gap-2">
                {Array.from({ length: 35 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
              </div>
            ) : (
              <ScheduleXCalendar calendarApp={calendar} />
            )}
          </div>
        </div>

        {/* Google Calendar-style click popup */}
        <AnimatePresence>
          {popupEvent && (
            <EventPopup
              key={popupEvent.eventId}
              event={popupEvent}
              calendars={calendars}
              position={popupPos}
              onClose={() => setPopupEvent(null)}
              onOpenDetail={() => {
                setSelectedEvent(popupEvent);
                setPopupEvent(null);
              }}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Right sidebar — shows EventDetail when an event is selected, otherwise Meeting Notes */}
      <div className="w-[280px] flex-shrink-0 border-l border-border bg-card/50 flex flex-col min-h-0 overflow-hidden">
        <AnimatePresence mode="wait">
          {selectedEvent ? (
            <EventDetail
              key={selectedEvent.eventId}
              event={selectedEvent}
              calendars={calendars}
              onClose={() => setSelectedEvent(null)}
            />
          ) : (
            <MeetingNotesSidebar
              key="notes"
              selectedEventId={null}
              calendarConnected={!!statusData?.connected}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Create modal */}
      <AnimatePresence>
        {createOpen && (
          <CreateEventModal calendars={calendars} onClose={() => setCreateOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
