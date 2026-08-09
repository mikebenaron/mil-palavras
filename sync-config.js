/* Supabase connection for cross-device sync.
   Both values are safe to ship in the client: the publishable key is designed
   to be public, and row-level security on the server is what protects your data.
   NEVER put the sb_secret_... key here — it bypasses security. */
window.MIL_SYNC_CONFIG = {
  url: "https://vawoprxbznheyatbignh.supabase.co",
  anonKey: "sb_publishable_rlWSCYhkSf5nTQ-V9CnUog_YvayRQ-n"
};
