import { ONE_CLICK_TIMEOUT_MS, USER_AGENT } from "../constants";
import { AuthExpiredError, type GmailClient } from "../gmail/types";
import { parseMailto } from "../scan/headers";

export interface MethodOutcome {
  ok: boolean;
  detail: string;
}

export async function postOneClick(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<MethodOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = new FormData();
  body.append("List-Unsubscribe", "One-Click");
  try {
    const res = await doFetch(url, {
      method: "POST",
      body,
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(opts.timeoutMs ?? ONE_CLICK_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => {});
    const ok = res.status >= 200 && res.status < 400;
    return { ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { ok: false, detail: "timed out" };
    }
    return { ok: false, detail: failureDetail(err) };
  }
}

/** fetch rejects every network failure as "fetch failed"; the cause says which (ENOTFOUND, a TLS error...). */
function failureDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: unknown; message?: unknown } | null | undefined;
  const why = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : "";
  return why ? `${err.message} (${why})` : err.message;
}

export { parseMailto } from "../scan/headers";

export function buildRfc822(msg: { to: string; subject: string; body: string }): string {
  const ascii = /^[\x00-\x7f]*$/.test(msg.subject);
  const subject = ascii ? msg.subject : `=?UTF-8?B?${Buffer.from(msg.subject, "utf8").toString("base64")}?=`;
  const headers = [
    `To: ${msg.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${Buffer.from(msg.body, "utf8").toString("base64")}`;
}

export async function sendMailto(gmail: GmailClient, mailto: string): Promise<MethodOutcome> {
  const parsed = parseMailto(mailto);
  if (!parsed) return { ok: false, detail: "invalid mailto" };
  try {
    await gmail.sendRaw(buildRfc822(parsed));
    return { ok: true, detail: `sent email to ${parsed.to}` };
  } catch (err) {
    if (err instanceof AuthExpiredError) throw err;
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
