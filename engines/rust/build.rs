//! Records the compiler version so benchmark results can report `runtimeVersion`.
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| String::from("rustc"));
    let output = Command::new(rustc).arg("--version").output();
    let mut version = String::new();
    if let Ok(out) = output {
        if let Ok(text) = String::from_utf8(out.stdout) {
            // "rustc 1.82.0 (f6e511eec 2024-10-15)" -> "1.82.0"
            if let Some(v) = text.split_whitespace().nth(1) {
                version = v.to_string();
            }
        }
    }
    if !version.is_empty() {
        println!("cargo:rustc-env=RUSTC_VERSION={}", version);
    }
}
