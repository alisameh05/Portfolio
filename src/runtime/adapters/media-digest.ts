import { createHash } from "node:crypto";
import type { MediaDigestPort } from "../../modules/media/application/processing.js";

export function createNodeMediaDigest(): MediaDigestPort {
  return { sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); } };
}
