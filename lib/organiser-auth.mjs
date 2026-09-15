/**
 * Who may press the organiser buttons.
 *
 * The auction API and the admin API share one rule, so an organiser using the
 * admin page and one using curl are held to the same boundary:
 *
 *   - in development everything is open, exactly as it was when the admin
 *     page and the auction API were dev-only conveniences;
 *   - in production the routes are closed unless ADMIN_API_KEY is set on the
 *     server and the request carries the same value in `x-admin-key`.
 *
 * The frontend never ships the key to the browser: its server actions attach
 * the header from their own (server-side) environment.
 */

export const ADMIN_KEY_HEADER = "x-admin-key";

export function createOrganiserGate({ dev }) {
  const adminKey = process.env.ADMIN_API_KEY?.trim() || null;

  /** True when this request is allowed to run organiser mutations. */
  function isOrganiser(req) {
    if (dev) return true;
    if (!adminKey) return false;
    return req.get(ADMIN_KEY_HEADER) === adminKey;
  }

  /** Express middleware form of `isOrganiser`. */
  function organiserOnly(req, res, nextFn) {
    if (isOrganiser(req)) return nextFn();
    res.status(403).json({
      status: "error",
      message: adminKey
        ? "Organiser controls require a valid admin key."
        : "Organiser controls require server-side admin authentication in production.",
    });
  }

  return { isOrganiser, organiserOnly, adminKeyConfigured: Boolean(adminKey) };
}
