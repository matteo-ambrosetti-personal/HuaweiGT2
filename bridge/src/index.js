// GT2 Bridge: a personal, read-only MCP connector for intervals.icu.
//
// claude.ai connects to /mcp. Access is OAuth 2.1 (Cloudflare's
// workers-oauth-provider handles discovery, client registration and tokens);
// the authorize page asks for BRIDGE_PASSPHRASE, so only the owner can connect.
// Secrets: INTERVALS_API_KEY, BRIDGE_PASSPHRASE. KV binding: OAUTH_KV.

import { OAuthProvider, AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { handleMcpRequest, SERVER_INFO } from './mcp.js';

const SCOPES = ['mcp:read', 'offline_access'];
const escape = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, body, headers = new Headers()) {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6f7;--fg:#111c24;--muted:#4a5964;--line:#cbd3d8;--accent:#b4235a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1417;--fg:#e9eef1;--muted:#b3c0c8;--line:#34414a;--accent:#f0679a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:460px;margin:8vh auto;padding:0 20px}
h1{font-size:20px;margin:0 0 12px}p{color:var(--muted)}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.row{display:flex;gap:8px;margin-top:14px}.err{color:#d03b3b}
</style></head><body><main>${body}</main></body></html>`, { headers });
}

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function consentPage(client, authReq, handle, error) {
  const name = escape(client?.clientName || client?.clientId || 'An app');
  const host = escape(new URL(authReq.redirectUri).hostname);
  return `<h1>Connect ${name} to your GT2 Bridge?</h1>
<p>It will get read-only access to your intervals.icu activities and wellness data. Access is sent to <strong>${host}</strong>.</p>
${error ? `<p class="err">${escape(error)}</p>` : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="pp">Bridge passphrase</label>
  <input id="pp" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <div class="row"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></div>
</form>`;
}

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    if (url.pathname === '/') {
      return page('GT2 Bridge', `<h1>GT2 Bridge</h1><p>A private, read-only connector between intervals.icu and the GT 2 Logbook. Add <code>${escape(url.origin)}/mcp</code> as a custom connector in claude.ai.</p>`);
    }
    if (url.pathname !== '/authorize') return new Response('Not found', { status: 404 });
    try {
      if (request.method === 'GET') {
        const authReq = await oauth.parseAuthRequest(request);
        const client = await oauth.lookupClient(authReq.clientId);
        const consent = await oauth.beginConsent(authReq);
        return page('Connect GT2 Bridge', consentPage(client, authReq, consent.handle), consent.headers);
      }
      if (request.method === 'POST') {
        const form = await request.formData();
        const handle = String(form.get('handle') || '');
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        if (!env.BRIDGE_PASSPHRASE || !(await sameSecret(String(form.get('passphrase') || ''), env.BRIDGE_PASSPHRASE))) {
          return page('Wrong passphrase', '<h1>Wrong passphrase</h1><p>Go back to Claude and start connecting again.</p>', new Headers());
        }
        const approved = await oauth.approveConsent(request, handle, { scope: SCOPES });
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: 'owner',
          metadata: { label: 'GT2 Bridge owner' },
          scope: approved.request.scope,
          props: { user: 'owner' },
        });
        approved.headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }
      return new Response('Method not allowed', { status: 405 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectUri) {
        const redirect = new URL(error.redirectUri);
        redirect.searchParams.set('error', error.code);
        redirect.searchParams.set('error_description', error.description);
        if (error.state) redirect.searchParams.set('state', error.state);
        if (error.issuer) redirect.searchParams.set('iss', error.issuer);
        return Response.redirect(redirect.href, 302);
      }
      if (error instanceof AuthorizationError) {
        return page('Cannot connect', `<h1>Cannot connect</h1><p>${escape(error.description)}</p>`);
      }
      throw error;
    }
  },
};

const apiHandler = {
  fetch(request, env) {
    return handleMcpRequest(request, env, fetch);
  },
};

let provider = null;

export default {
  fetch(request, env, ctx) {
    if (!provider) {
      const origin = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, '');
      provider = new OAuthProvider({
        apiRoute: '/mcp',
        apiHandler,
        defaultHandler,
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/token',
        clientRegistrationEndpoint: '/register',
        scopesSupported: SCOPES,
        requiredScopes: ['mcp:read'],
        resourceMetadata: {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          resource_name: SERVER_INFO.title,
        },
        accessTokenTTL: 3600,
        refreshTokenTTL: 180 * 24 * 3600,
        clientIdMetadataDocumentEnabled: true,
      });
    }
    return provider.fetch(request, env, ctx);
  },
};
