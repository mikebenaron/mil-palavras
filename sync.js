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
  var pending = null;      // the state a debounced push is holding, so it can be flushed
  var synced = false;      // true once this session has actually READ the server row
  var status = "";
  var listening = false;

  /* ------------------- local backup of last progress -------------------
     Signing out replaces the device's only copy of the progress with an
     empty state, and that is fine exactly as long as the server row is
     current — which is not something the app was in a position to promise.
     So nothing is ever overwritten now without a copy being kept first:
     one slot, holding the most recent non-empty state and the account it
     belonged to. It is what makes sign-out survivable. */
  var BACKUP_KEY = "milpalavras.backup";

  function backupRead() {
    try {
      var raw = window.localStorage.getItem(BACKUP_KEY);
      var b = raw ? JSON.parse(raw) : null;
      return b && b.state && b.state.prog ? b : null;
    } catch (e) { return null; }
  }
  function backupWrite(state, why) {
    if (!state || score(state) === 0) return;          // never let an empty state clobber a real backup
    var prev = backupRead();
    // Timestamps only ever move forward, so an older copy never displaces a newer one.
    if (prev && prev.uid === (state._uid || null) && tsOf(prev.state) >= tsOf(state)) return;
    try {
      window.localStorage.setItem(BACKUP_KEY, JSON.stringify({
        at: Date.now(), why: why || "", uid: state._uid || null, state: state
      }));
    } catch (e) { /* quota — the sign-out must still work */ }
  }
  function backupClear() {
    try { window.localStorage.removeItem(BACKUP_KEY); } catch (e) {}
  }

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
    isConfigured: function () { return configured; },
    signedIn: function () { return !!session; },
    // Used by pronunciation assessment to mint a short-lived Azure token.
    invoke: function (name, body) {
      if (!client) return Promise.reject(new Error("not configured"));
      if (!session) return Promise.reject(new Error("not signed in"));
      return client.functions.invoke(name, body ? { body: body } : {});
    }
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
    // Offline-first: say so plainly, and flush anything pending on reconnect.
    window.addEventListener("offline", function () { setStatus("Sem ligação · offline — saved on this device"); });
    window.addEventListener("online", function () {
      setStatus("A sincronizar… · reconnecting…");
      if (session && bridge) doPush(bridge.get());
      maybePull();
    });
    document.addEventListener("visibilitychange", function () {
      // Going away is the last chance to send: a push is debounced 1.2s, and a
      // phone that closes the app right after the final card of a session used
      // to freeze the page with that timer still pending, so the server never
      // heard about the last thing studied. Flush first, then consider pulling.
      if (document.hidden) flushPush();
      else maybePull();
    });
    window.addEventListener("pagehide", flushPush);
    window.addEventListener("focus", maybePull);
    client.auth.onAuthStateChange(function (evt, s) {
      session = s || null;
      if (evt === "SIGNED_IN") enterApp();
      else if (evt === "SIGNED_OUT") signedOut();
      else if (evt === "PASSWORD_RECOVERY") renderSetPassword();
      // INITIAL_SESSION / TOKEN_REFRESHED / USER_UPDATED: no UI change needed
    });
  }

  /* ------------------------- app entry ------------------------ */

  /* Sign-out is destructive by design — the next person to sign in on this
     device must not inherit someone else's deck. What it must not do is throw
     the only copy away: keep a backup, drop any half-sent push, and forget
     that we ever read the server, so the next sign-in has to read it again
     before it is allowed to write. SIGNED_OUT also fires on its own when a
     refresh token finally expires, which is a wipe nobody asked for. */
  function signedOut() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    pending = null;
    synced = false;
    if (bridge) backupWrite(bridge.get(), "signout");
    resetLocal();
    renderLogin("signin");
  }

  function enterApp() {
    setStatus("Syncing…");
    lastPull = Date.now();   // this counts as a pull; don't repeat it on first focus
    var p;
    try { p = syncUserData(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p)
      .then(function () { setStatus("Synced · " + clock()); bridge.render(); })
      .catch(function () {
        /* Offline with progress already on the device is the ordinary case:
           enter the app and sync later. Offline with *nothing* on the device
           is not — showing an empty deck to someone with an account is the
           app claiming their progress is gone when it has simply not looked.
           Say so instead, and let them retry. Nothing can be pushed until a
           read succeeds, so the server row is safe either way. */
        setStatus("Offline — will sync later");
        if (score(bridge.get()) > 0) { bridge.render(); return; }
        renderUnreachable();
      });
  }

  // Signed in, but the progress for this account could not be read.
  function renderUnreachable() {
    var root = document.getElementById("app");
    root.className = "";
    root.innerHTML =
      '<div class="auth-wrap"><div class="auth-inner">' +
        '<div class="auth-brand"><div class="auth-wm">Mil Palavras</div>' +
          '<div class="auth-eyebrow">Sem ligação · offline</div></div>' +
        '<div class="auth-status">Não foi possível ler o teu progresso — a ligação falhou. ' +
          'O teu progresso está guardado na tua conta; não se perdeu.' +
          '<span lang="en"><br><br>Couldn\'t load your progress — the connection failed. ' +
          "Your progress is safe in your account; nothing has been lost.</span></div>" +
        '<button class="btn fill block auth-primary" data-act="retry">Tentar outra vez · try again</button>' +
        '<button class="auth-link" data-act="anyway">Continuar offline · continue offline</button>' +
      '</div></div>';
    root.querySelector('[data-act="retry"]').addEventListener("click", enterApp);
    root.querySelector('[data-act="anyway"]').addEventListener("click", function () { bridge.render(); });
  }

  // Refresh from the server without navigating. Used by "Sync now" and by the
  // automatic pull when the app comes back to the foreground.
  function pullQuiet() {
    lastPull = Date.now();
    setStatus("Syncing…");
    var p;
    try { p = syncUserData(); } catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p)
      .then(function () {
        setStatus("Synced · " + clock());
        // Remote progress may have replaced local state — redraw what's on screen.
        if (bridge && bridge.refresh) bridge.refresh();
      })
      .catch(function () { setStatus("Offline — will sync later"); });
  }

  // Push happens on every save, but nothing ever pulled except at sign-in — so
  // a second device left open never saw work done elsewhere. Pull when the app
  // comes back to the foreground, throttled, and never mid-session.
  var lastPull = 0;
  var PULL_GAP = 20000;
  function maybePull() {
    if (!client || !session) return;
    if (document.hidden) return;
    if (bridge && bridge.busy && bridge.busy()) return;   // don't disturb a running session
    if (Date.now() - lastPull < PULL_GAP) return;
    pullQuiet();
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
        // We have now read the server, so writing to it can no longer destroy
        // something we never saw. Nothing before this line may push.
        synced = true;
        var remote = res.data ? res.data.data : null;
        var local = bridge.get();
        var localIsThisUser = local && local._uid === U;

        // Work this account did on this device that never reached the server —
        // most likely because signing out wiped it before the last push landed.
        // Same last-write-wins rule as everywhere else, so a genuinely newer
        // row written by another device still takes precedence.
        var back = backupRead();
        if (back && back.uid === U && !localIsThisUser && tsOf(back.state) > tsOf(remote)) {
          backupClear();
          back.state._uid = U;
          applyState(back.state);
          doPush(back.state);
          return;
        }

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
    // If what's being replaced holds more progress than what's arriving, keep
    // a copy of it — the device is the only place that work still exists.
    var out = bridge.get();
    if (out && out !== ns && score(out) > score(ns)) backupWrite(out, "replaced");
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
    pending = state;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; doPush(pending); }, 1200);
  }

  // Send a debounced push right now — used when the page is about to be hidden
  // or torn down, where the timer would otherwise never get to fire.
  function flushPush() {
    if (!pushTimer) return;
    clearTimeout(pushTimer);
    pushTimer = null;
    doPush(pending);
  }

  function doPush(state) {
    if (!client || !session) return;
    /* Never write before this session has read the row. A sign-in whose pull
       failed (a phone on a bad connection is the ordinary case) leaves an
       empty state on screen; without this guard the next answered card
       uploaded that emptiness over the real progress, with a fresh timestamp,
       and last-write-wins made it permanent. Offline work is still saved
       locally and goes up once a pull has actually succeeded. */
    if (!synced) return;
    if (state && !state._uid) state._uid = session.user.id;
    // A push queued before a sign-out must not land in whoever signs in next.
    if (state && state._uid !== session.user.id) return;
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
        // People should be able to read these *before* handing over an email.
        '<div class="auth-legal">Ao criares conta aceitas os <button data-legal-auth="termos">Termos</button> ' +
          'e a <button data-legal-auth="privacidade">Privacidade</button>.' +
          '<span lang="en"><br>By creating an account you agree to the Terms and Privacy notice.</span></div>' +
      '</div></div>';

    each(root, "[data-mode]", "click", function (e) {
      renderLogin(e.currentTarget.getAttribute("data-mode"));
    });
    each(root, "[data-legal-auth]", "click", function (e) {
      var kind = e.currentTarget.getAttribute("data-legal-auth");
      if (window.MilLegal) window.MilLegal.show(kind, function () { renderLogin(mode); });
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
      '<div class="acctrow"><div class="acctlabel">Sessão iniciada como · signed in as</div>' +
        '<div class="acctmail">' + esc(session.user.email || "your account") + '</div></div>' +
      '<div class="foot" style="text-align:left" id="syncStatus">' + esc(status || "Synced") + '</div>' +
      hint("O progresso sincroniza sozinho — ao guardar, e sempre que voltas à aplicação. O botão abaixo é só para forçares. · " +
        "Progress syncs on its own: on every save, and whenever you return to the app. The button below is only to force it.") +
      '<div class="stack mt">' +
        '<button class="btn outline block" data-sync="pull">Sincronizar agora · sync now</button>' +
        '<button class="btn outline block" data-sync="pw">Mudar palavra-passe · change password</button>' +
        '<button class="btn outline block" data-sync="signout">Terminar sessão · sign out</button>' +
      '</div>' +
      backupOffer() +
      '<div id="acctIO"></div>' +
      '<div class="stack mt">' +
        '<button class="btn outline block danger" data-sync="delete">Apagar a conta · delete account</button>' +
      '</div>';

    var io = el.querySelector("#acctIO");
    each(el, '[data-sync="pull"]', "click", function () { if (session) pullQuiet(); });
    each(el, '[data-sync="signout"]', "click", function () {
      client.auth.signOut();   // SIGNED_OUT → backup + resetLocal + login screen
    });
    each(el, '[data-sync="restore"]', "click", function () {
      var b = backupRead();
      if (!b) return;
      backupClear();
      b.state._uid = session.user.id;
      // Asked for by hand, so it wins: stamped now, it beats whatever any
      // other device has, instead of being pulled back over on the next sync.
      b.state._updatedAt = Date.now();
      applyState(b.state);        // the state being replaced becomes the new backup
      doPush(b.state);
      if (bridge && bridge.refresh) bridge.refresh();
      else renderAccountPanel();
    });

    each(el, '[data-sync="pw"]', "click", function () {
      io.removeAttribute("data-armed");
      io.innerHTML =
        '<div class="acctbox"><input id="pw1" type="password" autocomplete="new-password" placeholder="Nova palavra-passe · new password">' +
        '<button class="btn block mt" data-sync="pwsave">Guardar · save</button>' +
        '<div class="foot" id="pwMsg"></div></div>';
      each(io, '[data-sync="pwsave"]', "click", function () {
        var v = io.querySelector("#pw1").value;
        var msg = io.querySelector("#pwMsg");
        if (!v || v.length < 8) { msg.textContent = "Use pelo menos 8 caracteres · use at least 8 characters."; return; }
        msg.textContent = "A guardar… · saving…";
        client.auth.updateUser({ password: v })
          .then(function (res) {
            msg.textContent = res.error ? friendly(res.error.message)
              : "Palavra-passe alterada · password changed.";
            if (!res.error) io.querySelector("#pw1").value = "";
          })
          .catch(function () { msg.textContent = "Não foi possível alterar · couldn't change it."; });
      });
    });

    // Two-step confirm, same arm-then-confirm pattern as "erase all progress".
    each(el, '[data-sync="delete"]', "click", function () {
      if (io.getAttribute("data-armed") === "del") { doDeleteAccount(io); return; }
      io.setAttribute("data-armed", "del");
      io.innerHTML = '<div class="acctbox warn">Isto apaga a tua conta e todo o progresso guardado. Não há como voltar atrás. ' +
        'Toca outra vez em <em>Apagar a conta</em> para confirmar.<br><br>' +
        'This deletes your account and all saved progress. This cannot be undone. ' +
        'Tap <em>Delete account</em> once more to confirm.</div>';
    });
  }

  /* The device's own copy of the last progress it held, offered back whenever
     it isn't the one currently loaded. Automatic recovery already handles the
     ordinary sign-out case; this is for when the automatic answer was the
     wrong one, and it means "I lost everything" always has a button. */
  function backupOffer() {
    if (!session || !bridge) return "";
    var b = backupRead();
    if (!b || b.uid !== session.user.id) return "";
    var cur = bridge.get();
    if (tsOf(b.state) === tsOf(cur)) return "";
    var n = Object.keys(b.state.prog || {}).length;
    return '<div class="acctbox" style="margin-top:14px">' +
      "Este telemóvel guardou uma cópia do progresso em <strong>" + esc(when(b.at)) + "</strong> — " +
      n + " cartões. Se o que vês agora não é o teu progresso, repõe essa cópia." +
      '<span lang="en"><br>This device kept a copy of your progress from ' + esc(when(b.at)) +
      " (" + n + " cards). If what you're seeing now isn't yours, restore it.</span>" +
      '<button class="btn block mt" data-sync="restore">Repor essa cópia · restore that copy</button></div>';
  }

  // Removes the user's synced data, then asks the server to remove the login
  // itself. Deleting an auth user needs the service-role key, which must never
  // ship in the browser — so that half runs in a Supabase Edge Function.
  function doDeleteAccount(io) {
    io.innerHTML = '<div class="acctbox">A apagar… · deleting…</div>';
    client.from("progress").delete().eq("user_id", session.user.id)
      .then(function () {
        return client.functions.invoke("delete-account").catch(function (e) { return { error: e }; });
      })
      .then(function (res) {
        var fnMissing = res && res.error;
        try { localStorage.clear(); } catch (e) {}
        return client.auth.signOut().then(function () {
          if (fnMissing) {
            // Data is gone and the session is over, but be honest that the
            // login record itself may still exist server-side.
            alert("O teu progresso foi apagado e a sessão terminada.\n\n" +
              "Your progress has been deleted and you've been signed out. " +
              "The login record itself is removed once the delete-account function is deployed — " +
              "email the address in the privacy notice to have it removed now.");
          }
        });
      })
      .catch(function () {
        io.innerHTML = '<div class="acctbox warn">Não foi possível apagar · couldn\'t delete. Tenta de novo.</div>';
      });
  }

  /* --------------------------- utils -------------------------- */

  function redirectURL() { return location.origin + location.pathname; }
  function setStatus(s) { status = s; var e = document.getElementById("syncStatus"); if (e) e.textContent = s; }
  function hint(html) { return '<div class="hint" style="font-size:11.5px;color:var(--slate)">' + html + "</div>"; }
  function clock() { var d = new Date(); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function when(ts) {
    var d = new Date(ts || 0);
    return ("0" + d.getDate()).slice(-2) + "/" + ("0" + (d.getMonth() + 1)).slice(-2) +
      " · " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function each(root, sel, ev, fn) { var n = root.querySelectorAll(sel); for (var i = 0; i < n.length; i++) n[i].addEventListener(ev, fn); }

  function injectStyles() {
    if (document.getElementById("mil-auth-css")) return;
    var css =
      /* account panel inside Definições */
      ".auth-legal{margin-top:18px;text-align:center;font-size:11px;line-height:1.6;color:var(--slate)}" +
      ".auth-legal button{font:inherit;color:var(--terracotta);text-decoration:underline}" +
      ".acctrow{padding:12px 0;border-bottom:1px solid var(--rule-3)}" +
      ".acctlabel{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--slate)}" +
      ".acctmail{font-family:var(--serif);font-size:19px;color:var(--ink);margin-top:4px;word-break:break-all}" +
      ".acctbox{margin-top:12px;padding:14px;box-shadow:inset 0 0 0 1px var(--rule-3);font-size:13px;line-height:1.5;color:var(--slate)}" +
      ".acctbox.warn{box-shadow:inset 0 0 0 1.4px var(--vinho);color:var(--vinho)}" +
      ".acctbox input{width:100%;padding:12px;font:inherit;font-size:16px;box-shadow:inset 0 0 0 1px var(--rule-3);background:var(--paper);color:var(--ink)}" +
      ".acctbox .mt{margin-top:10px}" +
      ".btn.danger{color:var(--vinho);box-shadow:inset 0 0 0 1.4px var(--vinho)}" +
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
