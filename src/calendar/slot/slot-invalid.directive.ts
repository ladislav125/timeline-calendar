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
/**
 * Directive that re-triggers the shake/outline animation whenever its
 * `invalid` input flips to true. It also removes the class after the configured
 * duration so subsequent flashes can restart the animation.
 */
export class SlotInvalidDirective implements OnChanges, OnDestroy {
  @Input('appSlotInvalid') invalid = false;
  @Input() invalidFlashDuration = 700;

  private clearTimer: any = null;
  private hasPendingRemoval = false;

  constructor(private renderer: Renderer2, host: ElementRef<HTMLElement>) {
    this.host = host.nativeElement;
  }

  private host: HTMLElement;

  /** Restart the animation whenever the invalid flag turns true. */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['invalid'] && this.invalid) {
      // Remove and re-add to restart the animation when re-triggered.
      this.renderer.removeClass(this.host, 'invalid');
      void (this.host as HTMLElement).offsetWidth;

      this.renderer.addClass(this.host, 'invalid');
      this.scheduleClear();
    }
  }

  /** Clean up pending timers when the directive is destroyed. */
  ngOnDestroy(): void {
    this.cancelClear();
  }

  /** Schedule automatic removal of the invalid class after the flash window. */
  private scheduleClear(): void {
    this.cancelClear();
    this.hasPendingRemoval = true;

    this.clearTimer = setTimeout(() => {
      this.renderer.removeClass(this.host, 'invalid');
      this.hasPendingRemoval = false;
      this.clearTimer = null;
    }, this.invalidFlashDuration);
  }

  /** Cancel any pending clear timer and immediately remove transient classes. */
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
