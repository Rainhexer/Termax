//! Process-spawning helpers shared by every module that shells out.

use std::process::Command;

/// `CREATE_NO_WINDOW` from `processthreadsapi.h`: the child gets no console.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Mark `cmd` as a background helper whose output we capture.
///
/// Termax is a GUI-subsystem executable, so it owns no console. On Windows a
/// console program (`git`, `gh`, `powershell`, `cmd`) spawned from such a
/// process is given a brand-new console window by default — the one that
/// flashes open and shut on every status poll (issue #57). `CREATE_NO_WINDOW`
/// suppresses it; stdio pipes and `.output()` are unaffected. No-op elsewhere:
/// Unix children never get a terminal they weren't handed.
///
/// Only for commands we read from. Anything that is *meant* to show a window
/// (`explorer`, `wt`, `cmd /C start cmd`) must not go through here.
pub(crate) fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The helper must hand back the same builder so it chains inline.
    #[test]
    fn hidden_returns_the_same_command() {
        let mut cmd = Command::new("git");
        cmd.arg("--version");
        let ptr = &cmd as *const Command;
        let out = hidden(&mut cmd) as *const Command;
        assert_eq!(ptr, out);
        assert_eq!(cmd.get_program(), "git");
        assert_eq!(cmd.get_args().count(), 1);
    }

    /// Suppressing the console must not cost us the child's stdout: that is
    /// the whole point of every `.output()` call routed through here.
    #[test]
    fn a_hidden_child_still_reports_its_output() {
        #[cfg(windows)]
        let mut cmd = Command::new("cmd");
        #[cfg(windows)]
        cmd.args(["/C", "echo hidden"]);
        #[cfg(not(windows))]
        let mut cmd = Command::new("sh");
        #[cfg(not(windows))]
        cmd.args(["-c", "echo hidden"]);

        let out = hidden(&mut cmd).output().expect("shell runs");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hidden");
    }
}
