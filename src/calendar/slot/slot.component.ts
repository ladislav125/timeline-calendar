import {
  Component,
  EventEmitter,
  Input,
  Output,
  ViewEncapsulation,
} from '@angular/core';
import { DragType, SlotViewModel } from '../calendar.types';

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
  templateUrl: './slot.component.html',
  styleUrls: ['./slot.component.scss'],
})
export class CalendarSlotComponent {
  @Input() slot!: SlotViewModel;
  @Input() location!: string;
  @Input() invalid = false;

  @Output() slotClick = new EventEmitter<SlotViewModel>();
  @Output() slotPointerDown = new EventEmitter<SlotPointerDownPayload>();

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

  onClick(event: MouseEvent): void {
    event.stopPropagation();
    this.slotClick.emit(this.slot);
  }
}
