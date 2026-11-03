import type { RequestHandler } from "express";

const allowed = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];

/** Rejects requests whose Host header is not the loopback address (DNS-rebinding defence). */
export function hostGuard(port: number): RequestHandler {
  const hosts = allowed(port);
  return (req, res, next) => {
    const host = req.headers.host;
    if (host && hosts.includes(host)) return next();
    res.status(403).type("text/plain").send("Forbidden host");
  };
}

/** Mutating requests must be JSON and, if they carry an Origin, come from our own origin. */
export function csrfGuard(port: number): RequestHandler {
  const origins = allowed(port).map((h) => `http://${h}`);
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const type = req.headers["content-type"] ?? "";
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      res.status(415).type("text/plain").send("Content-Type must be application/json");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.includes(origin)) {
      res.status(403).type("text/plain").send("Forbidden origin");
      return;
    }
    next();
  };
}
