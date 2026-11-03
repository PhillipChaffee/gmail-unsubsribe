/** Shown when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing (§3.1): the README setup steps in short. */
export function SetupNotice() {
  const { port } = window.location;
  const redirectUri = `http://127.0.0.1${port ? `:${port}` : ""}/api/auth/callback`;
  return (
    <main className="screen" data-testid="setup-notice">
      <h1>Set up Gmail Bulk Unsubscribe</h1>
      <p>Google sign-in isn't configured yet. To connect your Gmail account:</p>
      <ol>
        <li>
          In Google Cloud, create a project and enable the <strong>Gmail API</strong>.
        </li>
        <li>
          Set up the OAuth consent screen as <em>External</em> with status <em>Testing</em>, and add yourself as a{" "}
          <strong>test user</strong>.
        </li>
        <li>
          Create an OAuth client of type <strong>Web application</strong> with the authorized redirect URI{" "}
          <code>{redirectUri}</code>.
        </li>
        <li>
          Run <code>cp .env.example .env</code> and fill in <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.
        </li>
        <li>
          Restart the server (<code>npm run dev</code>) and reload this page. Expect a "Google hasn't verified this app" warning
          (Advanced → Continue).
        </li>
      </ol>
      <p>
        To try the app without Google, run <code>FAKE_GMAIL=1 npm run dev</code>. See the README for details.
      </p>
    </main>
  );
}
