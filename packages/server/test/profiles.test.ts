import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createProfileManager,
  createProfilesManager,
  parseLoginOutput,
  ProfileError,
} from "../src/profiles/index.js";

describe("Profiles subsystem", () => {
  it("creates, retrieves, renames, touches, lists, and removes profiles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-profiles-crud-"));
    try {
      const manager = createProfilesManager({ home: tempDir, platform: "linux" });

      // Initially empty
      const initialList = await manager.listProfiles();
      assert.deepEqual(initialList, []);

      // Create "work" profile
      const work = await manager.createProfile("work", { name: "Work Profile" });
      assert.equal(work.id, "work");
      assert.equal(work.name, "Work Profile");
      assert.ok(work.createdAt);
      assert.equal(work.lastUsedAt, null);
      assert.equal(work.roots.config, join(manager.profilesDir, "work", "config"));
      assert.equal(work.roots.data, join(manager.profilesDir, "work", "data"));

      // Check directory permissions mode on posix
      if (process.platform !== "win32") {
        const configStat = await stat(work.roots.config);
        assert.equal(configStat.mode & 0o777, 0o700);
        const dataStat = await stat(work.roots.data);
        assert.equal(dataStat.mode & 0o777, 0o700);
      }

      // Retrieve profile
      const retrieved = await manager.getProfile("work");
      assert.equal(retrieved.id, "work");
      assert.equal(retrieved.name, "Work Profile");
      assert.equal(retrieved.roots.config, work.roots.config);

      // List profiles
      const listAfterCreate = await manager.listProfiles();
      assert.equal(listAfterCreate.length, 1);
      assert.equal(listAfterCreate[0]?.id, "work");

      // Rename profile
      const renamed = await manager.renameProfile("work", "Primary Client");
      assert.equal(renamed.name, "Primary Client");
      assert.equal((await manager.getProfile("work")).name, "Primary Client");

      // Touch profile
      await manager.touch("work");
      const touched = await manager.getProfile("work");
      assert.ok(touched.lastUsedAt);

      // Remove profile
      await manager.removeProfile("work");
      assert.deepEqual(await manager.listProfiles(), []);

      await assert.rejects(
        async () => manager.getProfile("work"),
        (err: unknown) => err instanceof ProfileError && err.code === "no_such_profile"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates profile slugs and prevents duplicate creation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-profiles-validation-"));
    try {
      const manager = createProfilesManager({ home: tempDir });

      // Valid slugs
      await manager.createProfile("valid-slug_123");
      const p = await manager.getProfile("valid-slug_123");
      assert.equal(p.id, "valid-slug_123");

      // Duplicate slug rejection (code: profile_exists)
      await assert.rejects(
        async () => manager.createProfile("valid-slug_123"),
        (err: unknown) => err instanceof ProfileError && err.code === "profile_exists"
      );

      // Invalid slug: spaces
      await assert.rejects(
        async () => manager.createProfile("Not Valid"),
        (err: unknown) => err instanceof ProfileError && err.code === "bad_profile_id"
      );

      // Invalid slug: uppercase
      await assert.rejects(
        async () => manager.createProfile("Work"),
        (err: unknown) => err instanceof ProfileError && err.code === "bad_profile_id"
      );

      // Invalid slug: path traversal
      await assert.rejects(
        async () => manager.createProfile("../evil"),
        (err: unknown) => err instanceof ProfileError && err.code === "bad_profile_id"
      );

      // Invalid slug: empty string
      await assert.rejects(
        async () => manager.createProfile(""),
        (err: unknown) => err instanceof ProfileError && err.code === "bad_profile_id"
      );

      // Non-existent profile retrieval
      await assert.rejects(
        async () => manager.getProfile("ghost"),
        (err: unknown) => err instanceof ProfileError && err.code === "no_such_profile"
      );

      // Non-existent profile removal
      await assert.rejects(
        async () => manager.removeProfile("ghost"),
        (err: unknown) => err instanceof ProfileError && err.code === "no_such_profile"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("seeds settings and trust from default without leaking auth.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-profiles-seed-"));
    try {
      const defaultMuseDir = join(tempDir, ".config", "muse");
      await mkdir(defaultMuseDir, { recursive: true });
      await writeFile(join(defaultMuseDir, "settings.json"), JSON.stringify({ theme: "dark" }));
      await writeFile(join(defaultMuseDir, "trust.json"), JSON.stringify({ trusted: true }));
      await writeFile(join(defaultMuseDir, "auth.json"), JSON.stringify({ access_token: "secret-token" }));

      const manager = createProfilesManager({
        home: tempDir,
        env: { XDG_CONFIG_HOME: join(tempDir, ".config") },
      });

      const profile = await manager.createProfile("seeded", { seedFromDefault: true });

      // settings.json and trust.json should be copied
      const seededSettings = JSON.parse(await readFile(join(profile.roots.config, "muse", "settings.json"), "utf-8"));
      assert.deepEqual(seededSettings, { theme: "dark" });

      const seededTrust = JSON.parse(await readFile(join(profile.roots.config, "muse", "trust.json"), "utf-8"));
      assert.deepEqual(seededTrust, { trusted: true });

      // auth.json MUST NEVER BE COPIED
      await assert.rejects(
        async () => readFile(join(profile.roots.config, "muse", "auth.json"), "utf-8"),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("computes environment variables per platform and generates login commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-profiles-env-"));
    try {
      const linuxManager = createProfilesManager({ home: tempDir, platform: "linux", musePath: "/usr/bin/muse" });
      const macManager = createProfilesManager({ home: tempDir, platform: "darwin", musePath: "muse" });

      const profile = await linuxManager.createProfile("client");

      const linuxEnv = linuxManager.envFor(profile);
      assert.equal(linuxEnv["XDG_CONFIG_HOME"], profile.roots.config);
      assert.equal(linuxEnv["XDG_DATA_HOME"], profile.roots.data);
      assert.equal(linuxEnv["TBH_CREDENTIAL_BACKEND"], undefined);

      const macEnv = macManager.envFor(profile);
      assert.equal(macEnv["XDG_CONFIG_HOME"], profile.roots.config);
      assert.equal(macEnv["XDG_DATA_HOME"], profile.roots.data);
      assert.equal(macEnv["TBH_CREDENTIAL_BACKEND"], "file");

      const cmd = linuxManager.loginCommand(profile);
      assert.equal(cmd.command, "/usr/bin/muse");
      assert.deepEqual(cmd.args, ["login"]);
      assert.equal(cmd.env["XDG_CONFIG_HOME"], profile.roots.config);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts non-secret identity safely and never exposes access tokens", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-profiles-identity-"));
    try {
      const manager = createProfilesManager({ home: tempDir });
      const profile = await manager.createProfile("account");

      // No auth file yet
      const noAuth = await manager.identityOf(profile);
      assert.deepEqual(noAuth, { hasLogin: false, email: null });

      // Write auth file with OAuth metadata and secrets
      const authDir = join(profile.roots.config, "muse");
      await mkdir(authDir, { recursive: true });
      await writeFile(
        join(authDir, "auth.json"),
        JSON.stringify({
          providers: {
            meta: {
              mechanism: "oauth",
              access_token: "super-secret-oauth-token-12345",
              refresh_token: "super-secret-refresh-token",
              user_email: "dev@example.test",
              user_name: "Developer",
            },
          },
        })
      );

      const identity = await manager.identityOf(profile);
      assert.equal(identity.hasLogin, true);
      assert.equal(identity.email, "dev@example.test");
      assert.equal(identity.name, "Developer");
      // Verify token isolation
      assert.equal((identity as unknown as Record<string, unknown>)["access_token"], undefined);
      assert.equal((identity as unknown as Record<string, unknown>)["refresh_token"], undefined);

      // Malformed auth.json returns safe false
      await writeFile(join(authDir, "auth.json"), "not json");
      const malformed = await manager.identityOf(profile);
      assert.deepEqual(malformed, { hasLogin: false, email: null });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports doctor findings when META_API_KEY is present in environment", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-profiles-doctor-"));
    try {
      const managerWithKey = createProfilesManager({
        home: tempDir,
        env: { META_API_KEY: "secret-key" },
      });
      const findingsWithKey = await managerWithKey.doctor();
      assert.ok(findingsWithKey.some((f) => f.code === "meta_api_key_inherited"));

      const managerWithoutKey = createProfilesManager({
        home: tempDir,
        env: {},
      });
      const findingsWithoutKey = await managerWithoutKey.doctor();
      assert.ok(!findingsWithoutKey.some((f) => f.code === "meta_api_key_inherited"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses login output with ANSI codes and query parameters", () => {
    // Standard OAuth device link with user_code
    const output1 = "\x1b[32mOpen https://auth.meta.com/device?user_code=ABCD-1234 in your browser.\x1b[0m";
    const res1 = parseLoginOutput(output1);
    assert.equal(res1.url, "https://auth.meta.com/device?user_code=ABCD-1234");
    assert.equal(res1.code, "ABCD-1234");

    // OAuth link with code in separate text
    const output2 = "Visit https://meta.com/device and enter code: WXYZ-5678.";
    const res2 = parseLoginOutput(output2);
    assert.equal(res2.url, "https://meta.com/device");
    assert.equal(res2.code, "WXYZ-5678");

    // Insecure HTTP link is rejected
    const output3 = "Visit http://insecure.test/device?code=ABCD";
    const res3 = parseLoginOutput(output3);
    assert.deepEqual(res3, { url: null, code: null });

    // No URL present
    const output4 = "Waiting for authorization...";
    const res4 = parseLoginOutput(output4);
    assert.deepEqual(res4, { url: null, code: null });
  });

  it("supports object spread mocking without breaking unbound this", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-profiles-spread-"));
    try {
      const original = createProfilesManager({ home: tempDir });
      await original.createProfile("test-profile");

      // Object spread as used across server.test.ts
      const cloned = {
        ...original,
        identityOf: async (_profile?: unknown) => ({ hasLogin: true, email: "mock@example.test", name: "Mock User" }),
      };

      // Cloned manager must still retain all other methods as callable own properties
      const list = await cloned.listProfiles();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, "test-profile");

      const profile = await cloned.getProfile("test-profile");
      assert.equal(profile.id, "test-profile");

      const id = await cloned.identityOf(profile);
      assert.equal(id.email, "mock@example.test");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves profilesDir to ~/.ancilla/profiles given home and prevents home directory pollution", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "ancilla-home-pollution-"));
    try {
      const manager = createProfilesManager({ home: tempHome, platform: "linux" });

      // 1. Path resolution verification
      const expectedProfilesDir = join(tempHome, ".ancilla", "profiles");
      assert.equal(manager.profilesDir, expectedProfilesDir);

      // 2. Run doctor()
      const findings = await manager.doctor();
      assert.ok(Array.isArray(findings));

      // Check that .ancilla/profiles was created by doctor
      const ancillaProfilesStat = await stat(expectedProfilesDir);
      assert.ok(ancillaProfilesStat.isDirectory());

      // Crucial regression check: ~/profiles must NOT exist!
      const pollutedDir = join(tempHome, "profiles");
      await assert.rejects(
        async () => stat(pollutedDir),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
        "home/profiles directory must not be created or polluted"
      );

      // 3. Run manager operations (createProfile, touch, etc.)
      const profile = await manager.createProfile("dev-account", { name: "Developer Account" });
      assert.equal(profile.roots.config, join(expectedProfilesDir, "dev-account", "config"));
      assert.equal(profile.roots.data, join(expectedProfilesDir, "dev-account", "data"));

      // ~/profiles must STILL not exist!
      await assert.rejects(
        async () => stat(pollutedDir),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
        "home/profiles directory must remain non-existent after manager operations"
      );

      // Verify profile index exists inside .ancilla/profiles
      const indexStat = await stat(join(expectedProfilesDir, "profiles.json"));
      assert.ok(indexStat.isFile());
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("correctly resolves profilesDir across all options and environment precedence levels", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "ancilla-profiles-prec-"));
    try {
      const customProfilesDir = join(baseDir, "explicit", "custom", "profiles");
      const customHome = join(baseDir, "custom", "home");
      const ancillaHome = join(baseDir, "custom", "home", ".ancilla");
      const directProfilesHome = join(baseDir, "custom", "home", "profiles");

      // 1. Explicit profilesDir takes top precedence over home and all env vars
      const m1 = createProfilesManager({
        profilesDir: customProfilesDir,
        home: customHome,
        env: {
          ANCILLA_PROFILES_DIR: join(baseDir, "env", "profiles"),
          ANCILLA_PROFILES_HOME: join(baseDir, "env", "profiles_home"),
          ANCILLA_HOME: join(baseDir, "env", "ancilla_home"),
        },
      });
      assert.equal(m1.profilesDir, customProfilesDir);

      // 2. ANCILLA_PROFILES_DIR env var takes precedence when profilesDir option is not set
      const m2 = createProfilesManager({
        home: customHome,
        env: {
          ANCILLA_PROFILES_DIR: join(baseDir, "env", "profiles", "override"),
          ANCILLA_PROFILES_HOME: join(baseDir, "env", "profiles_home"),
          ANCILLA_HOME: join(baseDir, "env", "ancilla_home"),
        },
      });
      assert.equal(m2.profilesDir, join(baseDir, "env", "profiles", "override"));

      // 3. options.home resolves to <home>/.ancilla/profiles
      const m3 = createProfilesManager({
        home: customHome,
        env: {
          ANCILLA_PROFILES_HOME: join(baseDir, "env", "profiles_home"),
          ANCILLA_HOME: join(baseDir, "env", "ancilla_home"),
        },
      });
      assert.equal(m3.profilesDir, join(customHome, ".ancilla", "profiles"));

      // 4. options.home already ending in .ancilla resolves to <home>/profiles
      const m4 = createProfilesManager({
        home: ancillaHome,
        env: {},
      });
      assert.equal(m4.profilesDir, join(ancillaHome, "profiles"));

      // 5. options.home already ending in profiles resolves directly
      const m5 = createProfilesManager({
        home: directProfilesHome,
        env: {},
      });
      assert.equal(m5.profilesDir, directProfilesHome);

      // 6. ANCILLA_PROFILES_HOME env var when home is not set
      const m6 = createProfilesManager({
        env: {
          ANCILLA_PROFILES_HOME: join(baseDir, "env", "profiles_home"),
          ANCILLA_HOME: join(baseDir, "env", "ancilla_home"),
        },
      });
      assert.equal(m6.profilesDir, join(baseDir, "env", "profiles_home", "profiles"));

      // 7. ANCILLA_HOME env var when neither home nor profiles_home is set
      const m7 = createProfilesManager({
        env: {
          ANCILLA_HOME: join(baseDir, "env", "ancilla_home"),
        },
      });
      assert.equal(m7.profilesDir, join(baseDir, "env", "ancilla_home", "profiles"));

      // 8. Fallback to ~/.ancilla/profiles when no options or env vars set
      const m8 = createProfilesManager({
        env: {},
      });
      assert.equal(m8.profilesDir, join(homedir(), ".ancilla", "profiles"));
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("strictly requires non-empty mechanism string for hasLogin: true", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-identity-mech-"));
    try {
      const manager = createProfilesManager({ home: tempDir });
      const profile = await manager.createProfile("test-account");
      const authDir = join(profile.roots.config, "muse");
      await mkdir(authDir, { recursive: true });

      const writeAuth = async (data: unknown) => {
        await writeFile(join(authDir, "auth.json"), JSON.stringify(data));
      };

      // 1. Non-empty string mechanism -> hasLogin: true
      await writeAuth({ providers: { meta: { mechanism: "oauth", user_email: "user@example.test" } } });
      let id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, true);
      assert.equal(id.email, "user@example.test");

      await writeAuth({ providers: { meta: { mechanism: "api_key", user_email: "apikey@example.test" } } });
      id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, true);
      assert.equal(id.email, "apikey@example.test");

      await writeAuth({ providers: { meta: { mechanism: "custom_mech" } } });
      id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, true);
      assert.equal(id.email, null);

      // 2. Missing mechanism (even if user_email or access_token are present) -> hasLogin: false
      await writeAuth({
        providers: {
          meta: {
            user_email: "person@example.test",
            access_token: "secret-token",
          },
        },
      });
      id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, false);
      assert.equal(id.email, null);

      // 3. Empty string mechanism -> hasLogin: false
      await writeAuth({
        providers: {
          meta: {
            mechanism: "",
            user_email: "person@example.test",
          },
        },
      });
      id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, false);
      assert.equal(id.email, null);

      // 4. Whitespace-only mechanism -> hasLogin: false
      await writeAuth({
        providers: {
          meta: {
            mechanism: "   ",
            user_email: "person@example.test",
          },
        },
      });
      id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, false);
      assert.equal(id.email, null);

      // 5. Non-string mechanism (number, boolean, object) -> hasLogin: false
      await writeAuth({
        providers: {
          meta: {
            mechanism: 1,
            user_email: "person@example.test",
          },
        },
      });
      id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, false);
      assert.equal(id.email, null);

      await writeAuth({
        providers: {
          meta: {
            mechanism: true,
            user_email: "person@example.test",
          },
        },
      });
      id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, false);
      assert.equal(id.email, null);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves identity name following user_full_name -> user_name -> user_email -> fallback priority", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-identity-name-"));
    try {
      const manager = createProfilesManager({ home: tempDir });
      const profile = await manager.createProfile("test-account");
      const authDir = join(profile.roots.config, "muse");
      await mkdir(authDir, { recursive: true });

      const writeAuth = async (meta: Record<string, unknown>) => {
        await writeFile(
          join(authDir, "auth.json"),
          JSON.stringify({ providers: { meta: { mechanism: "oauth", ...meta } } })
        );
      };

      // 1. user_full_name has highest priority
      await writeAuth({
        user_full_name: "Alice Allison",
        user_name: "alice_a",
        user_email: "alice@example.test",
      });
      let id = await manager.identityOf(profile);
      assert.equal(id.hasLogin, true);
      assert.equal(id.name, "Alice Allison");
      assert.equal(id.email, "alice@example.test");

      // 2. user_full_name missing -> falls back to user_name
      await writeAuth({
        user_name: "bob_b",
        user_email: "bob@example.test",
      });
      id = await manager.identityOf(profile);
      assert.equal(id.name, "bob_b");
      assert.equal(id.email, "bob@example.test");

      // 3. user_full_name is empty/whitespace -> falls back to user_name
      await writeAuth({
        user_full_name: "   ",
        user_name: "charlie_c",
        user_email: "charlie@example.test",
      });
      id = await manager.identityOf(profile);
      assert.equal(id.name, "charlie_c");

      // 4. user_full_name and user_name missing -> falls back to user_email
      await writeAuth({
        user_email: "david@example.test",
      });
      id = await manager.identityOf(profile);
      assert.equal(id.name, "david@example.test");
      assert.equal(id.email, "david@example.test");

      // 5. user_full_name and user_name are whitespace -> falls back to user_email
      await writeAuth({
        user_full_name: "   ",
        user_name: "",
        user_email: "eve@example.test",
      });
      id = await manager.identityOf(profile);
      assert.equal(id.name, "eve@example.test");

      // 6. No name or email provided -> name is null
      await writeAuth({});
      id = await manager.identityOf(profile);
      assert.equal(id.name, null);
      assert.equal(id.email, null);

      // 7. Control characters in names are stripped / rejected in favor of clean fallback
      await writeAuth({
        user_full_name: "Evil\x00Name",
        user_name: "GoodName",
        user_email: "good@example.test",
      });
      id = await manager.identityOf(profile);
      assert.equal(id.name, "GoodName");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exports createProfileManager alias identical to createProfilesManager", () => {
    assert.equal(typeof createProfileManager, "function");
    assert.equal(createProfileManager, createProfilesManager);
  });
});
