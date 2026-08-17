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
                       merged per card, never last-write-wins)
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
  var serverTs = null;     // the row's updated_at as the server last reported it
  var lastError = null;    // whatever the server last complained about, shown rather than guessed at
  var status = "";
  var listening = false;

  /* ----------------------- local snapshots -----------------------
     The device keeps its own short history of this account's progress,
     independently of the server. It exists because the two moments when
     the app throws local progress away — signing out, and applying what
     the server says — used to be the moments it could be lost for good.

     One snapshot per account per day, newest first, trimmed to a byte
     budget rather than a count, because a full deck is a megabyte and a
     beginner's is a hundredth of that. They are never cleared by signing
     out; that is the whole point of them. */
  var SNAP_KEY = "milpalavras.snaps";
  var SNAP_BUDGET = 1500000;    // a maxed-out deck is ~1.3MB; most are a fiftieth of that
  var SNAP_KEEP = 14;           // and a fortnight is further back than anyone needs

  function snapsRead() {
    try {
      var raw = window.localStorage.getItem(SNAP_KEY);
      var list = raw ? JSON.parse(raw) : null;
      return list && list.length ? list.filter(function (s) { return s && s.state && s.state.prog; }) : [];
    } catch (e) { return []; }
  }
  function snapsWrite(list) {
    // Newest first, then keep as many as fit. Dropping the oldest is the only
    // acceptable way to lose one, and a full disk must not break signing out.
    list.sort(function (x, y) { return (y.at || 0) - (x.at || 0); });
    if (list.length > SNAP_KEEP) list.length = SNAP_KEEP;
    var bytes = 0, keep = [];
    for (var i = 0; i < list.length; i++) {
      var s = JSON.stringify(list[i]);
      if (keep.length && bytes + s.length > SNAP_BUDGET) break;
      bytes += s.length; keep.push(list[i]);
    }
    while (keep.length) {
      try { window.localStorage.setItem(SNAP_KEY, JSON.stringify(keep)); return; }
      catch (e) { keep.pop(); }        // quota: shed the oldest and try again
    }
    try { window.localStorage.removeItem(SNAP_KEY); } catch (e) {}
  }
  function snapTake(state, why) {
    if (!state || score(state) === 0) return;      // an empty state is not worth keeping
    var uid = state._uid || null, day = Math.floor(Date.now() / 86400000);
    var list = snapsRead(), i;
    for (i = 0; i < list.length; i++) {
      if (list[i].uid === uid && list[i].day === day) {
        if (tsOf(list[i].state) >= tsOf(state) && score(list[i].state) >= score(state)) return;
        list.splice(i, 1); break;                  // one per account per day, the fullest one
      }
    }
    list.push({ at: Date.now(), day: day, uid: uid, why: why || "", state: state });
    snapsWrite(list);
  }
  // The most recent copy this device holds of a given account.
  function snapLatest(uid) {
    var list = snapsRead(), best = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].uid !== uid && list[i].uid !== null) continue;
      if (!best || tsOf(list[i].state) > tsOf(best.state)) best = list[i];
    }
    return best;
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
      retryPush();
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
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    pending = null;
    dirty = null;
    retryWait = 0;
    synced = false;
    serverTs = null;
    if (bridge) snapTake(bridge.get(), "signout");
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
      .catch(function (err) {
        /* Offline with progress already on the device is the ordinary case:
           enter the app and sync later. Offline with *nothing* on the device
           is not — showing an empty deck to someone with an account is the
           app claiming their progress is gone when it has simply not looked.
           Nothing can be pushed until a read succeeds, so the row is safe
           whichever way this goes. */
        lastError = err || lastError;
        setStatus("Offline — will sync later");
        if (score(bridge.get()) > 0) { bridge.render(); return; }
        // This device's own copy of the account beats a blank screen, and it
        // cannot be uploaded over anything until a read has succeeded.
        var kept = snapLatest(session.user.id);
        if (kept && score(kept.state) > 0) {
          kept.state._uid = session.user.id;
          applyState(kept.state);
          bridge.render();
          return;
        }
        renderUnreachable(err);
      });
  }

  /* Signed in, but the progress for this account could not be read. What went
     wrong is printed rather than guessed at: this screen replaced one that
     entered the app with an empty deck, which is the same failure wearing the
     words "you have no progress". A wrong diagnosis on it would be no better. */
  function renderUnreachable(err) {
    var root = document.getElementById("app");
    clearShell();
    root.className = "";
    root.innerHTML =
      '<div class="auth-wrap"><div class="auth-inner">' +
        '<div class="auth-brand"><div class="auth-wm">Mil Palavras</div>' +
          '<div class="auth-eyebrow">Sem ligação · offline</div></div>' +
        '<div class="auth-status">Não foi possível ler o teu progresso. ' +
          'Está guardado na tua conta e não foi apagado — esta ligação é que falhou.' +
          '<span lang="en"><br><br>Couldn\'t read your progress. It is stored in your ' +
          "account and has not been deleted — it is this connection that failed.</span></div>" +
        '<button class="btn fill block auth-primary" data-act="retry">Tentar outra vez · try again</button>' +
        '<button class="auth-link" data-act="anyway">Continuar offline · continue offline</button>' +
        errLine(err) +
      '</div></div>';
    root.querySelector('[data-act="retry"]').addEventListener("click", enterApp);
    root.querySelector('[data-act="anyway"]').addEventListener("click", function () { bridge.render(); });
  }
  function errLine(err) {
    if (!err) return "";
    var bits = [err.message || String(err), err.code, err.hint, err.details]
      .filter(Boolean).join(" · ");
    return '<div class="auth-note" style="text-align:center;margin-top:22px;opacity:.75">' +
      esc(bits) + "</div>";
  }
  /* The tab bar lives outside #app, so replacing #app leaves it on screen —
     five destinations offered by a screen that has none. */
  function clearShell() {
    var host = document.getElementById("tabhost");
    if (host) host.innerHTML = "";
    try { document.body.classList.remove("hastabs"); } catch (e) {}
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

  /* Reconcile this account's progress between the server, this device's live
     copy, and this device's own snapshot of the account.

     There used to be five branches here deciding which copy should win, and
     every one of them threw the other copy away. They are gone: the three
     copies are *merged*, so the question of who wins is only ever asked per
     card, and never in a way that can subtract. What survived is the one
     judgement a merge cannot make — whether a copy belongs to this account at
     all. Another person's deck on a shared device is not merged into yours. */
  function syncUserData() {
    var U = session.user.id;
    return client.from("progress").select("*").eq("user_id", U).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        // We have now read the server, so writing to it can no longer destroy
        // something we never saw. Nothing before this line may push.
        synced = true;
        serverTs = (res.data && res.data.updated_at) || null;
        var remote = res.data ? res.data.data : null;
        var local = bridge.get();
        // No _uid means progress made before this device ever signed in — it
        // belongs to whoever is signing in on it now. Someone else's does not.
        var mine = local && (!local._uid || local._uid === U) ? local : null;
        if (local && !mine) snapTake(local, "other-account");
        // What this device last knew about this account, which after a sign-out
        // is the only place the last few days still exist.
        var kept = snapLatest(U);

        var merged = remote || null;
        [kept && kept.state, mine].forEach(function (s) {
          if (s && s.prog) merged = merged ? mergeStates(merged, s) : s;
        });
        if (!merged) merged = bridge.freshState();
        merged._uid = U;

        applyState(merged);
        // Push whenever the merge added anything the server didn't have. It
        // costs one write and it is how another device's work gets home.
        if (!remote || score(merged) !== score(remote) || tsOf(merged) !== tsOf(remote)) doPush(merged, true);
      });
  }

  /* The app owns the shape of its state, so it owns the merge; sync.js only
     knows to call it. An older cached index.html won't have one — fall back to
     the copy with more in it rather than to a hard-coded rule that could drop
     the other. */
  function mergeStates(a, b) {
    if (bridge.merge) return bridge.merge(a, b);
    return score(a) >= score(b) ? a : b;
  }

  function applyState(ns) {
    /* If what's being replaced holds more than what's arriving, keep it. The
       merge means that should now be impossible for this account — which is
       exactly the sort of belief a safety net is for. Guarded, because reading
       and rewriting the snapshot list on every foreground pull is real work on
       a phone with a full deck. */
    var out = bridge.get();
    if (out && out !== ns && score(out) > score(ns)) snapTake(out, "replaced");
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

  function doPush(state, again) {
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
    /* A write replaces the whole row, so it has to know it isn't standing on
       something newer. Two phones used offline on the same afternoon both
       pushed blind, and whichever synced second simply erased the other's
       work — the merge on *pull* never saw it, because it had already gone.
       One small read of the timestamp column settles it: if the row moved
       since we last looked, pull and merge first, and that merge is what gets
       written. `again` stops a busy row from bouncing this back and forth. */
    client.from("progress").select("*").eq("user_id", session.user.id).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        var now = (res.data && res.data.updated_at) || null;
        if (!again && now !== serverTs) return syncUserData();
        return writeRow(state);
      })
      .catch(function (e) { pushFailed(state, e); });
  }

  function writeRow(state) {
    return client.from("progress")
      .upsert({
        user_id: session.user.id,
        data: state,
        updated_at: new Date(tsOf(state) || Date.now()).toISOString()
      }, { onConflict: "user_id" })
      // Read the stamp back rather than assuming ours: it is what the next
      // push compares against, so it has to be the server's own wording of it.
      .select("*").maybeSingle()
      .then(function (res) {
        if (res.error) { pushFailed(state, res.error); return; }
        serverTs = (res.data && res.data.updated_at) || null;
        pushDone(state);
      });
  }

  /* A push is not finished when it is sent, it is finished when the server
     says so. Until then the state stays `dirty` and is retried — backing off,
     but never giving up — because "saved" was previously assumed the moment
     the request left, and a phone on a train quietly stopped syncing for the
     rest of the day. */
  var dirty = null, retryTimer = null, retryWait = 0, snapDay = 0;
  var RETRY_MIN = 5000, RETRY_MAX = 300000;

  function pushDone(state) {
    if (dirty === state) dirty = null;
    retryWait = 0;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    setStatus("Synced · " + clock());
    // One snapshot a day, taken at a moment we know the state is sound.
    var d = Math.floor(Date.now() / 86400000);
    if (d !== snapDay) { snapDay = d; snapTake(state, "daily"); }
  }
  function pushFailed(state, err) {
    dirty = state;
    lastError = err || lastError;
    setStatus(err && err.message ? "Não guardou · " + err.message : "Offline — will sync later");
    if (retryTimer) return;
    retryWait = Math.min(RETRY_MAX, retryWait ? retryWait * 2 : RETRY_MIN);
    retryTimer = setTimeout(function () { retryTimer = null; retryPush(); }, retryWait);
  }
  function retryPush() { if (dirty) doPush(dirty); }

  /* ------------------------ login screen ---------------------- */

  function renderLogin(mode) {
    mode = mode || "signin";
    var signup = mode === "signup";
    var root = document.getElementById("app");
    clearShell();
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
    clearShell();
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
      (lastError ? '<div class="foot" style="text-align:left;opacity:.75">' +
        esc([lastError.message || String(lastError), lastError.code, lastError.hint].filter(Boolean).join(" · ")) +
        '</div>' : "") +
      hint("O progresso sincroniza sozinho — ao guardar, e sempre que voltas à aplicação. O botão abaixo é só para forçares. · " +
        "Progress syncs on its own: on every save, and whenever you return to the app. The button below is only to force it.") +
      '<div class="stack mt">' +
        '<button class="btn outline block" data-sync="pull">Sincronizar agora · sync now</button>' +
        '<button class="btn outline block" data-sync="pw">Mudar palavra-passe · change password</button>' +
        '<button class="btn outline block" data-sync="signout">Terminar sessão · sign out</button>' +
      '</div>' +
      snapOffer() +
      '<div id="acctIO"></div>' +
      '<div class="stack mt">' +
        '<button class="btn outline block danger" data-sync="delete">Apagar a conta · delete account</button>' +
      '</div>';

    var io = el.querySelector("#acctIO");
    each(el, '[data-sync="pull"]', "click", function () { if (session) pullQuiet(); });
    each(el, '[data-sync="signout"]', "click", function () {
      client.auth.signOut();   // SIGNED_OUT → snapshot + resetLocal + login screen
    });
    each(el, '[data-sync="restore"]', "click", function () {
      var day = Number(this.getAttribute("data-day"));
      var list = snapsRead(), pick = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].day === day && (list[i].uid === session.user.id || list[i].uid === null)) pick = list[i];
      }
      if (!pick) return;
      /* Merged in rather than swapped in, so going back to an earlier day adds
         what that day had and takes nothing away — restoring can't become the
         next way to lose something. Stamped now so it survives the next pull. */
      var next = mergeStates(bridge.get(), pick.state);
      next._uid = session.user.id;
      next._updatedAt = Date.now();
      applyState(next);
      doPush(next);
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

  /* This device's own history of the account, listed so it can be put back by
     hand. The merge means it should never be needed — which is not the same as
     it not being worth having, and "I've lost everything" should always have a
     button rather than an explanation. */
  function snapOffer() {
    if (!session || !bridge) return "";
    var cur = bridge.get(), here = score(cur);
    var list = snapsRead().filter(function (s) {
      return (s.uid === session.user.id || s.uid === null) && score(s.state) > here;
    });
    if (!list.length) return "";
    return '<div class="acctbox" style="margin-top:14px">' +
      "Este aparelho guarda uma cópia do teu progresso por dia. Se falta alguma coisa, repõe uma — " +
      "juntam-se ao que já tens, não substituem." +
      '<span lang="en"><br>This device keeps one copy of your progress per day. If something is ' +
      "missing, restore one — they merge with what you have rather than replacing it.</span>" +
      list.map(function (s) {
        return '<button class="btn block mt" data-sync="restore" data-day="' + s.day + '">' +
          esc(when(s.at)) + " · " + Object.keys(s.state.prog || {}).length + " cartões</button>";
      }).join("") + "</div>";
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
