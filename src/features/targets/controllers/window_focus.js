// Ask the same native window lookup used by the action, rather than inferring
// focus availability from an audio session or a running process.
export async function focusableApplicationNames(callInvoke, applicationNames) {
  const candidates = [...new Set(applicationNames.filter((name) => typeof name === "string" && name.trim()))];
  if (!callInvoke || candidates.length === 0) return new Set();
  try {
    const available = await callInvoke("filter_focusable_applications", { applicationNames: candidates });
    return new Set(Array.isArray(available) ? available : []);
  } catch {
    return new Set();
  }
}
