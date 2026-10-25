// Run with: node --test scripts/test-body-parser.cjs
// Keep decoder failures in a child process: an uncaught error must fail the test,
// rather than terminate the test runner. No database or application services run.
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

if (!process.env.BODY_PARSER_TEST_CHILD) {
  for (const mode of ["server-json", "server-urlencoded", "4byte-json"]) {
    test(`${mode}: compressed requests cannot terminate the process`, async () => {
      const child = fork(__filename, [mode], {
        env: { ...process.env, BODY_PARSER_TEST_CHILD: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const timer = setTimeout(() => child.kill(), 15000);
      const [code, signal] = await new Promise((resolve) =>
        child.once("exit", (...args) => resolve(args)),
      );
      clearTimeout(timer);
      assert.equal(signal, null, output);
      assert.equal(code, 0, output);
      assert.match(output, /all cases passed/);
      process.stdout.write(output);
    });
  }
} else {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function run() {
  const http = require("node:http");
  const zlib = require("node:zlib");
  const mode = process.argv[2];
  let lastDecoder;
  // Probe the advisory's late-error edge explicitly. Real trailing bytes are
  // exercised below too, but their decoder behavior depends on Node/zlib.
  for (const name of [
    "createGunzip",
    "createInflate",
    "createBrotliDecompress",
  ]) {
    const original = zlib[name];
    Object.defineProperty(zlib, name, {
      configurable: true,
      value: (...args) => {
        lastDecoder = original(...args);
        return lastDecoder;
      },
    });
  }
  const serviceRequire = createRequire(
    path.resolve(
      "services",
      mode.startsWith("4byte") ? "4byte" : "server",
      "package.json",
    ),
  );
  // Optional baseline isolation: substitute only the old parser, retaining the
  // same Express, Node and supporting dependencies as the candidate.
  const parserPath = serviceRequire.resolve("body-parser");
  const parser = require(process.env.BODY_PARSER_TEST_MODULE || parserPath);
  if (process.env.BODY_PARSER_TEST_MODULE) {
    require.cache[parserPath] = {
      id: parserPath,
      filename: parserPath,
      loaded: true,
      exports: parser,
    };
  }
  const express = serviceRequire("express");
  const app = express();
  const form = mode === "server-urlencoded";
  // These are the parsing entry points/options used by server.ts and
  // FourByteServer.ts; the API server supplies its configured maxFileSize.
  if (mode === "4byte-json") app.use(express.json());
  else {
    app.use(parser.urlencoded({ limit: "1mb", extended: true }));
    app.use(parser.json({ limit: "1mb" }));
  }
  app.post("/", (req, res) => {
    res.json(req.body);
    if (req.headers["x-decoder-probe"]) {
      const decoder = lastDecoder;
      console.log(
        `${mode} late-error probe: destroyed=${decoder.destroyed} errorListeners=${decoder.listenerCount("error")}`,
      );
      setImmediate(() =>
        decoder.emit("error", new Error("isolated late decoder error probe")),
      );
    }
  });
  app.get("/health", (_req, res) => res.send("alive"));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.type || "decode" }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const body = Buffer.from(
    form ? "contract[name]=Example" : '{"contract":{"name":"Example"}}',
  );
  const expected = { contract: { name: "Example" } };

  function request(payload, encoding, trailing, probe = false) {
    if (trailing) {
      return new Promise((resolve, reject) => {
        const socket = require("node:net").connect(port, "127.0.0.1");
        let response = "";
        socket.on("error", reject);
        socket.setTimeout(3000, () =>
          socket.destroy(new Error("socket timed out")),
        );
        socket.on("data", (chunk) => {
          response += chunk.toString();
        });
        socket.on("close", () => {
          try {
            const [headers, text] = response.split("\r\n\r\n");
            resolve({
              status: Number(headers.split(" ")[1]),
              body: JSON.parse(text),
            });
          } catch (error) {
            reject(error);
          }
        });
        socket.on("connect", () => {
          socket.write(
            `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: ${form ? "application/x-www-form-urlencoded" : "application/json"}\r\nContent-Encoding: ${encoding}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n`,
          );
          socket.write(`${payload.length.toString(16)}\r\n`);
          socket.write(payload);
          socket.write("\r\n");
          setTimeout(() => {
            const tail = Buffer.from("invalid trailing bytes");
            socket.write(`${tail.length.toString(16)}\r\n${tail}\r\n0\r\n\r\n`);
            setTimeout(() => socket.end(), 100);
          }, 50);
        });
      });
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method: "POST",
          path: "/",
          headers: {
            "content-type": form
              ? "application/x-www-form-urlencoded"
              : "application/json",
            ...(encoding ? { "content-encoding": encoding } : {}),
            "transfer-encoding": "chunked",
            ...(probe ? { "x-decoder-probe": "1" } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode, body: JSON.parse(text) }),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("request timed out")));
      req.end(payload);
    });
  }

  try {
    assert.deepEqual(await request(body), { status: 200, body: expected });
    for (const [encoding, compress] of [
      ["gzip", zlib.gzipSync],
      ["deflate", zlib.deflateSync],
      ["br", zlib.brotliCompressSync],
    ]) {
      const payload = compress(body);
      assert.deepEqual(await request(payload, encoding), {
        status: 200,
        body: expected,
      });
      assert.equal(
        (await request(Buffer.from("malformed compressed body"), encoding))
          .status,
        400,
      );
      const trailing = await request(payload, encoding, true);
      assert.ok(
        [200, 400].includes(trailing.status),
        `${encoding}: ${trailing.status}`,
      );
      if (trailing.status === 200) assert.deepEqual(trailing.body, expected);
      // Allow a late decoder error to reach the event loop before probing health.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(await health.text(), "alive");
      console.log(
        `${mode} ${encoding}: normal=200 malformed=400 trailing=${trailing.status} health=200`,
      );
    }
    await request(zlib.deflateSync(body), "deflate", false, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(await health.text(), "alive");
    console.log(`${mode}: all cases passed`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
