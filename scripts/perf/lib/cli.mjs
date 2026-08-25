import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs a CLI entry point only when its module was invoked directly.
 * Imported entry points remain inert and can be exercised by tests.
 *
 * @param {string} moduleUrl
 * @param {() => void | Promise<void>} main
 */
export function runMain(moduleUrl, main) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return;

  Promise.resolve()
    .then(main)
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}

export function parseArgs(argv, options = {}) {
  const aliases = options.aliases ?? {};
  const booleans = new Set(options.booleans ?? []);
  const repeated = new Set(options.repeated ?? []);
  const result = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    const key = aliases[rawKey] ?? rawKey;
    let value = inlineValue;
    if (booleans.has(key)) {
      value = value === undefined ? true : value !== "false";
    } else if (value === undefined) {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new Error(`Missing value for --${rawKey}`);
      }
      value = argv[index];
    }

    if (repeated.has(key)) {
      result[key] = [...(result[key] ?? []), value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function splitCsv(value, fallback = []) {
  if (value === undefined) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parsePositiveIntegers(value, fallback) {
  return splitCsv(value, fallback.map(String)).map((item) => {
    const parsed = Number.parseInt(item, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`Expected a non-negative integer, got '${item}'`);
    }
    return parsed;
  });
}

export function resolveFromCwd(path) {
  return resolve(process.cwd(), path);
}

export function requireArg(args, name) {
  if (args[name] === undefined || args[name] === "") {
    throw new Error(`Missing required --${name}`);
  }
  return args[name];
}
