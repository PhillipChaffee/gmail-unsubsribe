import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { csrfGuard, hostGuard, noFraming } from "../server/security";

const PORT = 3456;
const app = express();
app.use(hostGuard(PORT), csrfGuard(PORT));
app.get("/x", (_req, res) => void res.send("ok"));
app.post("/x", (_req, res) => void res.send("ok"));
const host = `127.0.0.1:${PORT}`;

describe("hostGuard", () => {
  it("Host evil.com → 403", async () => {
    const r = await request(app).get("/x").set("Host", "evil.com");
    expect(r.status).toBe(403);
    expect(r.text).toBe("Forbidden host");
  });
  it("Host with wrong port → 403", async () => {
    expect((await request(app).get("/x").set("Host", "127.0.0.1:1")).status).toBe(403);
  });
  it("Host localhost:<port> → allowed", async () => {
    expect((await request(app).get("/x").set("Host", `localhost:${PORT}`)).status).toBe(200);
  });
});

describe("csrfGuard", () => {
  it("POST with text/plain → 415", async () => {
    const r = await request(app).post("/x").set("Host", host).set("Content-Type", "text/plain").send("hi");
    expect(r.status).toBe(415);
  });
  it("POST with JSON and Origin http://evil.com → 403", async () => {
    const r = await request(app).post("/x").set("Host", host).set("Origin", "http://evil.com").send({});
    expect(r.status).toBe(403);
  });
  it("POST with JSON and no Origin → 200", async () => {
    expect((await request(app).post("/x").set("Host", host).send({})).status).toBe(200);
  });
  it("POST with JSON and Origin http://127.0.0.1:<port> → 200", async () => {
    const r = await request(app).post("/x").set("Host", host).set("Origin", `http://127.0.0.1:${PORT}`).send({});
    expect(r.status).toBe(200);
  });
  it("GET without content-type → 200", async () => {
    expect((await request(app).get("/x").set("Host", host)).status).toBe(200);
  });
});

describe("noFraming", () => {
  it("forbids framing with X-Frame-Options and CSP frame-ancestors", async () => {
    const framed = express();
    framed.use(noFraming);
    framed.get("/x", (_req, res) => void res.send("ok"));
    const r = await request(framed).get("/x");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  });
});
