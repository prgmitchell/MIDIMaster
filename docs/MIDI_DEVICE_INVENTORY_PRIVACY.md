# MIDI Device Inventory Privacy Contract

MIDIMaster can optionally send a small MIDI device inventory to help improve controller-specific support. This collection is disabled by default and requires explicit consent in the app.

## Endpoint

The app posts to:

```text
https://telemetry.midimaster.app/v1/midi-device-inventory
```

The production Cloudflare Worker, D1 database, route bindings, and dashboards are operated privately. Secrets, database identifiers, tokens, and operational access details must not be committed to this repository.

## Payload

Schema version: `1`

```json
{
  "schemaVersion": 1,
  "noticeVersion": 1,
  "appVersion": "4.2.0",
  "inputDeviceCount": 1,
  "outputDeviceCount": 1,
  "selectedRouteCount": 1,
  "inputDevices": [
    { "id": "midi:0", "name": "Example Controller" }
  ],
  "outputDevices": [
    { "id": "midi:1", "name": "Example Controller" }
  ],
  "selectedRoutes": [
    {
      "inputDeviceId": "midi:0",
      "inputDeviceName": "Example Controller",
      "outputDeviceId": "midi:1",
      "outputDeviceName": "Example Controller",
      "enabled": true
    }
  ]
}
```

## Data Not Collected

The MIDI device inventory must not include:

- Personal information
- User, install, machine, or account identifiers
- Profiles, profile names, bindings, binding names, targets, or macros
- Audio sessions, process names, process paths, icons, or volume state
- Plugin settings, plugin credentials, or integration data
- MIDI messages, learned controls, controller values, or performance activity
- Request headers, cookies, IP addresses, user agents, or raw request bodies in durable storage

Local MIDI ids such as `midi:0` are included only to understand route setup. They are local, ephemeral port ids and are not stable device fingerprints.

## Receiver Requirements

The private receiver should:

- Accept only HTTPS POST requests for schema version `1`.
- Validate field names, string lengths, and maximum array sizes before storage.
- Store only the approved payload fields in normalized D1 tables.
- Avoid durable storage of IP addresses, user agents, headers, cookies, and raw JSON bodies.
- Apply Cloudflare rate limiting/WAF rules outside the app repository.
- Default to 180-day retention unless a shorter policy is chosen.
