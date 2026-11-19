//! The real desktop: UI Automation and Win32 on Windows. Nothing else has one.

#[cfg(windows)]
pub mod io;
#[cfg(windows)]
pub mod windows;
