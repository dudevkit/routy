// Is this node keyless? The one place every caller asks — the connection picker
// (pickConnections) and the three probe guards must agree, because disagreement is how a
// provider that needs no key ends up 503-ing at the door or demanding one in a tooltip.
//
// Deliberately NOT in core/providerCatalog.mjs: that file is GENERATED (rigs/
// gen-provider-catalog.mjs writes it wholesale), and a hand-edit there disappears on the next
// regeneration — which is exactly how the media providers that need no key would go back to
// being unusable. The generator owns data; this file owns the question.
//
// Three sources, all facts about the node or the shipped catalogue:
//   · `data.noAuth` — a free-category preset's Add-time declaration;
//   · the CATALOGUE entry for `data.preset` — so a node saved BEFORE the flag existed still
//     counts (the stale-node case that once kept opencode dead at 503);
//   · the media config — a provider declaring the `none` credential style (SearXNG, a local
//     ComfyUI or Kokoro, OpenCode Zen's free half), same fact `authStyleFor` already answers
//     per kind.
import { PROVIDERS } from "./providerCatalog.mjs";
import { mediaIsKeyless } from "./media.mjs";

export function isKeyless(node) {
  if (node?.data?.noAuth) return true;
  if (mediaIsKeyless(node)) return true;
  const presetId = node?.data?.preset;
  if (!presetId) return false;
  const entry = PROVIDERS.find((e) => e.id === presetId);
  return Boolean(entry?.data?.noAuth);
}
