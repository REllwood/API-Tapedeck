<div align="center">

# API Tapedeck

**Record a real API conversation, clean it up and replay it as a dependable development scenario.**

[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4e?style=flat-square)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-43853d?style=flat-square&logo=node.js&logoColor=white)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-555?style=flat-square)

</div>

Mocks usually start as one happy-path JSON file and drift away from the real API. API Tapedeck turns a recorded API conversation into a cassette you can review, with secrets stripped, unstable values pinned and delays kept. It replays the journey from a local server, and when your app asks for something different it tells you exactly which field didn't match.

## What it does

- Validates recorded requests and responses, within size limits
- Removes secret headers and body fields when a recording comes in, along with credentials embedded in values: secret URL parameters, bearer tokens, JSON Web Tokens, private keys and well-known API key formats
- Refuses any cassette that still carries a literal credential. A deliberate test credential has to go in as a declared variable
- Marks a recording as reviewed only if it's exactly what this server sanitised
- Swaps unstable values you declare, like timestamps and IDs, for fixed replay variables
- Matches requests exactly or by subset
- Replays fixed or recorded delays
- Explains mismatches and out-of-order requests field by field, and never contacts the real API
- Answers only requests addressed to 127.0.0.1, localhost or [::1], and refuses cross-site calls from other web pages

## Quick start

Requires Node.js 22 or newer. No `npm install` needed.

```sh
git clone https://github.com/REllwood/API-Tapedeck.git
cd API-Tapedeck
npm start
```

Open http://127.0.0.1:4193 and press **Load safe recording**, **Sanitise and validate**, then **Confirm review and load replay**. With the replay loaded, point any client at it:

```sh
curl -X POST http://127.0.0.1:4193/api/replay/reset
curl -H 'content-type: application/json' \
  -d '{"origin":"MEL","destination":"HBA","token":"synthetic-client-value"}' \
  http://127.0.0.1:4193/replay/sessions
```

## Status

v0.1 replays reviewed JSON cassettes. It doesn't record live traffic, proxy requests or intercept TLS yet. Next up are WebSocket scenarios, adapters for test libraries and comparing cassettes across API versions.

## Development

```sh
npm test        # cassette, ingest and replay tests
npm run check   # tests plus syntax checks
```

## License

[MIT](LICENSE)
