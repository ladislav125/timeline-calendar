
/**
 * Raw slot information provided to the calendar. All times are expressed as
 * ISO strings and the identifier is echoed back through change events.
 */
export type CompactCalendarSlot = {
  id: string | number;
  tn: string;
  carrier?: string;
  location: string;
  dateTimeFrom: string; /** ISO "YYYY-MM-DDTHH:mm:ss" */
  dateTimeTo: string; /** ISO "YYYY-MM-DDTHH:mm:ss" */
  color?: string; /** Optional explicit color for the bar. */
};

/** Start/end pair that defines the allowed working range for a given location. */
export type WorkingHoursEntry = {
  start: string; /** "HH:mm" */
  end: string; /** "HH:mm" */
  weekday?: number[];
  day?: string;
};

/** Lookup of working-hour definitions keyed by location. */
export type WorkingHoursMap = Record<string, WorkingHoursEntry[]>;

/** Normalized view model used by the calendar template. */
export type SlotViewModel = {
  id: string | number;
  tn: string;
  carrier?: string;
  left: number; /** Percentage left offset within the track. */
  width: number; /** Percentage width within the track. */
  color: string;
  invalid?: boolean;
  raw: CompactCalendarSlot;
};

/** Drag intent for an interaction. */
export type DragType = 'move' | 'resize-start' | 'resize-end';

/**
 * Internal drag bookkeeping used to compute deltas during a pointer session.
 */
export type DragContext = {
  slotId: string | number;
  origLocation: string;
  currentLocation: string;
  type: DragType;
  trackRect: DOMRect;
  startX: number;
  startFromMins: number;
  startToMins: number;
  currentFromMins: number;
  currentToMins: number;
};

/** Event payload emitted when a slot begins a pointer interaction. */
export type SlotPointerDownPayload = {
  event: PointerEvent;
  slot: SlotViewModel;
  location: string;
  type: DragType;
};
