import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  OnDestroy,
} from '@angular/core';
import { CompactCalendarSlot, SlotViewModel } from '../calendar.types';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-slot-detail',
  templateUrl: './slot-detail.component.html',
  styleUrls: ['./slot-detail.component.scss'],
  standalone: true,
  imports: [CommonModule],
})
export class SlotDetailComponent implements OnChanges, OnDestroy {
  @Input() slot: SlotViewModel | null = null;
  /** fallback farba ak nepríde z dát */
  @Input() defaultColor = '#3ab7b0';
  /** v ms – auto hide ak používateľ na badge nesiahne */
  @Input() autoHideMs = 10000;
  /** čas "fake loadingu" – kvôli animácii */
  @Input() loadingMs = 1500;

  loading = false;
  visible = false;
  unnoticed = true;

  private hideTimeoutId: any;
  private loadingTimeoutId: any;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['slot'] && this.slot) {
      this.startShowCycle();
    }
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  private startShowCycle(): void {
    this.clearTimers();

    this.visible = true;
    this.loading = true;
    this.unnoticed = true;

    // simulácia loadera (rovnako ako v pôvodnom JS)
    this.loadingTimeoutId = setTimeout(() => {
      this.loading = false;
    }, this.loadingMs);

    // auto-hide ak používateľ nič nespraví
    this.hideTimeoutId = setTimeout(() => {
      if (this.unnoticed) {
        this.close();
      }
    }, this.autoHideMs);
  }

  onMouseEnter(): void {
    // po prvom hoveri sa správa ako "všimnutý" – zobraz detaily
    this.unnoticed = false;
  }

  close(): void {
    this.visible = false;
    this.slot = null;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.hideTimeoutId) {
      clearTimeout(this.hideTimeoutId);
      this.hideTimeoutId = null;
    }
    if (this.loadingTimeoutId) {
      clearTimeout(this.loadingTimeoutId);
      this.loadingTimeoutId = null;
    }
  }

  get backgroundColor(): string {
    return this.slot?.color || this.defaultColor;
  }
}
