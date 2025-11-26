import {
  Component,
  Input,
  OnInit,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewEncapsulation,
  Output,
  EventEmitter,
  Renderer2,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  CompactCalendarSlot,
  DragContext,
  DragType,
  SlotPointerDownPayload,
  SlotViewModel,
  WorkingHoursMap,
} from './calendar.types';
import { palette } from './calendar.consts';
import { CalendarSlotComponent } from './slot/slot.component';
import { SlotDetailComponent } from './slot-detail/slot-detail.component';

interface CreateContext {
  trackEl: HTMLElement;
  location: string;
  startX: number;
  startMins: number;
  selectionEl: HTMLDivElement;
}

@Component({
  selector: 'app-compact-calendar',
  standalone: true,
  imports: [CommonModule, CalendarSlotComponent, SlotDetailComponent],
  encapsulation: ViewEncapsulation.None,
  templateUrl: './calendar.component.html',
  styleUrls: ['./calendar.component.scss'],
})
export class CompactCalendarComponent implements OnInit, OnChanges, OnDestroy {
  /** Texts shown on the left */
  @Input() dateLabel = '';
  @Input() timeLabel = '06:00 - 24:00';

  /** Slots & working hours */
  @Input() data: CompactCalendarSlot[] = [];
  @Input() workingHours: WorkingHoursMap = {};

  /** Show vertical “now” line when the selected day is today */
  @Input() showNowLine = true;

  /** Emits updated slot when user finishes drag/resizing or creates one */
  @Output() slotChange = new EventEmitter<CompactCalendarSlot>();

  locations: string[] = [];
  slotsByLocation: Record<string, SlotViewModel[]> = {};
  nonWorkingByLocation: Record<string, { left: number; width: number }[]> = {};

  hours = Array.from({ length: 25 }, (_, i) => i); // 0..24 labels

  nowPercent = -1;
  private currentDayStart: Date | null = null;
  private nowTimer: any;

  // drag state
  private dragCtx: DragContext | null = null;

  // transient invalid animation state
  private invalidFlashSlotId: string | number | null = null;
  private invalidFlashTimer: any = null;

  // creation state (for new slots)
  private createCtx: CreateContext | null = null;
  private unlistenMove: (() => void) | null = null;
  private unlistenUp: (() => void) | null = null;

  private readonly minutesInDay = 24 * 60;

  selectedSlot: SlotViewModel | null = null;
  selectedSlotTimeRange = '';

  constructor(private renderer: Renderer2) {}

  ngOnInit(): void {
    this.rebuild();
    this.startNowTimer();
    this.bindGlobalPointerEvents();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data'] || changes['workingHours'] || changes['dateLabel']) {
      this.rebuild();
    }
  }

  ngOnDestroy(): void {
    if (this.nowTimer) {
      clearInterval(this.nowTimer);
    }
    if (this.invalidFlashTimer) {
      clearTimeout(this.invalidFlashTimer);
    }
    this.cleanupGlobalPointerEvents();
  }

  /* ===========================
     Build view model (slots + non-working)
     =========================== */

  private rebuild(): void {
    if (!this.data || this.data.length === 0) {
      this.locations = [];
      this.slotsByLocation = {};
      this.nonWorkingByLocation = {};
      this.nowPercent = -1;
      return;
    }

    const first = this.data[0];
    const day = new Date(first.dateTimeFrom);
    this.currentDayStart = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate()
    );

    if (!this.dateLabel) {
      this.dateLabel = day.toLocaleDateString();
    }

    this.locations = Array.from(new Set(this.data.map((d) => d.location)));

    this.slotsByLocation = {};

    for (const loc of this.locations) {
      const slots = this.data.filter((d) => d.location === loc);
      this.slotsByLocation[loc] = slots.map((s, idx) => {
        const fromM = this.toMinutesFromMidnight(s.dateTimeFrom);
        const toM = this.toMinutesFromMidnight(s.dateTimeTo);
        const clampedFrom = this.snapToStep(
          this.clamp(fromM, 0, this.minutesInDay),
          30
        );
        const clampedTo = this.snapToStep(
          this.clamp(toM, 0, this.minutesInDay),
          30
        );
        const span = Math.max(5, clampedTo - clampedFrom);

        const autoColor =
          palette[
            Math.abs(this.hashCode(String(s.id ?? `${loc}-${idx}`))) %
              palette.length
          ];

        return {
          id: s.id ?? `${loc}-${idx}`,
          tn: s.tn,
          carrier: s.carrier ?? '',
          left: (clampedFrom / this.minutesInDay) * 100,
          width: (span / this.minutesInDay) * 100,
          color: s.color ?? autoColor,
          invalid: false,
          raw: s,
        };
      });
    }

    this.buildNonWorking();
    this.updateNowPercent();
    this.applyInvalidFlash();
  }

  private buildNonWorking(): void {
    this.nonWorkingByLocation = {};

    const toMinutes = (time: string) => {
      const [h, m] = time.split(':').map(Number);
      return h * 60 + m;
    };

    for (const loc of this.locations) {
      const entries = this.workingHours[loc];
      if (!entries || entries.length === 0) {
        this.nonWorkingByLocation[loc] = [];
        continue;
      }
      const wh = entries[0];
      const startWh = toMinutes(wh.start);
      const endWh = toMinutes(wh.end);

      const segs: { start: number; end: number }[] = [];
      if (startWh > 0) segs.push({ start: 0, end: startWh });
      if (endWh < this.minutesInDay)
        segs.push({ start: endWh, end: this.minutesInDay });

      this.nonWorkingByLocation[loc] = segs.map((seg) => ({
        left: (seg.start / this.minutesInDay) * 100,
        width: ((seg.end - seg.start) / this.minutesInDay) * 100,
      }));
    }
  }

  /* ===========================
     Time & working-hours helpers
     =========================== */

  /** parse "YYYY-MM-DDTHH:mm:ss" into minutes from midnight, ignoring timezone */
  private toMinutesFromMidnight(iso: string): number {
    if (!iso) return 0;
    const parts = iso.split('T');
    if (parts.length < 2) return 0;

    const timePart = parts[1]; // "HH:mm:ss" or "HH:mm"
    const [hhStr, mmStr] = timePart.split(':');
    const hh = Number(hhStr ?? 0);
    const mm = Number(mmStr ?? 0);

    const mins = hh * 60 + mm;
    return isFinite(mins) ? mins : 0;
  }

  /** build a new ISO string by keeping the date from baseIso and
   *  replacing the time with the given minutes-from-midnight
   */
  private minutesToIso(baseIso: string, mins: number): string {
    if (!baseIso) return baseIso;
    const [datePart] = baseIso.split('T');
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const hh = h.toString().padStart(2, '0');
    const mm = m.toString().padStart(2, '0');
    return `${datePart}T${hh}:${mm}:00`;
  }

  private clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }

  private snapToStep(mins: number, step = 30): number {
    return Math.round(mins / step) * step;
  }

  /** Get working hours as minutes-from-midnight for a location */
  private getWorkingBounds(
    location: string
  ): { start: number; end: number } | null {
    const entries = this.workingHours[location];
    if (!entries || entries.length === 0) return null;

    const wh = entries[0];
    const [sh, sm] = wh.start.split(':').map(Number);
    const [eh, em] = wh.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (!isFinite(start) || !isFinite(end)) return null;
    return { start, end };
  }

  /* ===========================
     Current-time line
     =========================== */

  private startNowTimer(): void {
    this.updateNowPercent();
    this.nowTimer = setInterval(() => this.updateNowPercent(), 60_000);
  }

  private updateNowPercent(): void {
    if (!this.showNowLine || !this.currentDayStart) {
      this.nowPercent = -1;
      return;
    }

    const now = new Date();
    if (now.toDateString() !== this.currentDayStart.toDateString()) {
      this.nowPercent = -1;
      return;
    }

    const minutes =
      now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

    this.nowPercent = this.clamp((minutes / this.minutesInDay) * 100, 0, 100);
  }

  /* ===========================
     Collision detection
     =========================== */

  private hasConflict(
    slotId: string | number,
    location: string,
    fromMins: number,
    toMins: number
  ): boolean {
    const others = this.data.filter(
      (s) => s.location === location && s.id !== slotId
    );

    return others.some((s) => {
      const a = this.toMinutesFromMidnight(s.dateTimeFrom);
      const b = this.toMinutesFromMidnight(s.dateTimeTo);
      // intervals overlap if not (to <= a or from >= b)
      return !(toMins <= a || fromMins >= b);
    });
  }

  /* ===========================
     Global pointer listeners
     =========================== */

  private bindGlobalPointerEvents(): void {
    this.unlistenMove = this.renderer.listen(
      'window',
      'pointermove',
      (ev: PointerEvent) => this.onWindowPointerMove(ev)
    );
    this.unlistenUp = this.renderer.listen(
      'window',
      'pointerup',
      (ev: PointerEvent) => this.onWindowPointerUp(ev)
    );
  }

  private cleanupGlobalPointerEvents(): void {
    if (this.unlistenMove) {
      this.unlistenMove();
      this.unlistenMove = null;
    }
    if (this.unlistenUp) {
      this.unlistenUp();
      this.unlistenUp = null;
    }
  }

  /* ===========================
     Slot pointer-down from child
     =========================== */

  onSlotPointerDownFromChild(
    payload: SlotPointerDownPayload,
    trackEl: HTMLElement
  ): void {
    const { event, slot: vm, location, type } = payload;

    event.stopPropagation();
    event.preventDefault();

    const trackRect = trackEl.getBoundingClientRect();
    const fromM = this.toMinutesFromMidnight(vm.raw.dateTimeFrom);
    const toM = this.toMinutesFromMidnight(vm.raw.dateTimeTo);

    const startFrom = this.clamp(fromM, 0, this.minutesInDay);
    const startTo = this.clamp(toM, 0, this.minutesInDay);

    this.dragCtx = {
      slotId: vm.id,
      origLocation: location,
      currentLocation: location,
      type,
      trackRect,
      startX: event.clientX,
      startFromMins: startFrom,
      startToMins: startTo,
      currentFromMins: startFrom,
      currentToMins: startTo,
    };

    // cancel any in-progress create
    this.createCtx = null;
  }

  /* ===========================
     Window move / up handler – drag OR create
     =========================== */

  private onWindowPointerMove(event: PointerEvent): void {
    // 1) dragging existing slot
    if (this.dragCtx) {
      const { trackRect, type, startX, startFromMins, startToMins, slotId } =
        this.dragCtx;

      const dx = event.clientX - startX;
      const deltaMinutes = (dx / trackRect.width) * this.minutesInDay;

      let newFrom = startFromMins;
      let newTo = startToMins;
      const minSpan = 30; // minimum slot length in minutes

      if (type === 'move') {
        const span = startToMins - startFromMins;
        let rawFrom = startFromMins + deltaMinutes;
        rawFrom = this.clamp(rawFrom, 0, this.minutesInDay - span);
        newFrom = this.snapToStep(rawFrom, 30);
        newTo = newFrom + span;
      } else if (type === 'resize-start') {
        let rawFrom = startFromMins + deltaMinutes;
        rawFrom = this.clamp(rawFrom, 0, startToMins - minSpan);
        newFrom = this.snapToStep(rawFrom, 30);
      } else if (type === 'resize-end') {
        let rawTo = startToMins + deltaMinutes;
        rawTo = this.clamp(rawTo, startFromMins + minSpan, this.minutesInDay);
        newTo = this.snapToStep(rawTo, 30);
      }

      // which row is under the pointer? (for live move between rows)
      const targetLoc =
        this.getLocationAtPoint(event.clientX, event.clientY) ??
        this.dragCtx.currentLocation;

      this.dragCtx.currentLocation = targetLoc;
      this.dragCtx.currentFromMins = newFrom;
      this.dragCtx.currentToMins = newTo;

      // live update ONLY the view model (no data mutation yet)
      this.updateSlotViewModel(slotId, targetLoc, newFrom, newTo, false);
      return;
    }

    // 2) creating new slot by dragging on empty track
    if (this.createCtx) {
      const { trackEl, startMins, selectionEl } = this.createCtx;
      const rect = trackEl.getBoundingClientRect();

      const relX = this.clamp(event.clientX - rect.left, 0, rect.width);
      const curMins = this.snapToStep(
        (relX / rect.width) * this.minutesInDay,
        30
      );

      const from = Math.min(startMins, curMins);
      const to = Math.max(startMins, curMins);

      const leftPct = (from / this.minutesInDay) * 100;
      const widthPct = ((to - from) / this.minutesInDay) * 100;

      selectionEl.style.left = `${leftPct}%`;
      selectionEl.style.width = `${widthPct}%`;
      return;
    }
  }

  private onWindowPointerUp(event: PointerEvent): void {
    // 1) finish drag/resize
    if (this.dragCtx) {
      const { slotId, currentLocation, currentFromMins, currentToMins } =
        this.dragCtx;

      const targetLoc =
        this.getLocationAtPoint(event.clientX, event.clientY) ||
        currentLocation;

      const bounds = this.getWorkingBounds(targetLoc);

      const outOfWorking =
        !!bounds &&
        (currentFromMins < bounds.start || currentToMins > bounds.end);

      const conflict = this.hasConflict(
        slotId,
        targetLoc,
        currentFromMins,
        currentToMins
      );

      if (conflict || outOfWorking) {
        // revert completely to original state
        this.rebuild();
        this.flashInvalid(slotId);
      } else {
        // commit new time & (possibly new) location into data
        this.commitDragToData(
          slotId,
          targetLoc,
          currentFromMins,
          currentToMins
        );
      }

      this.dragCtx = null;
      return;
    }

    // 2) finish creation
    if (this.createCtx) {
      const { trackEl, location, startMins, selectionEl } = this.createCtx;
      const rect = trackEl.getBoundingClientRect();

      selectionEl.remove();
      this.createCtx = null;

      const relX = this.clamp(event.clientX - rect.left, 0, rect.width);
      const curMins = this.snapToStep(
        (relX / rect.width) * this.minutesInDay,
        30
      );

      let from = Math.min(startMins, curMins);
      let to = Math.max(startMins, curMins);

      const minSpan = 30;
      if (to - from < minSpan) {
        return;
      }

      const bounds = this.getWorkingBounds(location);
      if (bounds && (from < bounds.start || to > bounds.end)) {
        return;
      }

      const conflict = this.hasConflict(null as any, location, from, to);
      if (conflict) {
        return;
      }

      const baseIso = this.data[0]?.dateTimeFrom ?? new Date().toISOString();

      const fromIso = this.minutesToIso(baseIso, from);
      const toIso = this.minutesToIso(baseIso, to);

      const newId = (window as any).crypto?.randomUUID
        ? (window as any).crypto.randomUUID()
        : `slot-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const newSlot: CompactCalendarSlot = {
        id: newId,
        tn: 'NEW',
        carrier: '',
        location,
        dateTimeFrom: fromIso,
        dateTimeTo: toIso,
      };

      this.data = [...this.data, newSlot];
      this.rebuild();
      this.slotChange.emit(newSlot);

      return;
    }
  }

  /* ===========================
     New slot creation – track pointerdown
     =========================== */

  onTrackPointerDown(
    event: PointerEvent,
    trackEl: HTMLElement,
    location: string
  ): void {
    if (event.button !== 0) return;

    // if clicked on a slot, ignore (slot has its own handler)
    const targetSlot = (event.target as HTMLElement | null)?.closest('.slot');
    if (targetSlot) return;

    event.stopPropagation();
    event.preventDefault();

    const rect = trackEl.getBoundingClientRect();

    const relX = this.clamp(event.clientX - rect.left, 0, rect.width);
    const startMins = this.snapToStep(
      (relX / rect.width) * this.minutesInDay,
      30
    );

    const selection = document.createElement('div');
    selection.className = 'slot-selection';
    selection.style.position = 'absolute';
    selection.style.top = '7px';
    selection.style.height = '44px';
    selection.style.borderRadius = '12px';
    selection.style.background = 'rgba(59,130,246,0.25)';
    selection.style.pointerEvents = 'none';
    selection.style.left = '0';
    selection.style.width = '0';
    selection.style.zIndex = '2';

    trackEl.appendChild(selection);

    this.createCtx = {
      trackEl,
      location,
      startX: event.clientX,
      startMins,
      selectionEl: selection,
    };

    // cancel any in-progress drag
    this.dragCtx = null;
  }

  /* ===========================
     Helpers
     =========================== */

  /** Find location (row) under the given screen point */
  private getLocationAtPoint(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;

    const row = el.closest('.cal-row') as HTMLElement | null;
    if (!row) return null;

    const loc = row.getAttribute('data-location');
    return loc || null;
  }

  /** Update slot position & row in the view-model only (for live dragging) */
  private updateSlotViewModel(
    slotId: string | number,
    location: string,
    fromMins: number,
    toMins: number,
    invalid = false
  ): void {
    let vm: SlotViewModel | null = null;

    for (const loc of this.locations) {
      const list = this.slotsByLocation[loc];
      if (!list) continue;
      const idx = list.findIndex((s) => s.id === slotId);
      if (idx >= 0) {
        vm = list[idx];
        list.splice(idx, 1);
        break;
      }
    }
    if (!vm) return;

    const clampedFrom = this.snapToStep(
      this.clamp(fromMins, 0, this.minutesInDay),
      30
    );
    const clampedTo = this.snapToStep(
      this.clamp(toMins, 0, this.minutesInDay),
      30
    );
    const span = Math.max(5, clampedTo - clampedFrom);

    const left = (clampedFrom / this.minutesInDay) * 100;
    const width = (span / this.minutesInDay) * 100;

    if (!this.slotsByLocation[location]) {
      this.slotsByLocation[location] = [];
    }

    this.slotsByLocation[location].push({
      ...vm,
      left,
      width,
      invalid,
    });
  }

  private flashInvalid(slotId: string | number): void {
    // Ensure only one slot shows the transient invalid state at a time.
    this.clearInvalidFlags();

    this.invalidFlashSlotId = slotId;
    this.applyInvalidFlash();

    if (this.invalidFlashTimer) {
      clearTimeout(this.invalidFlashTimer);
    }

    this.invalidFlashTimer = setTimeout(() => {
      this.invalidFlashSlotId = null;
      this.invalidFlashTimer = null;
      this.clearInvalidFlags();
    }, 700);
  }

  private applyInvalidFlash(): void {
    if (this.invalidFlashSlotId == null) return;

    for (const loc of this.locations) {
      const slot = this.slotsByLocation[loc]?.find(
        (s) => s.id === this.invalidFlashSlotId
      );
      if (slot) {
        slot.invalid = true;
        break;
      }
    }
  }

  private clearInvalidFlags(): void {
    for (const loc of this.locations) {
      const list = this.slotsByLocation[loc];
      if (!list) continue;
      for (const slot of list) {
        if (slot.invalid) {
          slot.invalid = false;
        }
      }
    }
  }

  /** Commit the final drag result into the underlying data */
  private commitDragToData(
    slotId: string | number,
    newLocation: string,
    newFrom: number,
    newTo: number
  ): void {
    const fromClamped = this.snapToStep(
      this.clamp(newFrom, 0, this.minutesInDay),
      30
    );
    const toClamped = this.snapToStep(
      this.clamp(newTo, 0, this.minutesInDay),
      30
    );

    const updated: CompactCalendarSlot[] = this.data.map((slot) => {
      if (slot.id !== slotId) return slot;

      return {
        ...slot,
        location: newLocation,
        dateTimeFrom: this.minutesToIso(slot.dateTimeFrom, fromClamped),
        dateTimeTo: this.minutesToIso(slot.dateTimeTo, toClamped),
      };
    });

    this.data = updated;
    this.rebuild();

    const updatedSlot = this.data.find((s) => s.id === slotId);
    if (updatedSlot) {
      this.slotChange.emit(updatedSlot);
    }
  }

  private hashCode(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return h;
  }

  onSlotClick(slotFromCalendar: SlotViewModel): void {
    if (this.selectedSlot?.id === slotFromCalendar.id) {
      return;
    }

    this.selectedSlot = { ...slotFromCalendar, color: slotFromCalendar.color };
  }

  // ak potrebuješ slot zavrieť z parenta:
  clearSlot(): void {
    this.selectedSlot = null;
  }
}

/** Re-export types so you can import from the component if you like */
export type { CompactCalendarSlot, WorkingHoursMap } from './calendar.types';
