import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/midi_device_inventory.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const inventory = await import(moduleUrl);

function testUnknownConsentPrompts() {
  assert.equal(inventory.shouldPromptMidiDeviceInventoryConsent({}), true);
  assert.equal(inventory.canSubmitMidiDeviceInventory({}), false);
}

function testDisabledCurrentNoticeDoesNotPromptOrSubmit() {
  const settings = {
    midiDeviceInventoryConsent: "disabled",
    midiDeviceInventoryNoticeVersion: inventory.MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
  };

  assert.equal(inventory.shouldPromptMidiDeviceInventoryConsent(settings), false);
  assert.equal(inventory.canSubmitMidiDeviceInventory(settings), false);
}

function testEnabledCurrentNoticeDoesNotPromptAndCanSubmit() {
  const settings = {
    midi_device_inventory_consent: "enabled",
    midi_device_inventory_notice_version: inventory.MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
  };

  assert.equal(inventory.shouldPromptMidiDeviceInventoryConsent(settings), false);
  assert.equal(inventory.canSubmitMidiDeviceInventory(settings), true);
}

function testNoticeBumpPromptsEvenWhenPreviouslyAnswered() {
  const settings = {
    midiDeviceInventoryConsent: "enabled",
    midiDeviceInventoryNoticeVersion: inventory.MIDI_DEVICE_INVENTORY_NOTICE_VERSION - 1,
  };

  assert.equal(inventory.shouldPromptMidiDeviceInventoryConsent(settings), true);
  assert.equal(inventory.canSubmitMidiDeviceInventory(settings), false);
}

testUnknownConsentPrompts();
testDisabledCurrentNoticeDoesNotPromptOrSubmit();
testEnabledCurrentNoticeDoesNotPromptAndCanSubmit();
testNoticeBumpPromptsEvenWhenPreviouslyAnswered();

console.log("MIDI device inventory consent tests passed");
