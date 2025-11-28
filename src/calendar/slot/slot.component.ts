<<<<<<< codex/fix-calendar-time-slot-snapping-issue-wy1yxj
import {
=======
import {
>>>>>>> main
  Component,
  EventEmitter,
  Input,
  Output,
  ViewEncapsulation,
<<<<<<< codex/fix-calendar-time-slot-snapping-issue-wy1yxj
} from '@angular/core';
import { SlotViewModel } from '../calendar.types';
import { SlotInvalidDirective } from './slot-invalid.directive';
import { SlotDragDirective, SlotDragEvent } from './slot.directive';

=======
} from '@angular/core';
import { DragType, SlotViewModel } from '../calendar.types';
import { SlotInvalidDirective } from './slot-invalid.directive';

/** Payload used to bubble pointer-down interactions to the calendar host. */
export interface SlotPointerDownPayload {
  event: PointerEvent;
  slot: SlotViewModel;
  location: string;
  type: DragType;
}

>>>>>>> main
@Component({
  selector: 'app-compact-calendar-slot',
  standalone: true,
  encapsulation: ViewEncapsulation.Emulated,
  imports: [SlotInvalidDirective, SlotDragDirective],
  templateUrl: './slot.component.html',
  styleUrls: ['./slot.component.scss'],
})
/**
 * Presentational slot chip that exposes pointer and click events for the parent
 * calendar to handle dragging/resizing. It also accepts an `invalid` flag that
 * triggers the shared shake animation via `SlotInvalidDirective`.
 */
export class CalendarSlotComponent {
  @Input() slot!: SlotViewModel;
  @Input() location!: string;
  @Input() invalid = false;
  @Input() minutesInDay = 24 * 60;
  @Input() snapStep = 30;

  @Output() slotClick = new EventEmitter<SlotViewModel>();
  @Output() slotDragStart = new EventEmitter<SlotDragEvent>();
  @Output() slotDragMove = new EventEmitter<SlotDragEvent>();
  @Output() slotDragEnd = new EventEmitter<SlotDragEvent>();

  /**
   * Emit click so the parent can open details even while the drag directive
   * owns pointer events.
   */
  onPointerDown(): void {
    this.slotClick.emit(this.slot);
  }

  /** Propagate a plain click without starting a drag sequence. */
  onClick(event: MouseEvent): void {
    event.stopPropagation();
    this.slotClick.emit(this.slot);
  }

  /** Bubble drag lifecycle events from the directive to the parent calendar. */
  onDragStart(event: SlotDragEvent): void {
    this.slotClick.emit(this.slot);
    this.slotDragStart.emit(event);
  }

  onDragMove(event: SlotDragEvent): void {
    this.slotDragMove.emit(event);
  }

  onDragEnd(event: SlotDragEvent): void {
    this.slotDragEnd.emit(event);
  }
}
