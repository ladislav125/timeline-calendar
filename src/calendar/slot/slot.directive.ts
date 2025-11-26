// slot-drag.directive.ts
import {
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  Output,
} from '@angular/core';
import { DragType, SlotViewModel } from '../calendar.types';

/** Event payload surfaced on drag move/end to the host component. */
export type SlotDragEvent = {
  slotId: string | number;
  location: string;
  type: DragType;
  fromMins: number;
  toMins: number;
};

/** Internal bookkeeping for an active drag interaction. */
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
})
/**
 * Standalone directive that wires low-level pointer handling for a slot element
 * and emits granular drag progress/finalization events. This file mirrors the
 * calendar component's logic but is not currently wired in the template; it is
 * preserved for parity with earlier implementations.
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

  /** Emitted on every pointer move with live position. */
  @Output() dragMove = new EventEmitter<SlotDragEvent>();

  /** Emitted once on pointerup with final position. */
  @Output() dragEnd = new EventEmitter<SlotDragEvent>();

  private dragCtx: InternalDragCtx | null = null;

  constructor(private el: ElementRef<HTMLElement>) {}

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

    const trackEl = this.findTrackElement();
    if (!trackEl) return;

    const trackRect = trackEl.getBoundingClientRect();

    const fromM = this.toMinutesFromMidnight(this.slot.raw.dateTimeFrom);
    const toM = this.toMinutesFromMidnight(this.slot.raw.dateTimeTo);

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

    this.attachWindowListeners();
  }

  /* ============ WINDOW POINTER MOVE / UP ============ */

  /** Track pointer movement and emit live drag progress. */
  private onWindowPointerMove = (ev: PointerEvent) => {
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
  };

  /** Emit the final drag state and tear down listeners. */
  private onWindowPointerUp = (ev: PointerEvent) => {
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
  private toMinutesFromMidnight(iso: string): number {
    if (!iso) return 0;
    const [_, timePart] = iso.split('T');
    if (!timePart) return 0;
    const [hhStr, mmStr] = timePart.split(':');
    const hh = Number(hhStr ?? 0);
    const mm = Number(mmStr ?? 0);
    const mins = hh * 60 + mm;
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
