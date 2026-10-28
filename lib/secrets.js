'use strict';

// 🔒 One rule for what the chat hub never takes in or hands out: dotfiles and dot folders
// (.env, .ssh, .git…), key and keystore files, and anything named like a credential or a
// password. Uploads use it now; reading a member's folder (phase 2) must call the same
// function, with the path relative to that folder, so the two can never drift apart.

const KEY_NAME = /(\.(pem|key|p12|pfx|kdbx|keystore|jks|ppk|asc|gpg)$)|(^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$)|credential|secret|password|passwd/i;

// rel: a file name or a path relative to the folder being read (either slash).
function isSecretPath(rel) {
  return String(rel || '').split(/[\\/]+/).filter(Boolean).some((part) => part.startsWith('.') || KEY_NAME.test(part));
}

module.exports = { isSecretPath };
