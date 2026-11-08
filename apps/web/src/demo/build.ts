/**
 * The `turn` scenario: one ordinary prompt that Muse works through in six planned steps, with the tool calls it
 * makes along the way. It is written as a table of moments so the page can play it live and a reload starts it
 * again. Everything here is made up; nothing ran. Only the demo uses it.
 */

export const BUILD_PROMPT =
  "Build the terrain scene in stages: procedural textures first, then water, vegetation, a performance pass and the README. Run the checks as you go.";

export const BUILD_STEPS: readonly { text: string; active: string }[] = [
  { text: "Set up the scene skeleton", active: "Setting up the scene skeleton" },
  { text: "Build stage 1: procedural textures + terrain/ridges/sky/camera/light", active: "Building stage 1: procedural textures + terrain/ridges/sky/camera/light" },
  { text: "Stage 2: water, shoreline and atmosphere", active: "Building stage 2: water, shoreline and atmosphere" },
  { text: "Stage 3: vegetation and props", active: "Building stage 3: vegetation and props" },
  { text: "Performance pass and render tests", active: "Running the performance pass and render tests" },
  { text: "Write the README", active: "Writing the README" },
];

/** When each step becomes the active one, in milliseconds into the turn. */
export const BUILD_STEP_AT: readonly number[] = [300, 13_500, 50_500, 85_000, 117_000, 141_000];

/** The turn ends this long after it starts, with the reply streaming just before. */
export const BUILD_END_AT = 154_000;

export interface BuildTool {
  /** Milliseconds into the turn that the call starts. */
  at: number;
  /** How long it runs. */
  ms: number;
  tool: "bash" | "read_file" | "write_file" | "edit_file" | "grep" | "list_directory";
  /** The command, path or pattern the call acts on. */
  subject: string;
  /** The call's own words for what it does, for a shell command. */
  note?: string;
  output?: string;
  /** The call ends failed, with this reason. */
  fail?: string;
}

function call(at: number, ms: number, tool: BuildTool["tool"], subject: string, rest: Partial<BuildTool> = {}): BuildTool {
  return { at, ms, tool, subject, ...rest };
}

export const BUILD_TOOLS: readonly BuildTool[] = [
  // 1. the skeleton
  call(1_200, 700, "list_directory", "."),
  call(2_300, 600, "read_file", "package.json"),
  call(3_500, 900, "read_file", "src/main.ts"),
  call(5_000, 2_600, "bash", "npm install three vite", { note: "Install the renderer", output: "added 14 packages in 2s\n" }),
  call(8_100, 1_100, "write_file", "src/scene.ts"),
  call(9_800, 900, "write_file", "index.html"),
  call(11_300, 1_900, "bash", "npx vite build", { note: "Check the skeleton builds", output: "built in 412ms\n" }),
  // 2. stage 1
  call(14_000, 700, "read_file", "src/scene.ts"),
  call(15_300, 1_400, "write_file", "src/textures/noise.ts"),
  call(17_200, 1_000, "write_file", "src/textures/rock.ts"),
  call(18_600, 6_400, "bash", "node tools/bake-textures.mjs --size 1024", { note: "Bake the rock and grass textures", output: "baked 6 textures\n" }),
  call(19_200, 2_200, "write_file", "src/terrain/heightmap.ts"),
  call(21_800, 1_500, "write_file", "src/terrain/ridges.ts"),
  call(23_900, 1_000, "edit_file", "src/scene.ts"),
  call(25_700, 1_300, "write_file", "src/sky.ts"),
  call(27_500, 900, "edit_file", "src/scene.ts"),
  call(29_100, 1_700, "write_file", "src/camera.ts"),
  call(31_200, 900, "edit_file", "src/scene.ts"),
  call(32_800, 4_800, "bash", "npm run build", { note: "Compile the scene", fail: "src/terrain/ridges.ts(41,7): error TS2322: Type 'number' is not assignable to type 'Vector2'." }),
  call(38_100, 800, "read_file", "src/terrain/ridges.ts"),
  call(39_300, 1_200, "edit_file", "src/terrain/ridges.ts"),
  call(41_000, 4_200, "bash", "npm run build", { note: "Compile the scene", output: "built in 1.9s\n" }),
  call(46_200, 4_000, "bash", "npx playwright test tests/render.spec.ts", { note: "Render the first frame", output: "1 passed (3.2s)\n" }),
  // 3. stage 2
  call(51_200, 800, "grep", "WaterMaterial"),
  call(52_500, 1_600, "write_file", "src/water/surface.ts"),
  call(54_500, 1_100, "write_file", "src/water/shoreline.ts"),
  call(56_100, 1_300, "write_file", "src/atmosphere/fog.ts"),
  call(57_800, 900, "edit_file", "src/scene.ts"),
  call(59_300, 5_200, "bash", "node tools/bake-foam.mjs", { note: "Bake the foam mask", output: "foam mask 512x512\n" }),
  call(60_000, 1_800, "write_file", "src/water/reflections.ts"),
  call(62_000, 1_000, "edit_file", "src/water/surface.ts"),
  call(64_800, 4_400, "bash", "npm run build", { note: "Compile the scene", output: "built in 2.1s\n" }),
  call(69_600, 900, "read_file", "src/atmosphere/fog.ts"),
  call(70_900, 1_100, "edit_file", "src/atmosphere/fog.ts"),
  call(72_700, 4_100, "bash", "npx playwright test tests/water.spec.ts", { note: "Check the water renders", output: "2 passed (3.6s)\n" }),
  // 4. stage 3
  call(79_800, 900, "grep", "InstancedMesh"),
  call(81_300, 1_700, "write_file", "src/vegetation/trees.ts"),
  call(83_300, 1_200, "write_file", "src/vegetation/grass.ts"),
  call(85_700, 1_300, "write_file", "src/props/rocks.ts"),
  call(87_400, 900, "edit_file", "src/scene.ts"),
  call(88_900, 5_600, "bash", "node tools/scatter.mjs --seed 7", { note: "Scatter the vegetation", output: "scattered 4 812 instances\n" }),
  call(90_600, 1_400, "write_file", "src/vegetation/wind.ts"),
  call(92_500, 800, "edit_file", "src/vegetation/trees.ts"),
  call(95_000, 4_300, "bash", "npm run build", { note: "Compile the scene", output: "built in 2.4s\n" }),
  call(100_000, 4_400, "bash", "npx playwright test tests/vegetation.spec.ts", { note: "Check the vegetation renders", output: "3 passed (4.1s)\n" }),
  // 5. performance and tests
  call(106_000, 900, "read_file", "src/vegetation/grass.ts"),
  call(107_500, 1_000, "edit_file", "src/vegetation/grass.ts"),
  call(109_200, 6_800, "bash", "node tools/profile.mjs --frames 600", { note: "Profile 600 frames", output: "median 7.9ms, p95 11.2ms\n" }),
  call(116_500, 1_200, "edit_file", "src/scene.ts"),
  call(118_300, 5_200, "bash", "npx playwright test", { note: "Run every render test", output: "9 passed (4.9s)\n" }),
  // 6. the README
  call(124_800, 800, "read_file", "package.json"),
  call(126_200, 1_900, "write_file", "README.md"),
  call(128_400, 900, "edit_file", "README.md"),
  call(130_000, 3_200, "bash", "npm run build", { note: "Final build", output: "built in 2.0s\n" }),
];

export const BUILD_REPLY =
  "The terrain scene is built in six stages. Textures, terrain, sky, camera and light are in `src/`, water and atmosphere follow, then vegetation and props. The build is clean, nine render tests pass and the median frame takes 7.9 ms. The README says how to run it.";
