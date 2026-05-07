import test from "node:test";
import assert from "node:assert/strict";
import {
  channelPreset,
  channelsForPreset,
  normalizeOutputChannels,
  resolveBenchdayNode,
} from "../src/channels.js";

test("output channels default to local audio", () => {
  assert.deepEqual(normalizeOutputChannels(undefined), ["local"]);
  assert.deepEqual(normalizeOutputChannels([]), ["local"]);
});

test("output channels normalize legacy hub aliases to Benchday phone", () => {
  assert.deepEqual(
    normalizeOutputChannels(["local", "hub", "benchday-phone", "webhook", "hub"]),
    ["local", "benchday_phone", "webhook"],
  );
  assert.deepEqual(
    normalizeOutputChannels("phone, local_audio"),
    ["benchday_phone", "local"],
  );
});

test("channel presets round-trip common delivery destinations", () => {
  assert.equal(channelPreset(["local"]), "local");
  assert.equal(channelPreset(["benchday_phone"]), "phone");
  assert.equal(channelPreset(["local", "benchday_phone"]), "local_phone");
  assert.deepEqual(channelsForPreset("local_phone"), ["local", "benchday_phone"]);
});

test("Benchday node prefers configured enrolled daemon id", () => {
  assert.equal(
    resolveBenchdayNode(
      { benchday_node: "xc-mac-studio" },
      { node: "Xiyangs-Mac-Studio.local" },
      "fallback-host",
    ),
    "xc-mac-studio",
  );
  assert.equal(resolveBenchdayNode({}, { node: "hook-host" }, "fallback-host"), "hook-host");
});
