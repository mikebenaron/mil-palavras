/* ============================================================
   Mil Palavras — accounts + cross-device sync (Supabase)

   Account-first: the app is gated behind a login screen. Once
   signed in, progress is tied to the user's account and synced.
   After the first online login the session is cached, so later
   launches work fully offline.

     • gate()        — decide on launch: show login, or enter app
     • login/signup  — email + password (Supabase auth)
     • enterApp()    — load this account's progress, then run app
     • push()/pull() — keep local and cloud in step (offline-first,
                       last-write-wins by S._updatedAt)
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.MIL_SYNC_CONFIG || {};
  var configured = !!(window.supabase && CFG.url && CFG.anonKey);
  var client = configured
    ? window.supabase.createClient(CFG.url, CFG.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
          storageKey: "milpalavras.auth"
        }
      })
    : null;

  var bridge = null;       // { get, set, persist, save, render, freshState }
  var session = null;
  var applying = false;    // true while writing a pulled/loaded state (suppresses echo push)
  var pushTimer = null;
  var status = "";
  var listening = false;

  var BADGE =
    "<svg viewBox='0 0 32 32' xmlns='http://www.w3.org/2000/svg'>" +
    "<rect width='32' height='32' fill='#FCFBF8'/>" +
    "<rect x='3.5' y='3.5' width='25' height='25' fill='none' stroke='#1B4D8F' stroke-width='1.5'/>" +
    "<rect x='6.5' y='6.5' width='19' height='19' fill='none' stroke='#4E7FBE' stroke-width='.8'/>" +
    "<rect x='13' y='13' width='6' height='6' fill='#1B4D8F' transform='rotate(45 16 16)'/></svg>";

  // Public API used by the app (index.html).
  window.MilSync = {
    attach: function (b) { bridge = b; injectStyles(); },
    gate: gate,
    push: function (state) { if (client && session && !applying) schedulePush(state); },
    mount: renderAccountPanel,
    isConfigured: function () { return configured; }
  };

  /* --------------------------- gate --------------------------- */

  function gate() {
    if (!client) { bridge.render(); return; }   // misconfigured — don't lock the user out
    setupListener();
    client.auth.getSession()
      .then(function (r) {
        session = (r && r.data && r.data.session) || null;
        if (session) enterApp();
        else renderLogin("signin");
      })
      .catch(function () { renderLogin("signin"); });
  }

  function setupListener() {
    if (listening) return;
    listening = true;
    client.auth.onAuthStateChange(function (evt, s) {
      session = s || null;
      if (evt === "SIGNED_IN") enterApp();
      else if (evt === "SIGNED_OUT") { resetLocal(); renderLogin("signin"); }
      else if (evt === "PASSWORD_RECOVERY") renderSetPassword();
      // INITIAL_SESSION / TOKEN_REFRESHED / USER_UPDATED: no UI change needed
    });
  }

  /* ------------------------- app entry ------------------------ */

  function enterApp() {
    setStatus("Syncing…");
    var p;
    try { p = syncUserData(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p)
      .then(function () { setStatus("Synced · " + clock()); })
      .catch(function () { /* offline / error — fall back to the local cache */ })
      .then(function () { bridge.render(); });   // always enter the app
  }

  // Refresh from the server without navigating (used by "Sync now" in Settings).
  function pullQuiet() {
    setStatus("Syncing…");
    var p;
    try { p = syncUserData(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p)
      .then(function () { setStatus("Synced · " + clock()); })
      .catch(function () { setStatus("Offline — will sync later"); });
  }

  function tsOf(x) { return (x && x._updatedAt) || 0; }
  // Rough "how much progress" measure, used only to decide whether un-synced
  // local data should seed an otherwise-empty account on first login.
  function score(s) {
    if (!s) return 0;
    return (s.reviews || 0) + (s.prog ? Object.keys(s.prog).length : 0) + (s.streak || 0);
  }

  // Reconcile this account's progress between the server and the local cache.
  function syncUserData() {
    var U = session.user.id;
    return client.from("progress").select("data").eq("user_id", U).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        var remote = res.data ? res.data.data : null;
        var local = bridge.get();
        var localIsThisUser = local && local._uid === U;

        if (remote) {
          if (localIsThisUser) {
            // Same account already synced here — last-write-wins by timestamp.
            if (tsOf(local) > tsOf(remote)) doPush(local);
            else { remote._uid = U; applyState(remote); }
          } else if (local && !local._uid && score(remote) === 0 && score(local) > 0) {
            // First login on a device that has un-synced progress (e.g. from the
            // original offline app), and the account's server row is still empty:
            // seed the account from this device so that progress isn't lost.
            local._uid = U; bridge.persist(); doPush(local);
          } else {
            // Server is authoritative for this account.
            remote._uid = U; applyState(remote);
          }
        } else {
          // No server row yet for this account.
          if (local && local._uid && local._uid !== U) {
            // Someone else used this device — start this account clean.
            var fresh = bridge.freshState(); fresh._uid = U; applyState(fresh);
            doPush(fresh);
          } else {
            // Claim the current local progress for this account and seed the server.
            local._uid = U; bridge.persist(); doPush(local);
          }
        }
      });
  }

  function applyState(ns) {
    applying = true;
    bridge.set(ns);
    bridge.persist();      // raw save — no timestamp bump, no echo push
    applying = false;
  }

  function resetLocal() {
    applyState(bridge.freshState());
  }

  /* --------------------------- push --------------------------- */

  function schedulePush(state) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { doPush(state); }, 1200);
  }

  function doPush(state) {
    if (!client || !session) return;
    if (state && !state._uid) state._uid = session.user.id;
    setStatus("Saving…");
    client.from("progress")
      .upsert({
        user_id: session.user.id,
        data: state,
        updated_at: new Date(tsOf(state) || Date.now()).toISOString()
      }, { onConflict: "user_id" })
      .then(function (res) { setStatus(res.error ? "Sync error" : "Synced · " + clock()); })
      .catch(function () { setStatus("Offline — will sync later"); });
  }

  /* ------------------------ login screen ---------------------- */

  function renderLogin(mode) {
    mode = mode || "signin";
    var signup = mode === "signup";
    var root = document.getElementById("app");
    root.className = "";
    root.innerHTML =
      '<div class="auth-wrap"><div class="auth-inner">' +
        '<div class="auth-brand"><div class="auth-wm">Mil Palavras</div>' +
          '<div class="auth-eyebrow">Português europeu · caderno pessoal</div></div>' +
        '<div class="auth-seg">' +
          '<button class="' + (signup ? "" : "on") + '" data-mode="signin">Entrar</button>' +
          '<button class="' + (signup ? "on" : "") + '" data-mode="signup">Criar conta</button>' +
        '</div>' +
        '<input id="authEmail" type="email" inputmode="email" autocomplete="email" placeholder="Email">' +
        '<input id="authPass" type="password" autocomplete="' + (signup ? "new-password" : "current-password") + '" placeholder="Palavra-passe · password">' +
        (signup ? '<div class="auth-note">Pelo menos 6 caracteres · at least 6 characters.</div>' : "") +
        '<button class="btn fill block auth-primary" data-act="submit">' + (signup ? "Criar conta · create account" : "Entrar · sign in") + '</button>' +
        (signup ? "" : '<button class="auth-link" data-act="forgot">Esqueci-me · forgot password?</button>') +
        '<div class="auth-status" id="authStatus"></div>' +
      '</div></div>';

    each(root, "[data-mode]", "click", function (e) {
      renderLogin(e.currentTarget.getAttribute("data-mode"));
    });
    var pass = root.querySelector("#authPass");
    pass.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    root.querySelector('[data-act="submit"]').addEventListener("click", submit);
    var forgot = root.querySelector('[data-act="forgot"]');
    if (forgot) forgot.addEventListener("click", doForgot);

    function creds() {
      return {
        email: (root.querySelector("#authEmail").value || "").trim(),
        password: root.querySelector("#authPass").value || ""
      };
    }
    function submit() {
      var c = creds();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) return authStatus("Enter a valid email address.", "err");
      if (c.password.length < 6) return authStatus("Password must be at least 6 characters.", "err");
      authStatus(signup ? "Creating account…" : "Signing in…");
      if (signup) {
        client.auth.signUp({
          email: c.email, password: c.password,
          options: { emailRedirectTo: redirectURL() }
        }).then(function (res) {
          if (res.error) return authStatus(res.error.message, "err");
          if (res.data.session) authStatus("Account created!", "ok");       // confirmation disabled → signed in
          else authStatus("Account created. Check your email to confirm, then sign in.", "ok");
        }).catch(function () { authStatus("Couldn't create the account — try again.", "err"); });
      } else {
        client.auth.signInWithPassword({ email: c.email, password: c.password })
          .then(function (res) {
            if (res.error) authStatus(friendly(res.error.message), "err");
            else authStatus("Signing in…");                                  // SIGNED_IN → enterApp
          })
          .catch(function () { authStatus("Couldn't sign in — try again.", "err"); });
      }
    }
    function doForgot() {
      var email = (root.querySelector("#authEmail").value || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return authStatus("Type your email above first, then tap Forgot password.", "err");
      authStatus("Sending reset link…");
      client.auth.resetPasswordForEmail(email, { redirectTo: redirectURL() })
        .then(function (res) { authStatus(res.error ? res.error.message : "Password reset link sent — check your email.", res.error ? "err" : "ok"); })
        .catch(function () { authStatus("Couldn't send the reset link.", "err"); });
    }
  }

  // Shown when the user returns from a password-reset email.
  function renderSetPassword() {
    var root = document.getElementById("app");
    root.className = "";
    root.innerHTML =
      '<div class="auth-wrap"><div class="auth-inner">' +
        '<div class="auth-brand"><div class="auth-wm">Mil Palavras</div>' +
          '<div class="auth-eyebrow">Nova palavra-passe · new password</div></div>' +
        '<input id="authPass" type="password" autocomplete="new-password" placeholder="Nova palavra-passe · new password">' +
        '<div class="auth-note">Pelo menos 6 caracteres · at least 6 characters.</div>' +
        '<button class="btn fill block auth-primary" data-act="save">Guardar · save password</button>' +
        '<div class="auth-status" id="authStatus"></div>' +
      '</div></div>';
    root.querySelector('[data-act="save"]').addEventListener("click", function () {
      var pw = root.querySelector("#authPass").value || "";
      if (pw.length < 6) return authStatus("Password must be at least 6 characters.", "err");
      authStatus("Saving…");
      client.auth.updateUser({ password: pw })
        .then(function (res) {
          if (res.error) authStatus(res.error.message, "err");
          else enterApp();     // already has a session from the recovery link
        })
        .catch(function () { authStatus("Couldn't save the password.", "err"); });
    });
  }

  function authStatus(msg, kind) {
    var e = document.getElementById("authStatus");
    if (!e) return;
    e.textContent = msg;
    e.className = "auth-status" + (kind ? " " + kind : "");
  }
  function friendly(m) {
    if (/invalid login/i.test(m)) return "Email or password is incorrect.";
    if (/not confirmed/i.test(m)) return "Please confirm your email first (check your inbox).";
    return m;
  }

  /* --------------- account panel inside Settings -------------- */

  function renderAccountPanel() {
    var el = document.getElementById("syncMount");
    if (!el) return;
    if (!client) { el.innerHTML = hint("Accounts aren't switched on in this build yet."); return; }
    if (!session) { el.innerHTML = hint("You're not signed in."); return; }
    el.innerHTML =
      hint("Signed in as <b>" + esc(session.user.email || "your account") + "</b>. Progress syncs to every device you sign in on.") +
      '<div class="foot" style="text-align:left" id="syncStatus">' + esc(status || "Synced") + '</div>' +
      '<div class="stack mt">' +
        '<button class="btn quiet" data-sync="pull">Sync now</button>' +
        '<button class="btn quiet" style="color:var(--vinho)" data-sync="signout">Sign out</button>' +
      '</div>';
    el.querySelector('[data-sync="pull"]').addEventListener("click", function () {
      if (session) pullQuiet();
    });
    el.querySelector('[data-sync="signout"]').addEventListener("click", function () {
      client.auth.signOut();   // SIGNED_OUT → resetLocal + login screen
    });
  }

  /* --------------------------- utils -------------------------- */

  function redirectURL() { return location.origin + location.pathname; }
  function setStatus(s) { status = s; var e = document.getElementById("syncStatus"); if (e) e.textContent = s; }
  function hint(html) { return '<div class="hint" style="font-size:11.5px;color:var(--slate)">' + html + "</div>"; }
  function clock() { var d = new Date(); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function each(root, sel, ev, fn) { var n = root.querySelectorAll(sel); for (var i = 0; i < n.length; i++) n[i].addEventListener(ev, fn); }

  function injectStyles() {
    if (document.getElementById("mil-auth-css")) return;
    var css =
      ".auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--paper);" +
        "padding:calc(env(safe-area-inset-top,0px) + 40px) 26px calc(env(safe-area-inset-bottom,0px) + 32px)}" +
      ".auth-inner{width:100%;max-width:360px}" +
      ".auth-brand{text-align:center;margin-bottom:26px}" +
      ".auth-wm{font-family:var(--serif);font-style:italic;font-size:40px;color:var(--ink);line-height:1}" +
      ".auth-eyebrow{font-size:9px;letter-spacing:.26em;text-transform:uppercase;color:var(--terracotta);font-weight:700;margin-top:10px}" +
      ".auth-seg{display:flex;margin-bottom:6px}" +
      ".auth-seg button{flex:1;text-align:center;padding:11px 0;font-size:12.5px;font-weight:600;" +
        "box-shadow:inset 0 0 0 1px var(--rule-3);color:var(--slate)}" +
      ".auth-seg button.on{background:var(--ink);color:var(--paper);box-shadow:none}" +
      ".auth-inner input{width:100%;padding:13px;margin-top:10px;background:var(--card);border:0;border-radius:0;" +
        "box-shadow:inset 0 0 0 1px var(--rule-2);color:var(--ink);font-size:16px;-webkit-appearance:none}" +
      ".auth-inner input:focus{outline:none;box-shadow:inset 0 0 0 2px var(--terracotta)}" +
      ".auth-note{font-size:11.5px;color:var(--slate-en);margin-top:8px}" +
      ".auth-primary{margin-top:16px}" +
      ".auth-link{display:block;width:100%;text-align:center;margin-top:14px;color:var(--terracotta);" +
        "font-size:12.5px;font-weight:600;background:none;border:none;cursor:pointer}" +
      ".auth-status{margin-top:14px;text-align:center;font-size:12.5px;color:var(--slate);min-height:16px;line-height:1.45}" +
      ".auth-status.err{color:var(--vinho)}.auth-status.ok{color:var(--teal)}";
    var s = document.createElement("style");
    s.id = "mil-auth-css";
    s.textContent = css;
    document.head.appendChild(s);
  }
})();
