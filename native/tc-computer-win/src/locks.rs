//! The locks of docs/computer-protocol.md §1 and §16.1: one slot per app
//! (actions one at a time in arrival order, reads shared and waiting for a
//! running or queued action) and the two machine-wide file locks every
//! service of the signed-in user shares (`clipboard.lock`, `session.lock`).

use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Slot {
    readers: usize,
    acting: bool,
    /// actions waiting, in arrival order, by ticket
    waiting: VecDeque<u64>,
}

/// Every app's slot, by pid.
#[derive(Default)]
pub struct AppSlots {
    slots: Mutex<(u64, HashMap<i64, Slot>)>,
    changed: Condvar,
}

/// Held while an action runs; frees the slot when dropped.
pub struct ActGuard<'a> {
    slots: &'a AppSlots,
    pid: i64,
}

/// Held while a read runs.
pub struct ReadGuard<'a> {
    slots: &'a AppSlots,
    pid: i64,
}

impl AppSlots {
    /// The app's slot for an action, waiting at most `wait`; None means `app_busy`.
    pub fn act(&self, pid: i64, wait: Duration) -> Option<ActGuard<'_>> {
        let deadline = Instant::now() + wait;
        let mut g = self.slots.lock().unwrap();
        g.0 += 1;
        let ticket = g.0;
        g.1.entry(pid).or_default().waiting.push_back(ticket);
        loop {
            let slot = g.1.get_mut(&pid).unwrap();
            if !slot.acting && slot.readers == 0 && slot.waiting.front() == Some(&ticket) {
                slot.waiting.pop_front();
                slot.acting = true;
                return Some(ActGuard { slots: self, pid });
            }
            let now = Instant::now();
            if now >= deadline {
                slot.waiting.retain(|t| *t != ticket);
                drop(g);
                self.changed.notify_all();
                return None;
            }
            g = self.changed.wait_timeout(g, deadline - now).unwrap().0;
        }
    }

    /// The app's slot for a read: shared, after any running or queued action.
    pub fn read(&self, pid: i64) -> ReadGuard<'_> {
        let mut g = self.slots.lock().unwrap();
        loop {
            let slot = g.1.entry(pid).or_default();
            if !slot.acting && slot.waiting.is_empty() {
                slot.readers += 1;
                return ReadGuard { slots: self, pid };
            }
            g = self.changed.wait(g).unwrap();
        }
    }

    fn release(&self, pid: i64, action: bool) {
        let mut g = self.slots.lock().unwrap();
        if let Some(slot) = g.1.get_mut(&pid) {
            if action {
                slot.acting = false;
            } else {
                slot.readers -= 1;
            }
            if !slot.acting && slot.readers == 0 && slot.waiting.is_empty() {
                g.1.remove(&pid);
            }
        }
        drop(g);
        self.changed.notify_all();
    }
}

impl Drop for ActGuard<'_> {
    fn drop(&mut self) {
        self.slots.release(self.pid, true);
    }
}

impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        self.slots.release(self.pid, false);
    }
}

/// An exclusive lock on a file, held until dropped (the OS frees it when the process dies).
pub struct FileLock {
    _file: File,
}

/// Take the lock on `path`, trying every 10 ms for at most `wait`; None when another holder kept it.
pub fn lock_file(path: &Path, wait: Duration) -> std::io::Result<Option<FileLock>> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let deadline = Instant::now() + wait;
    loop {
        // a fresh handle per try: two sessions in one service exclude each other as two services do
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        match file.try_lock() {
            Ok(()) => return Ok(Some(FileLock { _file: file })),
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(e)) => return Err(e),
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// `<user temp>\tc-computer\<clipboard|session>.lock`.
pub fn machine_lock_path(user_temp: &Path, which: &str) -> PathBuf {
    use crate::generated::contract::locks;
    let file = if which == "clipboard" { locks::CLIPBOARD } else { locks::SESSION };
    user_temp.join(locks::DIR).join(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn actions_wait_their_turn_and_time_out_as_busy() {
        let slots = Arc::new(AppSlots::default());
        let a = slots.act(1, Duration::from_millis(10)).unwrap();
        assert!(slots.act(1, Duration::from_millis(30)).is_none(), "a second action on the app is busy");
        assert!(slots.act(2, Duration::from_millis(10)).is_some(), "another app is free");
        let s2 = slots.clone();
        let reader = std::thread::spawn(move || {
            let _r = s2.read(1);
            Instant::now()
        });
        std::thread::sleep(Duration::from_millis(40));
        let released = Instant::now();
        drop(a);
        assert!(reader.join().unwrap() >= released, "a read waits for the running action");
        let r1 = slots.read(1);
        let r2 = slots.read(1);
        assert!(slots.act(1, Duration::from_millis(20)).is_none(), "an action waits for reads");
        drop((r1, r2));
        assert!(slots.act(1, Duration::from_millis(20)).is_some());
    }

    #[test]
    fn a_file_lock_excludes_a_second_holder_until_dropped() {
        let dir = std::env::temp_dir().join(format!("tc-locks-{}", std::process::id()));
        let path = machine_lock_path(&dir, "session");
        assert!(path.ends_with("tc-computer/session.lock"));
        let held = lock_file(&path, Duration::ZERO).unwrap().unwrap();
        assert!(lock_file(&path, Duration::from_millis(30)).unwrap().is_none());
        drop(held);
        assert!(lock_file(&path, Duration::ZERO).unwrap().is_some());
        let _ = std::fs::remove_dir_all(dir);
    }
}
