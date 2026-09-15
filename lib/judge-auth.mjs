/**
 * Who is calling the judge routes.
 *
 * A judge signs in with Google through Firebase in the browser. The frontend
 * forwards the resulting ID token to this server, which verifies its
 * signature, audience and expiry against Google's public keys and takes the
 * uid, name and email from the verified claims. Nothing identity-related is
 * ever read from a request body — a client cannot claim to be a judge, it can
 * only prove it.
 *
 * Verification needs only the Firebase project id (FIREBASE_PROJECT_ID; the
 * public keys are fetched without credentials). A service account is not
 * required and none of the privileged Admin APIs are used.
 *
 * This is the one place in the backend that verifies identity; the rest of
 * the app still trusts the email the frontend sends for team participants.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export const JUDGE_TOKEN_HEADER = "authorization";
/** The invitation code, re-entered to unlock the results page. */
export const JUDGE_RESULTS_KEY_HEADER = "x-judge-results-key";

function projectId() {
  return process.env.FIREBASE_PROJECT_ID?.trim() || null;
}

/** Optional. Only present if an operator chose to configure one. */
function serviceAccount() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (json) {
    try {
      return cert(JSON.parse(json));
    } catch {
      console.error("[judge-auth] FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON; ignoring.");
    }
  }
  return null;
}

let app = null;

function adminApp() {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) return (app = existing);

  const id = projectId();
  if (!id) return null;

  const credential = serviceAccount();
  app = initializeApp(credential ? { credential, projectId: id } : { projectId: id });
  return app;
}

export const judgeAuthConfigured = Boolean(projectId());

/**
 * Verify a Firebase ID token. Returns `{ uid, email, emailVerified, name }`
 * or null when the token is missing, malformed, expired, or for another
 * project.
 */
export async function verifyIdToken(idToken) {
  const token = typeof idToken === "string" ? idToken.trim() : "";
  if (!token) return null;

  const firebase = adminApp();
  if (!firebase) return null;

  try {
    const decoded = await getAuth(firebase).verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified ?? false,
      name: typeof decoded.name === "string" ? decoded.name : null,
    };
  } catch {
    return null;
  }
}

/** The bearer token from the Authorization header, or null. */
export function bearerToken(req) {
  const header = req.get(JUDGE_TOKEN_HEADER) ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Express middleware: the request must carry a valid Firebase ID token. The
 * verified claims land on `req.judgeIdentity`; the judging engine then maps
 * the uid to a judge profile and assignment. Anything else is a 401.
 */
export async function requireJudgeIdentity(req, res, nextFn) {
  if (!judgeAuthConfigured) {
    return res.status(503).json({
      status: "error",
      message: "Judge sign-in is not configured on the server (FIREBASE_PROJECT_ID).",
    });
  }

  const identity = await verifyIdToken(bearerToken(req));
  if (!identity) {
    return res.status(401).json({
      status: "error",
      message: "Sign in with Google first.",
      code: "SIGNED_OUT",
    });
  }

  req.judgeIdentity = identity;
  nextFn();
}
