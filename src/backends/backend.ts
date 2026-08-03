import type { Request, Response, StreamEvent } from "../types.js";

/**
 * Internal transport contract. Backends receive an already-validated config
 * and request; the client stamps provider/flavor onto the returned response.
 * The two paths are implemented independently — no forced shared path.
 */
export interface Backend {
  generate(request: Request, signal?: AbortSignal): Promise<Response>;
  generateStream(request: Request, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
