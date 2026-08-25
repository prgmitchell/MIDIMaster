import {
  normalizeMidiPreference,
  normalizeMidiRoutes,
  resolvePreferredMidiDeviceRoutes,
  stripUnavailableSuffix,
} from "./device_preferences.js";

export function routeMatchesIdentity(route, candidate) {
  if (!route || !candidate) return false;
  const inputId = String(route.inputDeviceId || "").trim();
  const inputName = stripUnavailableSuffix(route.inputDeviceName || "");
  const candidateId = String(candidate.inputDeviceId || "").trim();
  const candidateName = stripUnavailableSuffix(candidate.inputDeviceName || "");
  if (inputId && candidateId && inputId === candidateId) {
    return !(inputName && candidateName && inputName !== candidateName);
  }
  return Boolean(inputName && candidateName && inputName === candidateName);
}

export function preserveUnavailableRouteDrafts(aliveRoutes, missingRoutes, preference, connectedRoutes) {
  const profileRoutes = normalizeMidiPreference(preference).routes;
  const baseRoutes = profileRoutes.length ? profileRoutes : connectedRoutes;
  const replacements = [...aliveRoutes, ...missingRoutes];
  const merged = normalizeMidiRoutes({ routes: baseRoutes }).map((route) => (
    replacements.find((candidate) => routeMatchesIdentity(route, candidate)) || route
  ));
  replacements.forEach((route) => {
    if (!merged.some((candidate) => routeMatchesIdentity(candidate, route))) merged.push(route);
  });
  return normalizeMidiRoutes({ routes: merged });
}

export function routesFromResolvedPreferences(resolvedRoutes) {
  const resolved = Array.isArray(resolvedRoutes?.routes) ? resolvedRoutes.routes : [];
  return normalizeMidiRoutes({
    routes: resolved.map((route) => {
      if (route.preference?.enabled === false || !route.inputMatch || !route.outputMatch) {
        return route.preference;
      }
      return {
        inputDeviceId: route.inputMatch.id,
        outputDeviceId: route.outputMatch.id,
        inputDeviceName: route.inputMatch.name || route.preference?.inputDeviceName,
        outputDeviceName: route.outputMatch.name || route.preference?.outputDeviceName,
        enabled: true,
      };
    }),
  });
}

export function routeResolutionIssues(resolved) {
  return (Array.isArray(resolved?.routes) ? resolved.routes : [])
    .filter((route) => route.preference?.enabled !== false && !route.available)
    .map((route) => ({
      inputDeviceName: route.preference?.inputDeviceName || route.preference?.inputDeviceId || "",
      outputDeviceName: route.preference?.outputDeviceName || route.preference?.outputDeviceId || "",
      inputStatus: route.inputStatus,
      outputStatus: route.outputStatus,
    }));
}

export function createMidiRoutePolicy({ warn = console.warn } = {}) {
  let lastIssueSignature = "";

  function resolveDesiredRouteSet(snapshot, preference, context = "unknown") {
    const resolved = resolvePreferredMidiDeviceRoutes(snapshot, preference);
    const issues = routeResolutionIssues(resolved);
    const signature = JSON.stringify(issues);
    if (signature !== lastIssueSignature) {
      lastIssueSignature = signature;
      if (issues.length > 0) {
        const kind = issues.some((issue) => issue.inputStatus === "ambiguous" || issue.outputStatus === "ambiguous")
          ? "ambiguous"
          : "unavailable";
        warn(`MIDI route resolution ${kind} (${context})`, issues);
      }
    }
    return resolved;
  }

  function unresolvedRouteStatus(resolved, translate, fallbackKey = "midi.partialRetrying") {
    return resolved?.routes?.some((route) => route.ambiguous)
      ? translate("midi.ambiguousRoute")
      : translate(fallbackKey);
  }

  return { resolveDesiredRouteSet, unresolvedRouteStatus };
}
