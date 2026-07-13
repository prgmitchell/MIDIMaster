import assert from "node:assert/strict";
import { getNavIndicatorMetrics } from "../src/app/connections_panel.js";

const sidebarRect = { left: 100, top: 150 };
const activeRect = { left: 112, top: 210, width: 180, height: 38 };

assert.deepEqual(getNavIndicatorMetrics(sidebarRect, activeRect), {
  width: 180,
  height: 38,
  x: 12,
  y: 60,
});

assert.deepEqual(getNavIndicatorMetrics(sidebarRect, activeRect, 0, 96), {
  width: 180,
  height: 38,
  x: 12,
  y: 156,
});

console.log("Connections panel tests passed");
