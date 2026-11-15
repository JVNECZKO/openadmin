# Release signing

The live panel has a pinned Ed25519 release key:

- key id: `release-2026`
- public key (SPKI, base64):
  `MCowBQYDK2VwAyEAfIpTE/Fs0tXPuGhmfAESdNX3FDmK8EJxAAT8Njvm6vc=`

The matching private key is **not** in this repository and must stay offline
(`~/.openadmin-release-ed25519.pem`, mode 0600, on the operator workstation).
Every update manifest must include a `signature` over canonical JSON with the
`signature` field removed. The panel refuses unsigned or wrongly signed manifests
unless the explicit `OA_UPDATE_ALLOW_UNSIGNED=1` break-glass switch is set.

Rotation: add `kid=base64(SPKI)` to `OA_UPDATE_PUBLIC_KEY` or the
`update_public_key` setting, publish a new signed manifest, then remove the old key
only after the new release is installed and smoke-tested.
