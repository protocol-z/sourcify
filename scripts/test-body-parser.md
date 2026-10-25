# Body parser regression

Run from the repository root after `npm ci --ignore-scripts`:

```sh
node --test scripts/test-body-parser.cjs
```

The harness uses each service's resolved Express/body-parser with the JSON and
extended urlencoded middleware options used by `server.ts`, and the
`express.json()` entry point used by `FourByteServer.ts`. It starts only ephemeral
loopback HTTP servers, without database, chain, or other application services.
It does not exercise full application routing or prove deployment exposure.

Each child checks ordinary JSON/form bodies, gzip/deflate/Brotli bodies,
malformed compressed bodies (400), delayed trailing bytes (200 or 400), and a
subsequent health request. A raw socket delivers trailing bytes even if the
application responds before the request finishes. Valid decoded bodies must
retain their parsed contents.

The final probe injects a late error into the actual decompression stream after
successful parsing. This isolates the decoder-lifecycle edge described in
[GHSA-27r3-jxmh-p828](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828).
With 2.2.1 the stream remains undestroyed with no error listener and the child
terminates on an unhandled error. With 2.4.0 the decoder is destroyed and retains
an error listener; the process survives. This is an explicit fault-injection
probe, not a claim that the trailing-byte fixtures alone reproduce a crash on
every Node/zlib version. Child isolation keeps a baseline failure from crashing
the runner.

For a before/after isolation, `BODY_PARSER_TEST_MODULE` can name an absolute path
to an unpacked old body-parser module with its dependencies available. The child
substitutes that module for both the server's direct import and Express's import,
retaining the same runtime and other installed dependencies. On Node 24.22.1,
2.2.1 fails all three child tests at the late-error probe; the real malformed and
trailing fixtures alone do not crash that runtime. The fixed version passes all
three tests.

The server explicitly declares body-parser 2.4.0 because it already imports it
directly. The shared lock also resolves Express 5.2.1's compatible parser range to
2.4.0 for both services. The lock updates content-type, iconv-lite, type-is and qs
(and qs's required side-channel dependencies) to satisfy 2.4.0's declared minima.
Parsing limits, inflation policy, Express major, and runtime pins are unchanged.
