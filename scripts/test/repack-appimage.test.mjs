// What apps/desktop/scripts/repack-appimage.sh does, run for real with a stand-in AppImage and a stand-in
// appimagetool, so that nothing is downloaded and nothing needs FUSE. The two stand-ins and the download are the
// only fakes: the script's own find, delete, pack and look-inside steps all run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const script = fileURLToPath(new URL("../../apps/desktop/scripts/repack-appimage.sh", import.meta.url));
const skip = process.platform !== "linux" && "the script is run on the Linux runner, with GNU realpath, find and sha256sum";
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const EXTRACTS = `#!/bin/sh
# A stand-in AppImage: --appimage-extract writes the tree it holds into ./squashfs-root, as the real one does.
case "$1" in
  --appimage-extract)
    mkdir -p squashfs-root/usr/lib/x86_64-linux-gnu squashfs-root/usr/lib/deeper/still squashfs-root/usr/bin
    : > squashfs-root/usr/lib/x86_64-linux-gnu/libwayland-client.so.0.20.0
    ln -s libwayland-client.so.0.20.0 squashfs-root/usr/lib/x86_64-linux-gnu/libwayland-client.so.0
    : > squashfs-root/usr/lib/deeper/still/libwayland-server.so.0
    : > squashfs-root/usr/lib/libwaylandish.so
    : > squashfs-root/usr/lib/libother.so.1
    # The packages' documentation directories, which the bundler copies in beside the libraries (the real image
    # holds usr/share/doc/libwayland-server0 and its siblings); the directories are named like the libraries.
    mkdir -p squashfs-root/usr/share/doc/libwayland-server0 squashfs-root/usr/share/doc/libwaylandish
    echo "copyright" > squashfs-root/usr/share/doc/libwayland-server0/copyright
    : > squashfs-root/usr/share/doc/libwayland-server0/changelog.Debian.gz
    echo "copyright" > squashfs-root/usr/share/doc/libwaylandish/copyright
    echo "the app" > squashfs-root/usr/bin/ancilla
    ;;
esac
`;

// A stand-in appimagetool: notes what it was asked to pack, optionally slips a libwayland back in, and writes an
// "AppImage" that extracts that same tree.
const TOOL = `#!/bin/sh
tree="$2"; out="$3"
[ -n "$FAKE_PUT_BACK" ] && : > "$tree/usr/lib/$FAKE_PUT_BACK"
( cd "$tree" && find . | sort ) > "$FAKE_LOG"
printf 'arch=%s\\n' "$ARCH" >> "$FAKE_LOG"
mkdir -p "$FAKE_STORE" && cp -R "$tree/." "$FAKE_STORE/"
cat > "$out" <<EOF
#!/bin/sh
case "\\$1" in --appimage-extract) mkdir -p squashfs-root && cp -R "$FAKE_STORE/." squashfs-root/ ;; esac
EOF
chmod +x "$out"
`;

// What the download of the tool is replaced with: curl copies the stand-in where the script asked for the tool, and
// sha256sum --check says yes or no as the test decides, because the stand-in cannot have the pinned checksum.
const CURL = `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; esac; shift; done
echo "download" >> "$FAKE_LOG.calls"
cp "$FAKE_TOOL" "$out"
`;
const SHA256SUM = `#!/bin/sh
if [ "$1" = "--check" ]; then
  cat > "$FAKE_LOG.checked"
  [ -z "$FAKE_BAD_CHECKSUM" ]
  exit $?
fi
exec /usr/bin/sha256sum "$@"
`;

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ancilla repack "));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const put = (path, text) => {
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  };
  put(join(bin, "curl"), CURL);
  put(join(bin, "sha256sum"), SHA256SUM);
  put(join(dir, "tool"), TOOL);
  mkdirSync(join(dir, "in"));
  put(join(dir, "in", "Ancilla_0.20.4_amd64.AppImage"), EXTRACTS);
  const log = join(dir, "pack.log");
  // Where the script's own mktemp -d puts its working directory, so that a test can see that it was cleaned up.
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  const run = ({ cwd = dir, args = [join(dir, "in", "Ancilla_0.20.4_amd64.AppImage"), join(dir, "out")], env = {} } = {}) => {
    const done = spawnSync("bash", [script, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch, FAKE_TOOL: join(dir, "tool"), FAKE_LOG: log, FAKE_STORE: join(dir, "store"), ...env },
    });
    return { code: done.status, out: done.stdout, err: done.stderr };
  };
  const packed = () => readFileSync(log, "utf8");
  return { dir, run, packed, log, scratch };
}

describe("the repack script", { skip }, () => {
  test("removes every libwayland, files, links, nested ones and the packages' doc directories, keeps the rest, and packs what is left", () => {
    const { dir, run, packed } = rig();
    const result = run();
    assert.equal(result.code, 0, result.err);
    const listing = packed();
    assert.doesNotMatch(listing, /libwayland-/);
    assert.match(listing, /libwaylandish\.so/, "only libwayland-* goes, not a library that merely starts alike");
    assert.match(listing, /\.\/usr\/share\/doc\/libwaylandish\/copyright/, "nor a doc directory that merely starts alike");
    assert.match(listing, /\.\/usr\/lib\/libother\.so\.1/);
    assert.match(listing, /\.\/usr\/bin\/ancilla/);
    assert.match(listing, /arch=x86_64/);
    for (const removed of ["libwayland-client.so.0.20.0", "libwayland-client.so.0", "libwayland-server.so.0", "usr/share/doc/libwayland-server0"]) {
      assert.match(result.out, new RegExp(removed.replace(/\./g, "\\.")), `it says it removed ${removed}`);
    }
    const out = join(dir, "out", "Ancilla_0.20.4_amd64.AppImage");
    assert.ok(statSync(out).mode & 0o111, "the result can be run");
    assert.match(result.out, /Repacked Ancilla_0\.20\.4_amd64\.AppImage without libwayland/);
  });

  test("fails, naming the annotation, when the packed image holds a libwayland after all", () => {
    const { run } = rig();
    const result = run({ env: { FAKE_PUT_BACK: "libwayland-egl.so.1" } });
    assert.equal(result.code, 1, result.out);
    assert.match(result.err, /::error title=Wayland libraries are still in the AppImage::.*libwayland-egl\.so\.1/);
    assert.doesNotMatch(result.out, /Repacked /);
  });

  test("does not download or run a tool whose checksum is not the pinned one", () => {
    const { dir, run, log } = rig();
    const result = run({ env: { FAKE_BAD_CHECKSUM: "1" } });
    assert.notEqual(result.code, 0);
    assert.ok(!existsSync(log), "the tool never ran");
    assert.ok(!existsSync(join(dir, "out", "Ancilla_0.20.4_amd64.AppImage")));
    const checked = readFileSync(`${log}.checked`, "utf8");
    assert.match(checked, /^ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0 {2}appimagetool\n$/);
  });

  test("takes relative paths, a directory with a space in it, and an output directory that is the input's own", () => {
    const { dir, run, packed } = rig();
    const result = run({ args: ["in/Ancilla_0.20.4_amd64.AppImage", "in"] });
    assert.equal(result.code, 0, result.err);
    assert.doesNotMatch(packed(), /libwayland-/);
    assert.ok(existsSync(join(dir, "in", "Ancilla_0.20.4_amd64.AppImage")));
    assert.match(readFileSync(join(dir, "in", "Ancilla_0.20.4_amd64.AppImage"), "utf8"), /cp -R/, "the file there is the repacked one");
  });

  test("replaces what an earlier run left, including a signature that no longer fits", () => {
    const { dir, run } = rig();
    const outDir = join(dir, "out");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "Ancilla_0.20.4_amd64.AppImage"), "old");
    writeFileSync(join(outDir, "Ancilla_0.20.4_amd64.AppImage.sig"), "old signature");
    assert.equal(run().code, 0);
    assert.ok(!existsSync(join(outDir, "Ancilla_0.20.4_amd64.AppImage.sig")));
    assert.notEqual(readFileSync(join(outDir, "Ancilla_0.20.4_amd64.AppImage"), "utf8"), "old");
  });

  test("asks for its two arguments", () => {
    const { dir, run } = rig();
    const none = run({ args: [] });
    assert.notEqual(none.code, 0);
    assert.match(none.err, /Pass the AppImage the bundler built/);
    const one = run({ args: [join(dir, "in", "Ancilla_0.20.4_amd64.AppImage")] });
    assert.notEqual(one.code, 0);
    assert.match(one.err, /Pass the directory the repacked AppImage goes in/);
    const missing = run({ args: [join(dir, "in", "nothing-here.AppImage"), join(dir, "out")] });
    assert.notEqual(missing.code, 0);
  });

  test("leaves no working directory behind, after a pass or a failure", () => {
    const { run, scratch } = rig();
    assert.equal(run().code, 0);
    assert.deepEqual(readdirSync(scratch), []);
    assert.equal(run({ env: { FAKE_PUT_BACK: "libwayland-egl.so.1" } }).code, 1);
    assert.deepEqual(readdirSync(scratch), []);
  });
});
