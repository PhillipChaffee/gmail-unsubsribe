/** The signed-out screen (§3.1), with the reconnect explanation after an expired sign-in. */
export function SignIn({ expired }: { expired: boolean }) {
  return (
    <main className="screen">
      <h1>Gmail Bulk Unsubscribe</h1>
      {expired && (
        <p className="notice notice-warn" data-testid="expired-message">
          Your Google sign-in expired. Apps in Testing mode must reconnect every 7 days.
        </p>
      )}
      <p>Connect your Gmail account to see the mailing lists you receive and unsubscribe from many at once.</p>
      <a className="button button-primary" href="/api/auth/login" data-testid="connect-button">
        Connect Gmail
      </a>
    </main>
  );
}
