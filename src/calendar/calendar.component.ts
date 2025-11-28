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
  ElementRef,
  ViewChildren,
  QueryList,
  AfterViewInit,
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
import { Subscription } from 'rxjs';

/**
 * Internal state captured when the user drags on an empty row to create a brand
 * new slot. It keeps the original pointer position, the selected location and
 * the ephemeral selection element that is stretched while the pointer moves.
 */
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
/**
 * Compact calendar view that renders a time-based grid grouped by locations.
 *
 * The component:
 * - normalizes incoming slot data into view models snapped to 30-minute steps
 * - shows working-hour gaps per location so users can see blocked ranges
 * - supports dragging, resizing, and cross-row moves with collision detection
 * - prevents placing slots in conflicting or non-working periods and flashes a
 *   transient invalid animation when a move is reverted
 * - emits `slotChange` whenever the user commits a valid drag, resize, or
 *   creation so the host application can persist the change
 */
export class CompactCalendarComponent
  implements OnInit, OnChanges, OnDestroy, AfterViewInit
{
  /** Texts shown on the left */
  @Input() dateLabel = '';
  @Input() timeLabel = '06:00 - 24:00';

  /** Raw slot data provided by the host application. */
  @Input() data: CompactCalendarSlot[] = [];
  /** Working hours per location that define the allowed placement window. */
  @Input() workingHours: WorkingHoursMap = {};

  /** Whether to render a vertical “now” indicator when viewing the current day. */
  @Input() showNowLine = true;

  /** Emits an updated slot when the user commits a drag, resize, or creation. */
  @Output() slotChange = new EventEmitter<CompactCalendarSlot>();

  /** Unique locations derived from the input data, used to render rows. */
  locations: string[] = [];
  /** Normalized slot view models keyed by location for easy rendering. */
  slotsByLocation: Record<string, SlotViewModel[]> = {};
  /** Non-working ranges per location expressed as percentages of the track. */
  nonWorkingByLocation: Record<string, { left: number; width: number }[]> = {};

  /** Hour labels for the header timeline (0–24). */
  hours = Array.from({ length: 25 }, (_, i) => i);

  /** Current "now" indicator position (0–100) or -1 when hidden. */
  nowPercent = -1;
  /** Calculated CSS left offset that anchors the now-line to the timeline only. */
  nowLineLeft = '';
  /** Track elements used to measure actual timeline width for the now-line. */
  @ViewChildren('track') trackEls!: QueryList<ElementRef<HTMLElement>>;
  /** Subscription to track list changes for recalculating the now marker. */
  private trackChangeSub: Subscription | null = null;
  /** Window resize listener that realigns the now marker as widths change. */
  private unlistenResize: (() => void) | null = null;
  /** Start-of-day marker for the current dataset, used for "now" detection. */
  private currentDayStart: Date | null = null;
  /** Interval ID used to refresh the moving "now" indicator. */
  private nowTimer: any;

  /** Drag/resizing context captured when pointer-down begins on a slot. */
  private dragCtx: DragContext | null = null;

  /**
   * Tracks which slot should temporarily show the invalid animation after a
   * reverted drop, along with the timeout that clears the state.
   */
  private invalidFlashSlotId: string | number | null = null;
  private invalidFlashTimer: any = null;

  /** Pointer-drag creation context and global event teardown callbacks. */
  private createCtx: CreateContext | null = null;
  private unlistenMove: (() => void) | null = null;
  private unlistenUp: (() => void) | null = null;

  /** Constant representing the total minutes contained in one day. */
  private readonly minutesInDay = 24 * 60;

  /** Slot currently opened in the detail badge. */
  selectedSlot: SlotViewModel | null = null;
  selectedSlotTimeRange = '';

  /**
   * Warning message shown when a slot creation attempt is invalid due to
   * collisions or non-working hours. Displayed as a red badge similar to the
   * standard slot detail card.
   */
  creationWarning: { reason: 'conflict' | 'nonwork'; message: string } | null =
    null;
  /** Timeout that auto-hides the creation warning badge. */
  private creationWarningTimer: any = null;

  constructor(
    private renderer: Renderer2,
    private hostEl: ElementRef<HTMLElement>
  ) {}

  /**
   * Normalize incoming data, prime the moving "now" indicator, and install
   * global pointer listeners used to monitor drag interactions outside of the
   * component's template.
   */
  ngOnInit(): void {
    this.rebuild();
    this.startNowTimer();
    this.bindGlobalPointerEvents();
  }

  /**
   * Wait for the view to render so track widths are available for measuring the
   * now-line offset, then subscribe to width-affecting events such as DOM
   * changes and window resizes to keep the marker aligned.
   */
  ngAfterViewInit(): void {
    this.realignNowLine();

    this.trackChangeSub = this.trackEls.changes.subscribe(() =>
      this.realignNowLine()
    );

    this.unlistenResize = this.renderer.listen('window', 'resize', () =>
      this.realignNowLine()
    );
  }

  /**
   * Rebuild the view model whenever slot data, working hours, or the displayed
   * date label changes. This keeps rendered positions in sync with the latest
   * inputs.
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data'] || changes['workingHours'] || changes['dateLabel']) {
      this.rebuild();
    }
  }

  /** Tear down timers and global listeners when the component is destroyed. */
  ngOnDestroy(): void {
    if (this.nowTimer) {
      clearInterval(this.nowTimer);
    }
    if (this.invalidFlashTimer) {
      clearTimeout(this.invalidFlashTimer);
    }
    if (this.creationWarningTimer) {
      clearTimeout(this.creationWarningTimer);
    }
    this.cleanupGlobalPointerEvents();

    if (this.trackChangeSub) {
      this.trackChangeSub.unsubscribe();
    }

    if (this.unlistenResize) {
      this.unlistenResize();
    }
  }

  /* ===========================
     Build view model (slots + non-working)
     =========================== */

  /**
   * Recompute internal view models from the latest input data. Slots are
   * snapped to the 30-minute grid, auto-colored (when needed), grouped by
   * location, and paired with non-working overlays and the current-time marker.
   */
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

  /**
   * Translate working-hour definitions into track overlays that highlight the
   * periods where the user cannot drop a slot. The overlays are stored as
   * percentages for easy binding in the template.
   */
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

  /**
   * Parse an ISO string (YYYY-MM-DDTHH:mm:ss) into absolute minutes from
   * midnight. The conversion intentionally ignores time zones because the
   * compact calendar operates in the provided local day context.
   */
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

  /**
   * Build a new ISO date-time by combining the date portion of `baseIso` with
   * a time derived from minutes-from-midnight. Seconds are zero-padded so
   * emitted values are deterministic.
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

  /** Restrict `v` between `min` and `max`. */
  private clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }

  /** Snap minutes to the nearest `step` (defaults to 30-minute increments). */
  private snapToStep(mins: number, step = 30): number {
    return Math.round(mins / step) * step;
  }

  /** Get working hours as minutes-from-midnight for a location. */
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

  /**
   * Kick off a periodic refresh of the "now" indicator so the vertical line
   * tracks the current time while the view is open.
   */
  private startNowTimer(): void {
    this.updateNowPercent();
    this.nowTimer = setInterval(() => this.updateNowPercent(), 60_000);
  }

  /**
   * Compute the percent-based position of the current time. If the displayed
   * day is not today or the indicator is disabled, the marker is hidden by
   * setting the value to -1.
   */
  private updateNowPercent(): void {
    if (!this.showNowLine || !this.currentDayStart) {
      this.setNowLine(-1);
      return;
    }

    const now = new Date();
    if (now.toDateString() !== this.currentDayStart.toDateString()) {
      this.setNowLine(-1);
      return;
    }

    const minutes =
      now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

    this.setNowLine(
      this.clamp((minutes / this.minutesInDay) * 100, 0, 100)
    );
  }

  /**
   * Persist the clamped now-line percent and translate it to a CSS offset that
   * ignores the fixed label column. Using a `calc` expression prevents movement
   * on window resizes because the percentage scales with the timeline width
   * only, not the entire container.
   */
  private setNowLine(percent: number): void {
    this.nowPercent = percent;

    if (percent < 0) {
      this.nowLineLeft = '';
      return;
    }

    this.nowLineLeft = this.computeNowLineLeft(percent);
  }

  /**
   * Recompute the now-line's left offset without changing the stored percent.
   * This is invoked when layout changes (e.g., window resize or scrollbar
   * shifts) to keep the marker aligned with the timeline grid.
   */
  private realignNowLine(): void {
    if (this.nowPercent < 0) {
      return;
    }

    this.nowLineLeft = this.computeNowLineLeft(this.nowPercent);
  }

  /**
   * Translate a percent-of-day value to a concrete left CSS value. When track
   * elements are available, their measured widths (minus the label column and
   * any scrollbars) are used for pixel-perfect alignment. Otherwise, the
   * component falls back to the percentage-based calc used previously.
   */
  private computeNowLineLeft(percent: number): string {
    const ratio = percent / 100;
    const trackEl = this.trackEls?.first?.nativeElement;
    const hostRect = this.hostEl.nativeElement.getBoundingClientRect();

    if (trackEl) {
      const trackRect = trackEl.getBoundingClientRect();
      const leftPx = trackRect.left - hostRect.left + trackRect.width * ratio;
      return `${leftPx}px`;
    }

    return `calc(var(--label-col-width) + (100% - var(--label-col-width)) * ${ratio})`;
  }

  /* ===========================
     Collision detection
     =========================== */

  /**
   * Determine whether the proposed interval for a slot collides with any other
   * slot in the same location. Overlap is detected using half-open interval
   * checks to mirror scheduling semantics.
   */
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

  /**
   * Listen to global pointermove/up events so drags continue to update even
   * when the pointer leaves the slot or row bounds.
   */
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

  /** Remove global pointer listeners to avoid leaks. */
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

  /**
   * Initialize drag/resizing when a pointer-down occurs on a slot child
   * component. Stores the starting geometry and slot bounds so subsequent
   * pointer moves can calculate deltas and live updates.
   */
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

  /**
   * Global pointer-move handler that drives two flows:
   * 1) Live drag/resize updates of existing slots with snap-to-grid rounding.
   * 2) Live visualization of a new slot being created on an empty track.
   */
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
      const { trackEl, startMins, selectionEl, location } = this.createCtx;
      const rect = trackEl.getBoundingClientRect();

      const relX = this.clamp(event.clientX - rect.left, 0, rect.width);
      const curMins = this.snapToStep(
        (relX / rect.width) * this.minutesInDay,
        30
      );

      const from = Math.min(startMins, curMins);
      const to = Math.max(startMins, curMins);

      const bounds = this.getWorkingBounds(location);
      const outOfWorking =
        !!bounds && (from < bounds.start || to > bounds.end);
      const conflict = this.hasConflict(null as any, location, from, to);

      const invalid = conflict || outOfWorking;

      const leftPct = (from / this.minutesInDay) * 100;
      const widthPct = ((to - from) / this.minutesInDay) * 100;

      selectionEl.style.left = `${leftPct}%`;
      selectionEl.style.width = `${widthPct}%`;
      selectionEl.classList.toggle('invalid', invalid);

      if (invalid) {
        this.showCreationWarning(conflict ? 'conflict' : 'nonwork');
      } else {
        this.clearCreationWarning();
      }
      return;
    }
  }

  /**
   * Complete either a drag/resize or a slot creation. Drops are validated
   * against working hours and collisions; invalid drops revert and briefly
   * animate, while valid drops persist and emit `slotChange`.
   */
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
        this.showCreationWarning('nonwork');
        return;
      }

      const conflict = this.hasConflict(null as any, location, from, to);
      if (conflict) {
        this.showCreationWarning('conflict');
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

      this.clearCreationWarning();

      return;
    }
  }

  /* ===========================
     New slot creation – track pointerdown
     =========================== */

  /**
   * Begin the slot-creation flow when the user drags on an empty portion of a
   * track. A temporary selection element is appended for visual feedback until
   * the pointer is released.
   */
  onTrackPointerDown(
    event: PointerEvent,
    trackEl: HTMLElement,
    location: string
  ): void {
    if (event.button !== 0) return;

    this.clearCreationWarning();

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

  /** Find location (row) under the given screen point. */
  private getLocationAtPoint(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;

    const row = el.closest('.cal-row') as HTMLElement | null;
    if (!row) return null;

    const loc = row.getAttribute('data-location');
    return loc || null;
  }

  /**
   * Update slot position & row in the in-memory view model. This enables live
   * drag previews without mutating the underlying data until the drop is
   * validated.
   */
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

  /**
   * Show a transient invalid animation on a slot after a reverted drop,
   * clearing any previous flashes so only one slot shakes at once.
   */
  private flashInvalid(slotId: string | number): void {
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

  /** Apply the transient invalid flag to the current flash target. */
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

  /** Remove invalid flags from every slot view model. */
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

  /**
   * Surface a warning badge when slot creation is blocked by conflicts or
   * non-working hours. The badge auto-hides after a short delay.
   */
  private showCreationWarning(reason: 'conflict' | 'nonwork'): void {
    const message =
      reason === 'conflict'
        ? 'Cannot create a slot here because it overlaps an existing slot.'
        : 'Cannot create a slot here because it falls outside working hours.';

    this.creationWarning = { reason, message };

    if (this.creationWarningTimer) {
      clearTimeout(this.creationWarningTimer);
    }

    this.creationWarningTimer = setTimeout(() => {
      this.creationWarning = null;
      this.creationWarningTimer = null;
    }, 2500);
  }

  /** Hide the creation warning and clear any pending timeout. */
  private clearCreationWarning(): void {
    if (this.creationWarningTimer) {
      clearTimeout(this.creationWarningTimer);
      this.creationWarningTimer = null;
    }
    this.creationWarning = null;
  }

  /** Commit the final drag result into the underlying data. */
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

  /** Simple hash helper to deterministically pick a palette color. */
  private hashCode(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return h;
  }

  /** Open slot details unless the same slot is already selected. */
  onSlotClick(slotFromCalendar: SlotViewModel): void {
    if (this.selectedSlot?.id === slotFromCalendar.id) {
      return;
    }

    this.selectedSlot = { ...slotFromCalendar, color: slotFromCalendar.color };
  }

  // ak potrebuješ slot zavrieť z parenta:
  /** Imperative API for parents to close the slot detail badge. */
  clearSlot(): void {
    this.selectedSlot = null;
  }
}

/** Re-export types so you can import from the component if you like */
export type { CompactCalendarSlot, WorkingHoursMap } from './calendar.types';
