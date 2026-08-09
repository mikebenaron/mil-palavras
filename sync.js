/* ============================================================
   Mil Palavras — cross-device sync (Supabase, offline-first)

   The app itself is unchanged and keeps working entirely from
   localStorage. This layer sits on top:
     • pull() on launch / sign-in  — fetch the cloud copy and,
       if it's newer, apply it locally.
     • push()  after each local save — send the new state up
       (debounced), when online and signed in.

   Merge is last-write-wins by S._updatedAt (stamped on every
   local save). Correct for one person using their devices one
   at a time; the only lossy case is editing two devices while
   BOTH are offline, then reconnecting.
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

  var bridge = null;     // { get, set, persist, save, render, freshState }
  var session = null;
  var applying = false;  // true while writing a pulled state, so we don't echo it back up
  var pushTimer = null;
  var status = "";

  // Public API used by the app (index.html).
  window.MilSync = {
    attach: function (b) { bridge = b; boot(); },
    push: function (state) { if (client && session && !applying) schedulePush(state); },
    mount: renderMount,
    isConfigured: function () { return configured; }
  };

  function boot() {
    if (!client) return; // not wired to a project yet — UI will say so
    client.auth.getSession().then(function (r) {
      session = (r && r.data && r.data.session) || null;
      renderMount();
      if (session) pull();
    });
    client.auth.onAuthStateChange(function (_evt, s) {
      var prev = session;
      session = s || null;
      renderMount();
      var changed = (!prev && session) || (prev && session && prev.user.id !== session.user.id);
      if (session && changed) pull();
    });
  }

  function tsOf(x) { return (x && x._updatedAt) || 0; }

  function pull() {
    if (!client || !session) return;
    setStatus("Syncing…");
    client.from("progress")
      .select("data")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(function (res) {
        if (res.error) { setStatus("Sync error"); return; }
        var remote = res.data ? res.data.data : null;
        var local = bridge.get();
        var localNewer = !remote || tsOf(local) > tsOf(remote);

        if (remote && tsOf(remote) > tsOf(local)) {
          applying = true;
          bridge.set(remote);
          bridge.persist();   // raw localStorage write — no timestamp bump, no push
          applying = false;
          bridge.render();
        }

        if (localNewer) doPush(bridge.get());
        else setStatus("Synced · " + clock());
      })
      .catch(function () { setStatus("Offline"); });
  }

  function schedulePush(state) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { doPush(state); }, 1200);
  }

  function doPush(state) {
    if (!client || !session) return;
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

  /* ----------------------------- UI ----------------------------- */

  function renderMount() {
    var el = document.getElementById("syncMount");
    if (!el) return;

    if (!client) {
      el.innerHTML = hint("Sync isn't switched on in this build yet.");
      return;
    }

    if (session) {
      el.innerHTML =
        hint("Signed in as <b>" + esc(session.user.email || "your account") +
             "</b>. Your progress syncs to every device you sign in on.") +
        '<div class="foot" style="text-align:left" id="syncStatus">' + esc(status || "Synced") + '</div>' +
        '<div class="stack mt">' +
          '<button class="btn quiet" data-sync="pull">Sync now</button>' +
          '<button class="btn quiet" data-sync="signout">Sign out</button>' +
        '</div>';
      el.querySelector('[data-sync="pull"]').addEventListener("click", pull);
      el.querySelector('[data-sync="signout"]').addEventListener("click", function () {
        client.auth.signOut().then(function () { session = null; setStatus(""); renderMount(); });
      });
    } else {
      el.innerHTML =
        hint("Sign in with your email to sync across devices. We email you a one-tap link — no password to remember.") +
        '<div class="field" style="margin-top:6px">' +
          '<input id="syncEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" ' +
          'style="width:100%;padding:11px 12px;border:1px solid rgba(16,36,63,.18);border-radius:10px;background:var(--tile);font-size:16px">' +
        '</div>' +
        '<div class="stack mt"><button class="btn" data-sync="signin">Email me a sign-in link</button></div>' +
        '<div class="foot" style="text-align:left" id="syncStatus">' + esc(status || "") + '</div>';
      el.querySelector('[data-sync="signin"]').addEventListener("click", function () {
        var email = ((el.querySelector("#syncEmail") || {}).value || "").trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setStatus("Enter a valid email address"); return; }
        setStatus("Sending link…");
        client.auth.signInWithOtp({
          email: email,
          options: { emailRedirectTo: location.origin + location.pathname }
        }).then(function (res) {
          setStatus(res.error ? ("Error: " + res.error.message) : "Check your email for the sign-in link.");
        }).catch(function () { setStatus("Couldn't send the link — try again."); });
      });
    }
  }

  function setStatus(s) {
    status = s;
    var e = document.getElementById("syncStatus");
    if (e) e.textContent = s;
  }

  function hint(html) {
    return '<div class="hint" style="font-size:11.5px;color:var(--slate)">' + html + "</div>";
  }
  function clock() {
    var d = new Date();
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
})();
