// A signature written by the real Tauri CLI (`tauri signer sign`, version 2.11.4) with a throwaway key made by
// `tauri signer generate`. The key was never used for anything else and its private half was not kept, so this
// is safe to commit. It is kept as text in a module, not as separate files, so that no checkout can change the
// payload's line endings and break the signature.
export const PAYLOAD = Buffer.from(
  "Ancilla updater signature fixture\nThis file is signed with a throwaway key by the real tauri CLI.\n",
  "utf8",
);

/** The key as tauri.conf.json would hold it. */
export const PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdFRThFNjYzMEQ4OTNDNUIKUldSYlBJa05ZK2JvZmhUWFlISk5Td3RxWkIvbDlwYkk3V2NuV0dFTVltSGljN2RLV1VVcG1qcjEK";

/** The .sig file the CLI wrote for PAYLOAD: base64 of a four-line text, algorithm 'ED'. */
export const SIGNATURE =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSYlBJa05ZK2JvZmdmM1JTa0VPZFpWbERQWXlYUGxjUkhTOFNjeTl4Q2J1eUxRMXViOG1pYkdiT0pZQURROStiWjd3ZFdwSEV0NDIwRVltK3lNbFpNOW9CamRYektHR0FJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxOTA5ODIwCWZpbGU6cGF5bG9hZC50eHQKUFNFQzd1bnRPbHhidGtNY2VYVkhpa2dPY2wrb2Y4MktiYkptbFdoTlNPRC9RekFBUW44b0s0S0U4WXRscjczdkU5R1h1UFVTSjJGaEc4QWsrempuQ2c9PQo=";

/** The public key the real 0.20.3 release was signed for, as plugins.updater.pubkey held it then. */
export const RELEASE_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc0NEJBNzA3OThCNTRDN0IKUldSN1RMV1lCNmRMZER4SDViQTNKVXlQYlpmR3l0RE9MMy9LWjU5c3ZYT0J4ZVlhdU1IZGNXNDkK";
