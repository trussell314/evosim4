// Stamp a short git commit + build-time epoch into the binary for
// `ServerMessage::Hello`. Falls back to "unknown" so a tarball build
// without git history still compiles and reports something honest.

use std::process::Command;

fn main() {
    let commit = Command::new("git")
        .args(["rev-parse", "--short=10", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let built_at = chrono::Utc::now().timestamp();

    println!("cargo:rustc-env=EVOSIM_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=EVOSIM_BUILD_AT={built_at}");
    // Rebuild on HEAD change so the commit env stays accurate.
    println!("cargo:rerun-if-changed=../../../.git/HEAD");
    println!("cargo:rerun-if-changed=build.rs");
}
