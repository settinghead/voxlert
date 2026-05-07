export const LOCAL_CHANNEL = "local";
export const BENCHDAY_PHONE_CHANNEL = "benchday_phone";

const CHANNEL_ALIASES = new Map([
  ["hub", BENCHDAY_PHONE_CHANNEL],
  ["benchday", BENCHDAY_PHONE_CHANNEL],
  ["phone", BENCHDAY_PHONE_CHANNEL],
  ["mobile", BENCHDAY_PHONE_CHANNEL],
  ["local_audio", LOCAL_CHANNEL],
]);

function normalizeChannelName(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!text) return "";
  return CHANNEL_ALIASES.get(text) || text;
}

export function normalizeOutputChannels(channels) {
  const raw = Array.isArray(channels)
    ? channels
    : typeof channels === "string"
      ? channels.split(",")
      : [];
  const normalized = raw.map(normalizeChannelName).filter(Boolean);
  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? unique : [LOCAL_CHANNEL];
}

export function channelPreset(channels) {
  const normalized = normalizeOutputChannels(channels);
  const hasLocal = normalized.includes(LOCAL_CHANNEL);
  const hasPhone = normalized.includes(BENCHDAY_PHONE_CHANNEL);
  if (hasLocal && hasPhone && normalized.length === 2) return "local_phone";
  if (hasPhone && normalized.length === 1) return "phone";
  if (hasLocal && normalized.length === 1) return "local";
  return "custom";
}

export function channelsForPreset(preset) {
  switch (preset) {
    case "local_phone":
      return [LOCAL_CHANNEL, BENCHDAY_PHONE_CHANNEL];
    case "phone":
      return [BENCHDAY_PHONE_CHANNEL];
    case "local":
    default:
      return [LOCAL_CHANNEL];
  }
}

export function formatChannels(channels) {
  return normalizeOutputChannels(channels).join(", ");
}

export function resolveBenchdayNode(config = {}, eventContext = {}, fallbackNode = "") {
  const configured =
    config.benchday_node ??
    config.benchday_daemon_id ??
    config.daemon_id ??
    "";
  const text = String(configured).trim();
  if (text) return text;
  return String(eventContext.node || fallbackNode || "").trim();
}
