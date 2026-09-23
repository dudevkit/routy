// deps shim — replaces the uuid package (builtin crypto)
import crypto from "node:crypto";
export const v4 = () => crypto.randomUUID();
