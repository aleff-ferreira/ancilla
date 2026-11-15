/**
 * What the voice downloads, and from where. Everything is pinned: the exact address, the exact size and a checksum, so
 * that a download that is not what was meant (a broken connection, a substituted file) is refused, not run. The models
 * are fetched from their publishers when the person asks for them, and never shipped with Ancilla; each carries its own
 * licence, shown before anything is downloaded.
 */

export type ArchiveKind = "npm" | "tar.bz2" | "file";

export interface PackItemSpec {
  id: string;
  label: string;
  kind: ArchiveKind;
  url: string;
  /** The size of the download, as the publisher serves it. */
  bytes: number;
  /** SHA-256 of the download, as hex. */
  sha256?: string;
  /** SHA-512 of the download, as the npm registry writes it ("sha512-" and base64). */
  integrity?: string;
  license: string;
  licenseUrl: string;
  /** Left out when the person does not want it. */
  optional: boolean;
  /** For an npm package, its name (where it is unpacked to); for an archive, the folder that appears when it is unpacked; for a file, its name. */
  name: string;
}

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const NPM = "https://registry.npmjs.org";

export const SHERPA_VERSION = "2.0.1";

/** The npm packages that carry the native code for one platform, with the registry's own checksum of each. */
const RUNTIME_PACKAGES: Record<string, { bytes: number; integrity: string }> = {
  "sherpa-onnx-node": { bytes: 12_709, integrity: "sha512-1PSACfQgPXAD7ExwCv1QW09EXTjcNlpZKBqDY+jxSdIzlyOSq0M13SILBoUQUfeJqiTTXnqp6Ha9jjMUQ6efXg==" },
  "sherpa-onnx-linux-x64": { bytes: 11_005_484, integrity: "sha512-w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw==" },
  "sherpa-onnx-linux-arm64": { bytes: 13_822_449, integrity: "sha512-5CJvLjFYIg23oELCsT7l07fMLT3PdquZ3tqh7KZK3Pzi+c2YiPKRe1DDUxoNdtCaw3ZiS4aQSQPBblB9JStuDA==" },
  "sherpa-onnx-darwin-x64": { bytes: 11_167_483, integrity: "sha512-SBnHa3LDOSI/5/rpBHGxKQDFq+yIdxowYY0InLzfojTUx+yGgqu7cYBrRxjzvHOiOKi0O4rmlFVZboyhIqpDgA==" },
  "sherpa-onnx-darwin-arm64": { bytes: 10_013_200, integrity: "sha512-agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ==" },
  "sherpa-onnx-win-x64": { bytes: 8_779_375, integrity: "sha512-7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw==" },
};

/** The package that holds this platform's native code, or null where there is none to offer. */
export function platformPackage(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  if (!os) return null;
  const name = `sherpa-onnx-${os}-${arch}`;
  return RUNTIME_PACKAGES[name] ? name : null;
}

function npmItem(name: string, label: string): PackItemSpec {
  const known = RUNTIME_PACKAGES[name] as { bytes: number; integrity: string };
  return {
    id: name,
    label,
    kind: "npm",
    url: `${NPM}/${name}/-/${name}-${SHERPA_VERSION}.tgz`,
    bytes: known.bytes,
    integrity: known.integrity,
    license: "Apache-2.0",
    licenseUrl: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
    optional: false,
    name,
  };
}

const MODELS: PackItemSpec[] = [
  {
    id: "silero-vad",
    label: "Speech detector (Silero VAD)",
    kind: "file",
    url: `${RELEASES}/asr-models/silero_vad.onnx`,
    bytes: 643_854,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    license: "MIT",
    licenseUrl: "https://github.com/snakers4/silero-vad/blob/master/LICENSE",
    optional: false,
    name: "silero_vad.onnx",
  },
  {
    id: "nemotron-streaming",
    label: "Speech recogniser, live (NVIDIA Nemotron 3.5 streaming)",
    kind: "tar.bz2",
    url: `${RELEASES}/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11.tar.bz2`,
    bytes: 475_273_363,
    sha256: "a81909a1780d84cff16d73c15e13e67d9d81d8839faf14870d507d8499f7a61a",
    license: "NVIDIA Open Model License",
    licenseUrl: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
    optional: false,
    name: "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11",
  },
  {
    id: "supertonic-tts",
    label: "Voice (Supertonic 3)",
    kind: "tar.bz2",
    url: `${RELEASES}/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`,
    bytes: 128_774_318,
    sha256: "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427",
    license: "OpenRAIL-M",
    licenseUrl: "https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE",
    optional: false,
    name: "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
  },
  {
    id: "parakeet-refine",
    label: "Accuracy booster (NVIDIA Parakeet TDT v3)",
    kind: "tar.bz2",
    url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    bytes: 487_211_443,
    sha256: "1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9",
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    optional: true,
    name: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  },
];

/** Everything to download for a platform, in the order it is fetched. Null when there is no native code for this platform. */
export function packItems(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PackItemSpec[] | null {
  const native = platformPackage(platform, arch);
  if (!native) return null;
  return [npmItem("sherpa-onnx-node", "Voice engine (sherpa-onnx)"), npmItem(native, `Voice engine, native code for ${platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux"} ${arch}`), ...MODELS];
}
