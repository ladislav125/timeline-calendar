import { Component } from '@angular/core';
import {
  CompactCalendarComponent,
} from './calendar/calendar.component';
import { bootstrapApplication } from '@angular/platform-browser';
import { CompactCalendarSlot, WorkingHoursMap } from './calendar/calendar.types';


@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CompactCalendarComponent],
  template: `
    <app-compact-calendar
      [data]="data"
      [workingHours]="workingHours"
      [dateLabel]="dateLabel"
      [timeLabel]="timeLabel"
      [showNowLine]="true"
      (slotChange)="onSlotChange($event)"
    ></app-compact-calendar>
  `,
})
export class App {
  dateLabel = '06/11/2025';
  timeLabel = '06:00 - 24:00';

  /** Example calendar data (you can replace this with your API data) */
  data: CompactCalendarSlot[] = [
    {
      id: 1,
      tn: 'C...',
      carrier: 'L...',
      location: 'CBR1-R2',
      dateTimeFrom: '2025-11-06T07:00:00',
      dateTimeTo: '2025-11-06T10:00:00',
    },
    {
      id: 2,
      tn: 'INBC234455',
      carrier: 'UPS',
      location: 'CBR1-R2',
      dateTimeFrom: '2025-11-06T11:00:00',
      dateTimeTo: '2025-11-06T15:30:00',
    },
    {
      id: 3,
      tn: 'CBS2345',
      carrier: 'Logistics Intl.',
      location: 'CBR2-R1',
      dateTimeFrom: '2025-11-06T09:00:00',
      dateTimeTo: '2025-11-06T17:00:00',
    },
    {
      id: 4,
      tn: 'NEW',
      carrier: '',
      location: 'CBR1-R2',
      dateTimeFrom: '2025-11-06T18:30:00',
      dateTimeTo: '2025-11-06T20:00:00',
    },
  ];

  /** Working hours shading configuration */
  workingHours: WorkingHoursMap = {
    'CBR1-R2': [{ start: '06:00', end: '24:00' }],
    'CBR2-R1': [{ start: '06:00', end: '24:00' }],
  };

  onSlotChange(slot: CompactCalendarSlot) {
    // here you could persist changes to API, etc.
    console.log('slot changed', slot);
  }
}

bootstrapApplication(App);
