// Credential masking for logs and UI: enough to tell two keys apart, never enough to
// leak one. Shared because three call sites had grown three slightly different copies.
export const maskKey = (k) => (typeof k === "string" && k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? "•••" : "—");
