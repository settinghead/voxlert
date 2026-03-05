/**
 * Registry of voice packs that can be downloaded from the GitHub repo.
 * Used by the setup wizard so users can choose which packs to install
 * without shipping them all in the npm package.
 *
 * baseUrl should point at raw GitHub content (branch or tag).
 */

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/settinghead/voiceforge/main/packs";

export const PACK_REGISTRY = [
  { id: "sc2-adjutant", name: "StarCraft 2 Adjutant" },
  { id: "sc1-adjutant", name: "StarCraft 1 Adjutant" },
  { id: "red-alert-eva", name: "Red Alert EVA" },
  { id: "sc1-kerrigan", name: "SC1 Kerrigan" },
  { id: "sc2-kerrigan", name: "SC2 Kerrigan" },
  { id: "sc1-protoss-advisor", name: "Protoss Advisor (SC1)" },
  { id: "sc2-protoss-advisor", name: "Protoss Advisor (SC2)" },
  { id: "ss1-shodan", name: "SHODAN" },
  { id: "hl-hev-suit", name: "HEV Suit" },
];

/** Default pack ids to pre-select in setup when offering download. */
export const DEFAULT_DOWNLOAD_PACK_IDS = ["sc2-adjutant", "sc1-adjutant", "red-alert-eva"];

export function getPackRegistryBaseUrl() {
  return process.env.VOICEFORGE_PACKS_BASE_URL || GITHUB_RAW_BASE;
}
