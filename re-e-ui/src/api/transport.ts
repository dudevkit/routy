/**
 * Transport selector: live fetch against re-e-core (default) or the mock
 * preview transport (VITE_API_MODE=mock, for standalone UI development).
 */
import { api as mock } from "./mock";
import { api as live } from "./client";

export const api = import.meta.env.VITE_API_MODE === "mock" ? mock : live;
