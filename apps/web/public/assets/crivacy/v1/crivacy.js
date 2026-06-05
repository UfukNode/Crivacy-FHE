/*!
 * Crivacy OAuth embed bootstrap v1
 *
 * Drop-in <script> helper for firms that want "one snippet and done"
 * integration. Wires any element carrying `data-crivacy-verify` to
 * redirect the current tab to /api/v1/oauth/authorize with PKCE.
 *
 * Usage:
 *   <link rel="stylesheet" href="https://app.crivacy.io/assets/crivacy/v1/button.css">
 *   <script src="https://app.crivacy.io/assets/crivacy/v1/crivacy.js" defer></script>
 *   <button
 *     class="crivacy-button"
 *     data-crivacy-verify
 *     data-client-id="crv_oauth_live_xxxxxxxxxxxxx"
 *     data-redirect-uri="https://your.app/oauth/callback"
 *     data-scope="openid kyc">
 *     Verify with Crivacy
 *   </button>
 *
 * For full control call `window.Crivacy.authorize({...})` directly.
 * The bootstrap is a thin wrapper around the @crivacy/js-sdk shape.
 */
(function () {
  'use strict';

  var DEFAULT_ISSUER = 'https://app.crivacy.io';
  var DEFAULT_SCOPE = 'openid kyc';
  var STATE_KEY_PREFIX = 'crivacy.oauth.state.';
  var VERIFIER_KEY_PREFIX = 'crivacy.oauth.verifier.';
  var NONCE_KEY_PREFIX = 'crivacy.oauth.nonce.';
  var REDIRECT_KEY_PREFIX = 'crivacy.oauth.redirect.';
  var VERIFIER_CHARSET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

  function randomChars(len) {
    var bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < len; i += 1) {
      out += VERIFIER_CHARSET.charAt(bytes[i] % VERIFIER_CHARSET.length);
    }
    return out;
  }

  function base64Url(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomStateOrNonce() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  function sha256(data) {
    return crypto.subtle.digest('SHA-256', data);
  }

  function encode(str) {
    return new TextEncoder().encode(str);
  }

  function resolveStorage() {
    try {
      var probe = '__crivacy_probe__';
      sessionStorage.setItem(probe, probe);
      sessionStorage.removeItem(probe);
      return sessionStorage;
    } catch (e) {
      // Private browsing — fall back to an in-memory shim so the
      // flow still completes within the same page lifetime.
      var mem = {};
      return {
        setItem: function (k, v) {
          mem[k] = v;
        },
        getItem: function (k) {
          return mem[k] == null ? null : mem[k];
        },
        removeItem: function (k) {
          delete mem[k];
        },
      };
    }
  }

  async function authorize(options) {
    if (!options || !options.clientId || !options.redirectUri) {
      throw new Error('Crivacy.authorize: clientId and redirectUri are required.');
    }
    var issuer = (options.issuer || DEFAULT_ISSUER).replace(/\/+$/, '');
    var scope =
      typeof options.scope === 'string'
        ? options.scope.trim()
        : Array.isArray(options.scope)
          ? options.scope.join(' ')
          : DEFAULT_SCOPE;

    var state = randomStateOrNonce();
    var codeVerifier = randomChars(64);
    var codeChallenge = base64Url(new Uint8Array(await sha256(encode(codeVerifier))));
    var nonce = /\bopenid\b/.test(scope) ? randomStateOrNonce() : null;

    var storage = resolveStorage();
    storage.setItem(STATE_KEY_PREFIX + options.clientId, state);
    storage.setItem(VERIFIER_KEY_PREFIX + options.clientId, codeVerifier);
    storage.setItem(REDIRECT_KEY_PREFIX + options.clientId, options.redirectUri);
    if (nonce) storage.setItem(NONCE_KEY_PREFIX + options.clientId, nonce);

    // Defence-in-depth: also stash the recovery bundle in a path-scoped
    // cookie so the callback can recover if sessionStorage was cleared
    // (private mode quirks, tab restore, browser extensions, dev hot
    // reload mid-flow). Cookie scope = the redirect URI's first path
    // segment (e.g. `/test-firm`), so this isn't sent on every request
    // to the origin. 600s TTL covers a typical login + consent round
    // trip and self-expires if abandoned.
    try {
      var redirectUrl = new URL(options.redirectUri, window.location.href);
      var cookieScope = '/' + (redirectUrl.pathname.split('/').filter(Boolean)[0] || '');
      var cookieAttrs = '; path=' + cookieScope + '; max-age=600; SameSite=Lax';
      var bundle = JSON.stringify({
        state: state,
        verifier: codeVerifier,
        nonce: nonce,
        redirectUri: options.redirectUri,
      });
      document.cookie =
        'crivacy_oauth_recovery_' +
        encodeURIComponent(options.clientId) +
        '=' +
        encodeURIComponent(bundle) +
        cookieAttrs;
    } catch (e) {
      // Cookie write failure is non-fatal — sessionStorage is the
      // primary store; this is only the recovery copy.
    }

    var url = new URL(issuer + '/api/v1/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('redirect_uri', options.redirectUri);
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (nonce) url.searchParams.set('nonce', nonce);
    if (options.uiLocales) url.searchParams.set('ui_locales', options.uiLocales);

    window.location.assign(url.toString());
  }

  /**
   * Max wall time between click and the redirect actually taking
   * effect. Network stalls, pop-up blockers, offline mode, etc. can
   * leave the browser sitting on the firm's page indefinitely — we
   * reset the button after this so the user isn't stranded staring
   * at a spinner.
   */
  var REDIRECT_TIMEOUT_MS = 10000;

  /**
   * Toggle the loading state on a verify button. Swaps the text of
   * the `.crivacy-button__label` span in-place (preserving the
   * original so we can restore it on reset) and flips the
   * `aria-busy` / `disabled` flags that `button.css` styles off of.
   * Firms can override the busy text via `data-busy-label`.
   */
  function setBusy(el, busy) {
    var labelEl = el.querySelector('.crivacy-button__label');
    if (busy) {
      el.setAttribute('aria-busy', 'true');
      if (el.tagName === 'BUTTON') el.disabled = true;
      if (labelEl) {
        if (!el.hasAttribute('data-original-label')) {
          el.setAttribute('data-original-label', labelEl.textContent || '');
        }
        labelEl.textContent = el.getAttribute('data-busy-label') || 'Verifying…';
      }
    } else {
      el.removeAttribute('aria-busy');
      if (el.tagName === 'BUTTON') el.disabled = false;
      if (labelEl && el.hasAttribute('data-original-label')) {
        labelEl.textContent = el.getAttribute('data-original-label') || '';
        el.removeAttribute('data-original-label');
      }
    }
  }

  function wireDataAttributes() {
    var elements = document.querySelectorAll('[data-crivacy-verify]');
    for (var i = 0; i < elements.length; i += 1) {
      var el = elements[i];
      if (el.__crivacyWired) continue;
      el.__crivacyWired = true;
      el.addEventListener('click', function (event) {
        var target = event.currentTarget;

        // Double-click guard: second clicks while the redirect is in
        // flight are no-ops. Without this, eager users fire two
        // authorize() calls, each with a distinct PKCE verifier — the
        // second one wins sessionStorage, the first redirect carries
        // an orphaned verifier, and /token fails.
        if (target.getAttribute('aria-busy') === 'true') {
          event.preventDefault();
          return;
        }

        var clientId = target.getAttribute('data-client-id');
        var redirectUri = target.getAttribute('data-redirect-uri');
        var scope = target.getAttribute('data-scope');
        var issuer = target.getAttribute('data-issuer');
        var uiLocales = target.getAttribute('data-ui-locales');
        if (!clientId || !redirectUri) {
          // eslint-disable-next-line no-console
          console.error(
            '[crivacy] data-client-id and data-redirect-uri are required on',
            target,
          );
          return;
        }
        event.preventDefault();
        setBusy(target, true);

        // If the redirect never fires (blocked pop-up in iframes,
        // offline state, extension intercept), reset the button after
        // REDIRECT_TIMEOUT_MS so the user can retry instead of
        // watching an infinite spinner.
        var timeoutId = setTimeout(function () {
          setBusy(target, false);
        }, REDIRECT_TIMEOUT_MS);

        authorize({
          clientId: clientId,
          redirectUri: redirectUri,
          scope: scope || undefined,
          issuer: issuer || undefined,
          uiLocales: uiLocales || undefined,
        })
          .then(function () {
            // authorize() resolves right before window.location.assign.
            // The redirect is imminent — leave the busy state so the
            // button looks correct until the page unloads, but clear
            // the timeout so we don't reset post-unload.
            clearTimeout(timeoutId);
          })
          .catch(function (err) {
            // eslint-disable-next-line no-console
            console.error('[crivacy] authorize failed', err);
            clearTimeout(timeoutId);
            setBusy(target, false);
          });
      });
    }
  }

  var Crivacy = {
    version: '1.0.0',
    authorize: authorize,
    wireDataAttributes: wireDataAttributes,
  };

  if (typeof window !== 'undefined') {
    window.Crivacy = Crivacy;

    // Auto-wire buttons that exist at load time.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wireDataAttributes, { once: true });
    } else {
      wireDataAttributes();
    }

    // React / Vue / Svelte SPAs often mount `[data-crivacy-verify]`
    // buttons AFTER the script has already run — navigating to a new
    // route, opening a modal, lazy-rendering a profile panel, etc.
    // The one-shot wire above would miss them, so we also observe
    // future DOM mutations and re-wire.
    //
    // `wireDataAttributes` is idempotent (per-element `__crivacyWired`
    // guard), so calling it on every mutation is safe. A
    // requestAnimationFrame gate keeps us from doing unnecessary work
    // during heavy render storms — at most one pass per frame.
    if (typeof MutationObserver !== 'undefined') {
      var pendingWire = false;
      var scheduleWire = function () {
        if (pendingWire) return;
        pendingWire = true;
        var raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : function (cb) { return setTimeout(cb, 16); };
        raf(function () {
          pendingWire = false;
          wireDataAttributes();
        });
      };
      var observer = new MutationObserver(scheduleWire);
      var startObserving = function () {
        if (document.body) {
          observer.observe(document.body, { childList: true, subtree: true });
        }
      };
      if (document.body) {
        startObserving();
      } else {
        document.addEventListener('DOMContentLoaded', startObserving, { once: true });
      }
    }
  }
})();
