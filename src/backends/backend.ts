import type { Request, Response } from "../types.js";

/**
 * Internal transport contract. Backends receive an already-validated config
 * and request; the client stamps provider/flavor onto the returned response.
 */
export interface Backend {
  generate(request: Request, signal?: AbortSignal): Promise<Response>;
}
