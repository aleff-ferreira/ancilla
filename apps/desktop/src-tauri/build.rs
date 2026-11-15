//! Ancilla desktop application build script.
//! Compiles Tauri context, native icon assets, and platform capabilities.

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new()).expect("failed to compile Tauri build artifacts");
}
