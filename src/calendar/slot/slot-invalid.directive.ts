import {
  Directive,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  Renderer2,
  SimpleChanges,
} from '@angular/core';

@Directive({
  selector: '[appSlotInvalid]',
  standalone: true,
})
export class SlotInvalidDirective implements OnChanges, OnDestroy {
  @Input('appSlotInvalid') invalid = false;
  @Input() invalidFlashDuration = 700;

  private clearTimer: any = null;
  private hasPendingRemoval = false;

  constructor(private renderer: Renderer2, host: ElementRef<HTMLElement>) {
    this.host = host.nativeElement;
  }

  private host: HTMLElement;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['invalid'] && this.invalid) {
      // Remove and re-add to restart the animation when re-triggered.
      this.renderer.removeClass(this.host, 'invalid');
      void (this.host as HTMLElement).offsetWidth;

      this.renderer.addClass(this.host, 'invalid');
      this.scheduleClear();
    }
  }

  ngOnDestroy(): void {
    this.cancelClear();
  }

  private scheduleClear(): void {
    this.cancelClear();
    this.hasPendingRemoval = true;

    this.clearTimer = setTimeout(() => {
      this.renderer.removeClass(this.host, 'invalid');
      this.hasPendingRemoval = false;
      this.clearTimer = null;
    }, this.invalidFlashDuration);
  }

  private cancelClear(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }

    if (this.hasPendingRemoval) {
      this.renderer.removeClass(this.host, 'invalid');
      this.hasPendingRemoval = false;
    }
  }
}
