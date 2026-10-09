import { createHmac } from 'node:crypto';

/** Verify the Shift4 notification signature before trusting the payload. */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return expected === signature;
}

export class WebhookDispatcher {
  private handlers = new Map<string, (payload: unknown) => void>();

  register(event: string, handler: (payload: unknown) => void): void {
    this.handlers.set(event, handler);
  }

  dispatch(event: string, payload: unknown): boolean {
    const handler = this.handlers.get(event);
    if (!handler) return false;
    handler(payload);
    return true;
  }
}

export const DEFAULT_RETRIES = 3;
