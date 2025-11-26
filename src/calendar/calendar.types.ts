
export type CompactCalendarSlot = {
  id: string | number;
  tn: string;
  carrier?: string;
  location: string;
  dateTimeFrom: string; // ISO "YYYY-MM-DDTHH:mm:ss"
  dateTimeTo: string; // ISO "YYYY-MM-DDTHH:mm:ss"
  color?: string; // optional explicit color for bar
}

export type WorkingHoursEntry = {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
  weekday?: number[];
  day?: string;
}

export type WorkingHoursMap = Record<string, WorkingHoursEntry[]>;

export type SlotViewModel = {
  id: string | number;
  tn: string;
  carrier?: string;
  left: number; // %
  width: number; // %
  color: string;
  raw: CompactCalendarSlot;
}

export type DragType = 'move' | 'resize-start' | 'resize-end';

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
}

export type SlotPointerDownPayload = {
  event: PointerEvent;
  slot: SlotViewModel;
  location: string;
  type: DragType;
}
