//! Sessions and their element indices (docs/computer-protocol.md §4.2): per
//! session × app one counter, an element keeping its number while it lives,
//! a number never given twice, and the observation count (`seq`).

use std::collections::HashMap;

/// One app's indices in one session. `H` is the platform's element handle.
#[derive(Debug)]
pub struct AppBook<H> {
    next: i64,
    by_key: HashMap<Vec<i32>, i64>,
    handles: HashMap<i64, H>,
    /// the baseline count: +1 per full observation returned
    pub seq: i64,
    /// the last full text returned, for a step's effect
    pub last_text: Option<String>,
}

impl<H> Default for AppBook<H> {
    fn default() -> Self {
        AppBook { next: 1, by_key: HashMap::new(), handles: HashMap::new(), seq: 0, last_text: None }
    }
}

impl<H: Clone> AppBook<H> {
    /// The element's number, assigning the next unused one to an element not seen before.
    /// An element with no key (no RuntimeId) is new on every read, and so is one whose key another
    /// element of this read (`used`) already took: two UI Automation elements can share a RuntimeId,
    /// and an index appears once in a read and always names the element it was printed for.
    pub fn index_of(&mut self, key: &[i32], handle: H, used: &std::collections::HashSet<i64>) -> i64 {
        let found = if key.is_empty() { None } else { self.by_key.get(key).copied() };
        match found {
            Some(i) if !used.contains(&i) => {
                self.handles.insert(i, handle);
                i
            }
            Some(_) => self.fresh(handle),
            None => {
                let i = self.fresh(handle);
                if !key.is_empty() {
                    self.by_key.insert(key.to_vec(), i);
                }
                i
            }
        }
    }

    /// A number never given before.
    fn fresh(&mut self, handle: H) -> i64 {
        let i = self.next;
        self.next += 1;
        self.handles.insert(i, handle);
        i
    }

    /// The handle behind an index: `Err(true)` when it was given and is gone, `Err(false)` when never given.
    pub fn handle(&self, index: i64) -> Result<H, bool> {
        match self.handles.get(&index) {
            Some(h) => Ok(h.clone()),
            None => Err(index > 0 && index < self.next),
        }
    }

    /// Forget the handles of elements the last read did not see (they answer `stale_element` gone).
    pub fn keep_only(&mut self, seen: &[i64]) {
        self.handles.retain(|i, _| seen.contains(i));
    }
}

/// Every open session: its apps' books by pid.
#[derive(Debug)]
pub struct Sessions<H> {
    open: HashMap<String, HashMap<i64, AppBook<H>>>,
}

impl<H> Default for Sessions<H> {
    fn default() -> Self {
        Sessions { open: HashMap::new() }
    }
}

impl<H: Clone> Sessions<H> {
    /// Idempotent.
    pub fn open(&mut self, session: &str) {
        self.open.entry(session.to_string()).or_default();
    }

    pub fn close(&mut self, session: &str) {
        self.open.remove(session);
    }

    pub fn is_open(&self, session: &str) -> bool {
        self.open.contains_key(session)
    }

    /// The book of `pid` in `session`, made on first use; None when the session is not open.
    pub fn book(&mut self, session: &str, pid: i64) -> Option<&mut AppBook<H>> {
        self.open.get_mut(session).map(|apps| apps.entry(pid).or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_persist_and_are_never_reused() {
        let none = std::collections::HashSet::new();
        let mut b: AppBook<u8> = AppBook::default();
        assert_eq!(b.index_of(&[1, 2], 0, &none), 1);
        assert_eq!(b.index_of(&[3], 0, &none), 2);
        assert_eq!(b.index_of(&[1, 2], 0, &none), 1);
        assert_eq!(b.index_of(&[], 0, &none), 3);
        assert_eq!(b.index_of(&[], 0, &none), 4);
        b.keep_only(&[1]);
        assert_eq!(b.handle(2), Err(true));
        assert_eq!(b.handle(99), Err(false));
        assert_eq!(b.handle(1), Ok(0));
        assert_eq!(b.index_of(&[3], 0, &none), 2, "an element seen again keeps its number");
    }

    #[test]
    fn a_second_element_with_a_taken_key_gets_its_own_number_and_leaves_the_first_one_alone() {
        let mut b: AppBook<&str> = AppBook::default();
        let mut used = std::collections::HashSet::new();
        let a = b.index_of(&[7], "A", &used);
        used.insert(a);
        let second = b.index_of(&[7], "B", &used);
        assert_ne!(a, second);
        assert_eq!(b.handle(a), Ok("A"), "the first element's index still acts on it");
        assert_eq!(b.handle(second), Ok("B"));
        assert_eq!(b.index_of(&[7], "A", &std::collections::HashSet::new()), a, "the key keeps its first number");
    }

    #[test]
    fn a_closed_session_has_no_books() {
        let mut s: Sessions<u8> = Sessions::default();
        assert!(s.book("a", 1).is_none());
        s.open("a");
        s.open("a");
        assert!(s.book("a", 1).is_some());
        s.close("a");
        assert!(!s.is_open("a"));
    }
}
