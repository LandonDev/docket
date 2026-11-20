//! tc-computer on Windows (docs/computer-protocol.md §29): the computer-use
//! wire served over UI Automation. Everything but `platform::windows` is
//! platform-free and tested on the box with `cargo test`.

pub mod act;
pub mod book;
pub mod capture;
pub mod clip;
pub mod desktop;
pub mod door;
pub mod flow;
pub mod generated;
pub mod input;
pub mod locks;
pub mod platform;
pub mod server;
pub mod service;
pub mod stream;
pub mod text;
pub mod video;

pub use generated::{contract, wire};
