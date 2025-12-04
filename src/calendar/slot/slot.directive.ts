// slot-drag.directive.ts
import {
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  NgZone,
  OnDestroy,
  Output,
} from '@angular/core';
import { DragType, SlotViewModel } from '../calendar.types';

/**
 * Event payload surfaced on drag move/end to the host component.
 *
 * Consumers receive the slot id, location, drag type, and the current minutes
 * from/to snapshot so they can update the in-progress view model or finalize a
 * drop. The directive does not enforce calendar business rules—those stay in
 * the parent component.
 */
export type SlotDragEvent = {
  slotId: string | number;
  location: string;
  type: DragType;
  fromMins: number;
  toMins: number;
};

/**
 * Internal bookkeeping for an active drag interaction.
 *
 * This context caches measurements and the original slot times so pointer move
 * math can be performed without repeatedly reading from the DOM or the view
 * model. The state is reset on pointerup.
 */
interface InternalDragCtx {
  type: DragType;
  slotId: string | number;
  origLocation: string;
  currentLocation: string;
  trackRect: DOMRect;
  startX: number;
  startFromMins: number;
  startToMins: number;
  currentFromMins: number;
  currentToMins: number;
}

@Directive({
  selector: '[appSlotDrag]',
  standalone: true,
})
/**
 * Standalone directive that wires low-level pointer handling for a slot element
 * and emits granular drag lifecycle events to the host calendar.
 *
 * Responsibilities:
 * - Detect whether the user initiated a move or resize (left/right handle).
 * - Track pointer movement against the timeline width and convert pixels to
 *   minutes-from-midnight, snapping to the provided step.
 * - Enforce a minimum span while resizing and clamp to the day's bounds.
 * - Detect the calendar row under the pointer so cross-row moves are possible.
 * - Emit `dragStart`, `dragMove`, and `dragEnd` so the calendar component can
 *   handle validation and state updates.
 *
 * The directive intentionally avoids business logic like conflict detection or
 * persistence; it only surfaces raw position data for the host to interpret.
 */
export class SlotDragDirective implements OnDestroy {
  /** Slot view model of this element. */
  @Input('appSlotDrag') slot!: SlotViewModel;

  /** Current row / location name. */
  @Input() slotLocation!: string;

  /** Minutes in a day – keep in sync with parent. */
  @Input() minutesInDay = 24 * 60;

  /** Snap step in minutes. */
  @Input() snapStep = 30;

  /** Emitted immediately after pointer-down captures the drag context. */
  @Output() dragStart = new EventEmitter<SlotDragEvent>();

  /** Emitted on every pointer move with live position. */
  @Output() dragMove = new EventEmitter<SlotDragEvent>();

  /** Emitted once on pointerup with final position. */
  @Output() dragEnd = new EventEmitter<SlotDragEvent>();

  private dragCtx: InternalDragCtx | null = null;

  constructor(private el: ElementRef<HTMLElement>, private zone: NgZone) {}

  /** Remove global listeners when the directive is destroyed. */
  ngOnDestroy(): void {
    this.detachWindowListeners();
  }

  /* ============ HOST POINTER DOWN ============ */

  @HostListener('pointerdown', ['$event'])
  /**
   * Capture the starting drag state when the user clicks a slot or one of its
   * resize handles. This handler attaches global listeners to continue tracking
   * the pointer outside the host element.
   */
  onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;

    const target = ev.target as HTMLElement | null;
    if (!target) return;

    let type: DragType = 'move';

    if (target.closest('.h-left')) {
      type = 'resize-start';
    } else if (target.closest('.h-right')) {
      type = 'resize-end';
    } else if (!target.closest('.slot')) {
      // clicked something else – ignore
      return;
    }

    ev.stopPropagation();
    ev.preventDefault();

    // Capture the pointer so subsequent moves are consistently delivered even
    // when the cursor leaves the slot during a drag. This also avoids the
    // browser initiating native text selection while resizing.
    try {
      this.el.nativeElement.setPointerCapture(ev.pointerId);
    } catch {
      // Some environments may not support pointer capture; continue gracefully.
    }

    const trackEl = this.findTrackElement();
    if (!trackEl) return;

    const trackRect = trackEl.getBoundingClientRect();

    const fromM = this.toMinutesFromMidnight(this.slot.raw.dateTimeFrom);
    const toM = this.toMinutesFromMidnight(this.slot.raw.dateTimeTo, true);

    const startFrom = this.clamp(fromM, 0, this.minutesInDay);
    const startTo = this.clamp(toM, 0, this.minutesInDay);

    this.dragCtx = {
      type,
      slotId: this.slot.id,
      origLocation: this.slotLocation,
      currentLocation: this.slotLocation,
      trackRect,
      startX: ev.clientX,
      startFromMins: startFrom,
      startToMins: startTo,
      currentFromMins: startFrom,
      currentToMins: startTo,
    };

    this.dragStart.emit({
      slotId: this.slot.id,
      location: this.slotLocation,
      type,
      fromMins: startFrom,
      toMins: startTo,
    });

    this.attachWindowListeners();
  }

  /* ============ WINDOW POINTER MOVE / UP ============ */

  /**
   * Track pointer movement and emit live drag progress.
   *
   * The handler derives delta minutes from the track width, applies snapping
   * and clamping for move/resize variants, and surfaces the row currently under
   * the pointer so the host can provide cross-row previews.
   */
  private onWindowPointerMove = (ev: PointerEvent) => {
    this.zone.run(() => {
      if (!this.dragCtx) return;

      const {
        trackRect,
        type,
        startX,
        startFromMins,
        startToMins,
        slotId,
        currentLocation,
      } = this.dragCtx;

      const dx = ev.clientX - startX;
      const deltaMinutes = (dx / trackRect.width) * this.minutesInDay;

      let newFrom = startFromMins;
      let newTo = startToMins;
      const minSpan = 30;

      if (type === 'move') {
        const span = startToMins - startFromMins;
        let rawFrom = startFromMins + deltaMinutes;
        rawFrom = this.clamp(rawFrom, 0, this.minutesInDay - span);
        newFrom = this.snap(rawFrom);
        newTo = newFrom + span;
      } else if (type === 'resize-start') {
        let rawFrom = startFromMins + deltaMinutes;
        rawFrom = this.clamp(rawFrom, 0, startToMins - minSpan);
        newFrom = this.snap(rawFrom);
      } else if (type === 'resize-end') {
        let rawTo = startToMins + deltaMinutes;
        rawTo = this.clamp(rawTo, startFromMins + minSpan, this.minutesInDay);
        newTo = this.snap(rawTo);
      }

      // which row are we over?
      const targetLoc =
        this.getLocationAtPoint(ev.clientX, ev.clientY) ?? currentLocation;

      this.dragCtx.currentLocation = targetLoc;
      this.dragCtx.currentFromMins = newFrom;
      this.dragCtx.currentToMins = newTo;

      this.dragMove.emit({
        slotId,
        location: targetLoc,
        type,
        fromMins: newFrom,
        toMins: newTo,
      });
    });
  };

  /**
   * Emit the final drag state and tear down listeners.
   *
   * On release, the directive reports the latest minutes and pointer row to the
   * host so it can validate and commit the move/resize. Global listeners are
   * removed to avoid leaks.
   */
  private onWindowPointerUp = (ev: PointerEvent) => {
    this.zone.run(() => {
      if (!this.dragCtx) return;

      const { slotId, currentLocation, currentFromMins, currentToMins, type } =
        this.dragCtx;

      const targetLoc =
        this.getLocationAtPoint(ev.clientX, ev.clientY) || currentLocation;

      this.dragEnd.emit({
        slotId,
        location: targetLoc,
        type,
        fromMins: currentFromMins,
        toMins: currentToMins,
      });

      this.dragCtx = null;
      this.detachWindowListeners();

      try {
        this.el.nativeElement.releasePointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
    });
  };

  /* ============ HELPERS ============ */

  /** Subscribe to global pointer events for the active drag session. */
  private attachWindowListeners(): void {
    window.addEventListener('pointermove', this.onWindowPointerMove);
    window.addEventListener('pointerup', this.onWindowPointerUp);
  }

  /** Remove global pointer subscriptions. */
  private detachWindowListeners(): void {
    window.removeEventListener('pointermove', this.onWindowPointerMove);
    window.removeEventListener('pointerup', this.onWindowPointerUp);
  }

  /**
   * Find the row track element that owns this slot.
   *
   * The host is the slot element itself; the nearest `.rtrack` ancestor defines
   * the horizontal rail used for width/position calculations. Null is returned
   * if the slot is detached from the DOM (should not happen during normal use).
   */
  private findTrackElement(): HTMLElement | null {
    // .slot is host; track is closest .rtrack up the tree
    return this.el.nativeElement.closest('.rtrack') as HTMLElement | null;
  }

  /** Determine which row is under the pointer position. */
  private getLocationAtPoint(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    const row = el.closest('.cal-row') as HTMLElement | null;
    if (!row) return null;
    const loc = row.getAttribute('data-location');
    return loc || null;
  }

  /** Convert an ISO string to minutes-from-midnight (local). */
  private toMinutesFromMidnight(
    iso: string,
    treatMidnightAsNextDay = false
  ): number {
    if (!iso) return 0;
    const [_, timePart] = iso.split('T');
    if (!timePart) return 0;
    const [hhStr, mmStr] = timePart.split(':');
    const hh = Number(hhStr ?? 0);
    const mm = Number(mmStr ?? 0);
    const mins = hh * 60 + mm;
    if (treatMidnightAsNextDay && mins === 0) {
      return this.minutesInDay;
    }
    return isFinite(mins) ? mins : 0;
  }

  /** Restrict a value to a range. */
  private clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }

  /** Snap minutes to the configured step. */
  private snap(mins: number): number {
    return Math.round(mins / this.snapStep) * this.snapStep;
  }
}
