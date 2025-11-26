import {
  Component,
  EventEmitter,
  Input,
  Output,
  ViewEncapsulation,
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

@Component({
  selector: 'app-compact-calendar-slot',
  standalone: true,
  encapsulation: ViewEncapsulation.Emulated,
  imports: [SlotInvalidDirective],
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

  @Output() slotClick = new EventEmitter<SlotViewModel>();
  @Output() slotPointerDown = new EventEmitter<SlotPointerDownPayload>();

  /**
   * Emit both click and pointer-down events to allow the parent to select the
   * slot while simultaneously initiating a drag or resize gesture.
   */
  onPointerDown(event: PointerEvent, type: DragType): void {
    event.stopPropagation();
    event.preventDefault();

    this.slotClick.emit(this.slot);
    this.slotPointerDown.emit({
      event,
      slot: this.slot,
      location: this.location,
      type,
    });
  }

  /** Propagate a plain click without starting a drag sequence. */
  onClick(event: MouseEvent): void {
    event.stopPropagation();
    this.slotClick.emit(this.slot);
  }
}
