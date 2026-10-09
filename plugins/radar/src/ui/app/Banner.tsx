/**
 * The offline banner: a daisyUI alert that sits above the page while the stream is down, says what
 * happened and what to do about it.
 */

import { Icon } from "./Icon.tsx";

/** The reconnection notice shown while the live stream is down; `message` is the transport's own words. */
export function Banner({ message }: { message: string }) {
  return (
    <div role="alert" class="alert alert-error mb-5" data-banner="">
      <Icon name="alert" class="size-5 shrink-0" />
      <div class="min-w-0">
        <p class="font-medium">Lost contact with the radar server</p>
        <p class="text-sm">{`${message}. It reconnects on its own; press R to retry now.`}</p>
      </div>
    </div>
  );
}
