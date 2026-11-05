import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pinnedLookup, type WebhookTransport } from '@bax-print/events';

/** Spec 019c: the outbound webhook transport, connecting only to an address the SSRF guard vetted. */

export const WEBHOOK_SEND_TIMEOUT_MS = 10_000;

/**
 * POSTs one webhook request with `node:http`/`node:https`. The socket connects to
 * `target.address` through a pinned `lookup`, so no second DNS answer is used; the Host header
 * and the TLS server name stay the URL's host. Redirects are not followed; a 3xx is a failed attempt.
 */
export const nodeWebhookTransport: WebhookTransport = (request, target) =>
  new Promise((resolve, reject) => {
    const send = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(
      target.url,
      {
        method: 'POST',
        headers: { ...request.headers, 'content-length': String(Buffer.byteLength(request.body)) },
        lookup: pinnedLookup(target.address, target.family),
        signal: AbortSignal.timeout(WEBHOOK_SEND_TIMEOUT_MS),
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(request.body);
  });
